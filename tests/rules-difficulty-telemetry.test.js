/**
 * rules-difficulty-telemetry.test.js
 *
 * Security-rules unit tests for the difficulty-ledger, difficulty-aggregates,
 * telemetry_t1, and telemetry_t2 collections introduced by
 * docs/architecture-telemetry-difficulty-admin.md
 *
 * Runner: node's built-in `node:test`
 * Deps  : @firebase/rules-unit-testing  (must be installed at repo root)
 *
 * Prereq: the Firestore emulator running on port 8080
 *   npm run emulator          # starts firebase emulators (port 8080)
 *   node --test tests/rules-difficulty-telemetry.test.js
 *
 * Covered negative cases (all MUST be denied):
 *   T1-01  telemetry_t1 write containing a uid key
 *   T1-02  telemetry_t1 write missing sessionSalt
 *   T2-01  telemetry_t2 write without any consent state
 *   T2-02  telemetry_t2 write by a different uid than auth
 *   L-01   difficulty_ledger create with a docId that does not match uid
 *   L-02   difficulty_ledger create with rating out of range
 *   L-03   difficulty_ledger update by a different uid (vote forgery)
 *   AG-01  client direct write to difficulty_aggregates
 *   PS-01  client read of popularity_stats by non-admin
 *
 * Positive:
 *   T1-P1  telemetry_t1 create with sessionSalt + no identity fields → OK
 *   L-P1   difficulty_ledger create by owner with deterministic id + rating 4 → OK
 *   L-P2   difficulty_ledger self-update by owner with prevRating set → OK
 *   AG-R1  any logged-in user can read difficulty_aggregates
 */

'use strict';

const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const path = require('path');
const fs   = require('fs');

const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require('@firebase/rules-unit-testing');

const {
  collection, doc, setDoc, updateDoc, getDoc, serverTimestamp, Timestamp,
} = require('firebase/firestore');

const PROJECT_ID = 'vaultau-rules-test';
const RULES_PATH = path.join(__dirname, '..', 'firestore.rules');
const HOST = '127.0.0.1';
const PORT = 8080;

let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      host: HOST,
      port: PORT,
      rules: fs.readFileSync(RULES_PATH, 'utf8'),
    },
  });

  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users/alice'),       { uid: 'alice',       email: 'alice@x.y', role: 'student', analyticsConsent: false });
    await setDoc(doc(db, 'users/bob'),         { uid: 'bob',         email: 'bob@x.y',   role: 'student', analyticsConsent: true  });
    await setDoc(doc(db, 'users/carol-admin'), { uid: 'carol-admin', email: 'carol@x.y', role: 'admin' });
  });
});

after(async () => { if (env) await env.cleanup(); });

const aliceDb = () => env.authenticatedContext('alice').firestore();
const bobDb   = () => env.authenticatedContext('bob').firestore();
const adminDb = () => env.authenticatedContext('carol-admin').firestore();

const in90d = () => Timestamp.fromMillis(Date.now() + 90 * 86400000);

// ─────────────────────────────── Tier 1 ────────────────────────────────────

test('T1-01: telemetry_t1 write with uid key is denied', async () => {
  await assertFails(setDoc(doc(collection(aliceDb(), 'telemetry_t1')), {
    event: 'exam_open',
    uid:   'alice',
    sessionSalt: 'a'.repeat(32),
    timestamp: serverTimestamp(),
    payload: {},
    expiresAt: in90d(),
  }));
});

test('T1-02: telemetry_t1 write missing sessionSalt is denied', async () => {
  await assertFails(setDoc(doc(collection(aliceDb(), 'telemetry_t1')), {
    event: 'exam_open',
    timestamp: serverTimestamp(),
    payload: {},
    expiresAt: in90d(),
  }));
});

test('T1-P1: telemetry_t1 well-formed anonymous write succeeds', async () => {
  await assertSucceeds(setDoc(doc(collection(aliceDb(), 'telemetry_t1')), {
    event:       'exam_open',
    itemId:      'exam:e1',
    courseId:    'c1',
    sessionSalt: 'a'.repeat(32),
    timestamp:   serverTimestamp(),
    payload:     { examId: 'e1' },
    expiresAt:   in90d(),
  }));
});

