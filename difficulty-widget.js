/*!
 * difficulty-widget.js — VaultAU crowdsourced difficulty widget
 *
 * Design: docs/architecture-telemetry-difficulty-admin.md §5
 *
 * Two orthogonal state machines per item:
 *   Visibility (VM) : IS_HIDDEN → LOADING_AGG → IS_REVEALED / AGG_UNAVAILABLE
 *   Voting     (VOM): VOTE_IDLE → VOTE_SELECTED → SUBMITTING_VOTE
 *                      → VOTE_ACKNOWLEDGED / VOTE_ERROR
 *
 * Rules enforced:
 *   A. Default hidden on mount — aggregate is NOT fetched.
 *   B. Reveal is a pure read; NEVER prompts a vote.
 *   C. Voting works in any visibility state; the aggregate is only ever
 *      updated by the server (client shows the pushed snapshot).
 *
 * This module is UI-framework-agnostic: it exports a factory
 * createDifficultyWidget(...) that returns { getState, subscribe, reveal,
 * hide, selectRating, submitRating, destroy }.
 * The host page renders the DOM and reads state via subscribe().
 *
 * Depends on the compat Firebase globals used across this repo
 * (window.firebase, window.db, window.auth).
 */

'use strict';

const VM = Object.freeze({
  IS_HIDDEN:        'IS_HIDDEN',
  LOADING_AGG:      'LOADING_AGG',
  IS_REVEALED:      'IS_REVEALED',
  AGG_UNAVAILABLE:  'AGG_UNAVAILABLE',
});

const VOM = Object.freeze({
  VOTE_IDLE:          'VOTE_IDLE',
  VOTE_SELECTED:      'VOTE_SELECTED',
  SUBMITTING_VOTE:    'SUBMITTING_VOTE',
  VOTE_ACKNOWLEDGED:  'VOTE_ACKNOWLEDGED',
  VOTE_ERROR:         'VOTE_ERROR',
});

export const DifficultyStates = { VM, VOM };

/**
 * @param {object} opts
 * @param {'exam'|'question'} opts.itemType
 * @param {string} opts.examId
 * @param {string} [opts.questionId]   required if itemType === 'question'
 * @param {string} opts.courseId
 * @param {object} [opts.deps]         { db, auth, firebase } — defaults to window.*
 */
