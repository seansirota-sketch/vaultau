'use strict';

/**
 * on-ledger-write — Cloud Function (gen2, Node 20)
 *
 * Trigger : Firestore onWrite  difficulty_ledger/{docId}
 * Writes  : Firestore  difficulty_aggregates/{itemId}   (transactional delta)
 *
 * Design: docs/architecture-telemetry-difficulty-admin.md §3.1
 *
 * Delta rules:
 *   create  : voteCount +1, ratingSum += rating, histogram[rating] +1
 *   update  : ratingSum += (rating - prevRating), histogram[prevRating] -1, histogram[rating] +1
 *   delete  : voteCount -1, ratingSum -= rating, histogram[rating] -1
 *
 * Idempotency: at-least-once delivery is possible. The event ID from Cloud
 * Functions is stored inside the aggregate doc under lastLedgerEventIds
 * (rolling ring of the last 50 IDs). If we see one again → skip.
 *
 * Bayesian mean (damps low-N noise):
 *   bayesianAverage = (C * m + ratingSum) / (C + voteCount)
 *     C = 10   (confidence prior)
 *     m = 3.0  (global neutral rating)
 */

const functions = require('firebase-functions/v2/firestore');
const admin     = require('firebase-admin');

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const BAYES_C = 10;
const BAYES_M = 3.0;
const RECENT_EVENT_RING = 50;

exports.onLedgerWrite = functions.onDocumentWritten(
  'difficulty_ledger/{docId}',
  async (event) => {
    const eventId = event.id; // unique per delivery attempt

    const before = event.data && event.data.before ? event.data.before.data() : null;
    const after  = event.data && event.data.after  ? event.data.after.data()  : null;

    const itemId = (after && after.itemId) || (before && before.itemId);
    if (!itemId) {
      console.warn('onLedgerWrite: missing itemId, skipping', event.params.docId);
      return;
    }

    let deltaCount = 0;
    let deltaSum   = 0;
    const histDelta = {};

    const bumpHist = (rating, by) => {
      const key = String(rating);
      histDelta[key] = (histDelta[key] || 0) + by;
    };

    if (!before && after) {
      deltaCount = 1;
      deltaSum   = Number(after.rating) || 0;
      bumpHist(after.rating, +1);
    } else if (before && after) {
      const prev = Number(before.rating) || 0;
      const curr = Number(after.rating)  || 0;
      if (prev === curr) return;
      deltaSum = curr - prev;
      bumpHist(prev, -1);
      bumpHist(curr, +1);
    } else if (before && !after) {
      deltaCount = -1;
      deltaSum   = -(Number(before.rating) || 0);
      bumpHist(before.rating, -1);
    } else {
      return;
    }

    const source = after || before;
    const meta = {
      itemId,
      itemType:   source.itemType   || null,
      examId:     source.examId     || null,
      questionId: source.questionId || null,
      courseId:   source.courseId   || null,
    };

    const aggRef = db.collection('difficulty_aggregates').doc(itemId);

    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(aggRef);
        const cur  = snap.exists ? snap.data() : null;

        const seen = (cur && Array.isArray(cur.lastLedgerEventIds)) ? cur.lastLedgerEventIds : [];
        if (seen.includes(eventId)) {
          console.log('onLedgerWrite: duplicate delivery, skipping', eventId);
          return;
        }

        const nextCount = Math.max(0, (cur && cur.voteCount ? cur.voteCount : 0) + deltaCount);
        const nextSum   = Math.max(0, (cur && cur.ratingSum ? cur.ratingSum : 0) + deltaSum);

        const nextHist = Object.assign(
          { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },
          (cur && cur.histogram) || {},
        );
        for (const k of Object.keys(histDelta)) {
          nextHist[k] = Math.max(0, (nextHist[k] || 0) + histDelta[k]);
        }

        const average         = nextCount > 0 ? Math.round((nextSum / nextCount) * 100) / 100 : 0;
        const bayesianAverage = Math.round(
          ((BAYES_C * BAYES_M + nextSum) / (BAYES_C + nextCount)) * 100,
        ) / 100;

        const nextRing = seen.concat([eventId]).slice(-RECENT_EVENT_RING);

        tx.set(
          aggRef,
          {
            ...meta,
            voteCount:         nextCount,
            ratingSum:         nextSum,
            average,
            bayesianAverage,
            histogram:         nextHist,
            minVotesForDisplay: 3,
            updatedAt:         admin.firestore.FieldValue.serverTimestamp(),
            lastLedgerEventIds: nextRing,
          },
          { merge: true },
        );
      });
    } catch (err) {
      console.error('onLedgerWrite: transaction failed for', itemId, err);
      throw err;
    }
  },
);