// ─────────────────────────────── Tier 2 ────────────────────────────────────

test('T2-01: telemetry_t2 write without consent is denied', async () => {
  await assertFails(setDoc(doc(collection(aliceDb(), 'telemetry_t2')), {
    uid: 'alice',
    consentVersion: '2026-01',
    event: 'question_dwell',
    timestamp: serverTimestamp(),
    payload: {},
    expiresAt: in90d(),
  }));
});

test('T2-P1: telemetry_t2 write by consented user (fallback path) succeeds', async () => {
  await assertSucceeds(setDoc(doc(collection(bobDb(), 'telemetry_t2')), {
    uid: 'bob',
    consentVersion: '2026-01',
    event:  'question_dwell',
    itemId: 'q:e1:q1',
    courseId: 'c1',
    timestamp: serverTimestamp(),
    payload: { dwellMs: 4200 },
    expiresAt: in90d(),
  }));
});

test('T2-02: telemetry_t2 write by different uid than auth is denied', async () => {
  await assertFails(setDoc(doc(collection(bobDb(), 'telemetry_t2')), {
    uid: 'alice',
    consentVersion: '2026-01',
    event: 'question_dwell',
    timestamp: serverTimestamp(),
    payload: {},
    expiresAt: in90d(),
  }));
});

// ─────────────────────────── Difficulty ledger ─────────────────────────────

const ledgerBase = (uid) => ({
  itemId:     'q:e1:q1',
  itemType:   'question',
  examId:     'e1',
  questionId: 'q1',
  courseId:   'c1',
  uid,
  rating:     4,
  prevRating: null,
  createdAt:  serverTimestamp(),
  updatedAt:  serverTimestamp(),
  context:    { source: 'question_page' },
});

test('L-01: ledger create with mismatched docId is denied', async () => {
  await assertFails(setDoc(
    doc(aliceDb(), 'difficulty_ledger/q:e1:q1_bob'),
    ledgerBase('alice'),
  ));
});

test('L-02: ledger create with rating > 5 is denied', async () => {
  await assertFails(setDoc(
    doc(aliceDb(), 'difficulty_ledger/q:e1:q1_alice'),
    { ...ledgerBase('alice'), rating: 6 },
  ));
});

test('L-P1: ledger create by owner with valid deterministic id succeeds', async () => {
  await assertSucceeds(setDoc(
    doc(aliceDb(), 'difficulty_ledger/q:e1:q1_alice'),
    ledgerBase('alice'),
  ));
});

test('L-P2: ledger self-update by owner with prevRating succeeds', async () => {
  await assertSucceeds(updateDoc(
    doc(aliceDb(), 'difficulty_ledger/q:e1:q1_alice'),
    { rating: 2, prevRating: 4, updatedAt: serverTimestamp() },
  ));
});

test('L-03: ledger update by a different user is denied (vote forgery)', async () => {
  await assertFails(updateDoc(
    doc(bobDb(), 'difficulty_ledger/q:e1:q1_alice'),
    { rating: 1, prevRating: 2, updatedAt: serverTimestamp() },
  ));
});

// ─────────────────────── Aggregates & admin views ──────────────────────────

test('AG-01: client direct write to difficulty_aggregates is denied', async () => {
  await assertFails(setDoc(
    doc(aliceDb(), 'difficulty_aggregates/q:e1:q1'),
    { voteCount: 9999, average: 5.0 },
  ));
});

test('AG-R1: logged-in user can read difficulty_aggregates', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(
      doc(ctx.firestore(), 'difficulty_aggregates/q:e1:q1'),
      { voteCount: 3, average: 3.33, bayesianAverage: 3.25 },
    );
  });
  await assertSucceeds(getDoc(doc(aliceDb(), 'difficulty_aggregates/q:e1:q1')));
});

test('PS-01: non-admin cannot read popularity_stats; admin can', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(
      doc(ctx.firestore(), 'popularity_stats/q:e1:q1'),
      { views7d: 10, popularityScore: 1.2 },
    );
  });
  await assertFails(getDoc(doc(aliceDb(), 'popularity_stats/q:e1:q1')));
  await assertSucceeds(getDoc(doc(adminDb(), 'popularity_stats/q:e1:q1')));
});