export function createDifficultyWidget(opts) {
  const { itemType, examId, questionId, courseId, deps = {} } = opts;
  const db       = deps.db       || (typeof window !== 'undefined' ? window.db       : null);
  const auth     = deps.auth     || (typeof window !== 'undefined' ? window.auth     : null);
  const firebase = deps.firebase || (typeof window !== 'undefined' ? window.firebase : null);
  if (!db || !auth || !firebase) throw new Error('difficulty-widget: missing firebase deps');

  const itemId = itemType === 'exam'
    ? `exam:${examId}`
    : `q:${examId}:${questionId}`;

  // Sole source of truth for the widget.
  const state = {
    vm:               VM.IS_HIDDEN,     // Rule A
    vom:              VOM.VOTE_IDLE,
    itemId,
    itemType,
    examId,
    questionId: questionId || null,
    courseId,
    aggregate:        null,             // { voteCount, average, bayesianAverage, histogram }
    myRating:         null,             // last rating this user submitted, if any
    selectedRating:   null,             // in-progress selection
    error:            null,
  };

  const listeners = new Set();
  let aggUnsub = null;

  function emit() { listeners.forEach((fn) => { try { fn(getState()); } catch (_) { /* ignore */ } }); }
  function getState() { return Object.assign({}, state, { aggregate: state.aggregate ? Object.assign({}, state.aggregate) : null }); }
  function subscribe(fn) { listeners.add(fn); fn(getState()); return () => listeners.delete(fn); }

  // ── Prefetch: own vote (never the aggregate — Rule A) ────────────────
  async function _loadMyRating() {
    if (!auth.currentUser) return;
    const docId = `${itemId}_${auth.currentUser.uid}`;
    try {
      const snap = await db.collection('difficulty_ledger').doc(docId).get();
      if (snap.exists) {
        state.myRating = snap.data().rating;
        state.selectedRating = state.myRating;
        state.vom = VOM.VOTE_ACKNOWLEDGED;
        emit();
      }
    } catch (_) { /* rules deny? treat as no prior vote */ }
  }
  _loadMyRating();

  // ── Visibility machine transitions ──────────────────────────────────
  function reveal() {
    if (state.vm === VM.IS_REVEALED || state.vm === VM.LOADING_AGG) return;
    state.vm = VM.LOADING_AGG;
    state.error = null;
    emit();

    // Snapshot listener so new votes stream in live while revealed.
    aggUnsub = db.collection('difficulty_aggregates').doc(itemId).onSnapshot(
      (snap) => {
        if (!snap.exists) {
          state.vm = VM.AGG_UNAVAILABLE;
          state.aggregate = null;
          emit();
          return;
        }
        const a = snap.data();
        const minVotes = a.minVotesForDisplay || 3;
        state.aggregate = {
          voteCount:       a.voteCount || 0,
          average:         a.average || 0,
          bayesianAverage: a.bayesianAverage || 0,
          histogram:       a.histogram || {},
          minVotesForDisplay: minVotes,
        };
        state.vm = (a.voteCount || 0) < minVotes
          ? VM.AGG_UNAVAILABLE
          : VM.IS_REVEALED;
        emit();
      },
      (err) => {
        state.vm = VM.AGG_UNAVAILABLE;
        state.error = (err && err.code) || 'aggregate_fetch_failed';
        emit();
      },
    );
  }

  function hide() {
    if (aggUnsub) { try { aggUnsub(); } catch (_) { /* ignore */ } aggUnsub = null; }
    state.vm = VM.IS_HIDDEN;
    // keep state.aggregate cached so a re-reveal is instant, but the
    // listener is detached to control read costs.
    emit();
  }

  // ── Voting machine transitions ──────────────────────────────────────
  function selectRating(rating) {
    const r = Number(rating);
    if (!Number.isInteger(r) || r < 1 || r > 5) return;
    state.selectedRating = r;
    // Never prompt / reveal because of a selection (Rule C independence).
    state.vom = VOM.VOTE_SELECTED;
    emit();
  }

  async function submitRating() {
    if (!auth.currentUser) { state.vom = VOM.VOTE_ERROR; state.error = 'not_authenticated'; emit(); return; }
    const r = state.selectedRating;
    if (!Number.isInteger(r) || r < 1 || r > 5) return;
    state.vom = VOM.SUBMITTING_VOTE;
    state.error = null;
    emit();

    const uid = auth.currentUser.uid;
    const docId = `${itemId}_${uid}`;
    const ref = db.collection('difficulty_ledger').doc(docId);
    const serverTs = firebase.firestore.FieldValue.serverTimestamp();

    try {
      // Read-modify-write via transaction so prevRating is always correct
      // and we don't clobber a concurrent re-vote.
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (snap.exists) {
          const prev = snap.data();
          tx.update(ref, {
            rating:     r,
            prevRating: prev.rating,
            updatedAt:  serverTs,
          });
        } else {
          tx.set(ref, {
            itemId,
            itemType,
            examId,
            questionId: questionId || null,
            courseId,
            uid,
            rating:     r,
            prevRating: null,
            createdAt:  serverTs,
            updatedAt:  serverTs,
            context:    { source: itemType === 'exam' ? 'exam_page' : 'question_page' },
          });
        }
      });
      state.myRating = r;
      state.vom = VOM.VOTE_ACKNOWLEDGED;
      // NOTE: we do NOT locally mutate state.aggregate. If the widget is
      // IS_REVEALED, the aggregate snapshot listener will push the new
      // value once the on-ledger-write function has committed the delta.
      emit();
    } catch (err) {
      state.vom = VOM.VOTE_ERROR;
      state.error = (err && err.code) || 'submit_failed';
      emit();
    }
  }

  function destroy() {
    if (aggUnsub) { try { aggUnsub(); } catch (_) { /* ignore */ } aggUnsub = null; }
    listeners.clear();
  }

  return { getState, subscribe, reveal, hide, selectRating, submitRating, destroy, itemId };
}
