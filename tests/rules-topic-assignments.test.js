/**
 * rules-topic-assignments.test.js
 *
 * Security-rules unit tests for the hierarchical topic categorization
 * collections introduced by docs/topic-categorization-plan.md:
 *   - topic_assignments/{id}
 *   - courses/{courseId}/topics/{topicId}
 *
 * Runner: node's built-in `node:test`
 * Deps  : @firebase/rules-unit-testing
 *
 * Prereq: the Firestore emulator running on port 8080
 *   npm run emulator
 *   node --test tests/rules-topic-assignments.test.js
 *
 * Denied (all MUST fail):
 *   TA-01  student writes a topic_assignment
 *   TA-02  student writes a course topic
 *   TA-03  anonymous reads a topic_assignment
 * Allowed:
 *   TA-P1  admin writes a question-level topic_assignment
 *   TA-P2  admin writes a course topic
 *   TA-P3  logged-in student reads a topic_assignment
 *   TA-P4  logged-in student reads a course topic
 */

'use strict';

const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const path = require('path');
const fs = require('fs');

const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require('@firebase/rules-unit-testing');

const {
  doc, setDoc, getDoc, serverTimestamp,
} = require('firebase/firestore');

const PROJECT_ID = 'vaultau-rules-test-topics';
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
    await setDoc(doc(db, 'users/alice'),       { uid: 'alice',       email: 'alice@x.y', role: 'student' });
    await setDoc(doc(db, 'users/carol-admin'), { uid: 'carol-admin', email: 'carol@x.y', role: 'admin' });
    // Seed a course + an assignment for read tests.
    await setDoc(doc(db, 'courses/calc'), { name: 'Calc' });
    await setDoc(doc(db, 'courses/calc/topics/derivatives'), { name: 'נגזרות', order: 10, status: 'active' });
    await setDoc(doc(db, 'topic_assignments/calc-2023-a-a__q1'), {
      courseId: 'calc', examId: 'calc-2023-a-a', questionId: 'q1', clauseId: null,
      scope: 'question', topicIds: ['derivatives'], source: 'ai',
    });
  });
});

after(async () => { if (env) await env.cleanup(); });

const aliceDb = () => env.authenticatedContext('alice').firestore();
const adminDb = () => env.authenticatedContext('carol-admin').firestore();
const anonDb  = () => env.unauthenticatedContext().firestore();

// ─────────────────────────────── Denied ────────────────────────────────────

test('TA-01: student writing a topic_assignment is denied', async () => {
  await assertFails(setDoc(doc(aliceDb(), 'topic_assignments/calc-2023-a-a__q2'), {
    courseId: 'calc', examId: 'calc-2023-a-a', questionId: 'q2', clauseId: null,
    scope: 'question', topicIds: ['derivatives'], source: 'manual',
  }));
});

test('TA-02: student writing a course topic is denied', async () => {
  await assertFails(setDoc(doc(aliceDb(), 'courses/calc/topics/hacktopic'), {
    name: 'hacked', order: 1, status: 'active',
  }));
});

test('TA-03: anonymous read of a topic_assignment is denied', async () => {
  await assertFails(getDoc(doc(anonDb(), 'topic_assignments/calc-2023-a-a__q1')));
});

// ─────────────────────────────── Allowed ───────────────────────────────────

test('TA-P1: admin writes a question-level topic_assignment', async () => {
  await assertSucceeds(setDoc(doc(adminDb(), 'topic_assignments/calc-2023-a-a__q3'), {
    courseId: 'calc', examId: 'calc-2023-a-a', questionId: 'q3', clauseId: null,
    scope: 'question', topicIds: ['derivatives'], source: 'ai',
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  }));
});

test('TA-P2: admin writes a course topic', async () => {
  await assertSucceeds(setDoc(doc(adminDb(), 'courses/calc/topics/integrals'), {
    name: 'אינטגרלים', order: 20, status: 'active',
  }));
});

test('TA-P3: logged-in student reads a topic_assignment', async () => {
  await assertSucceeds(getDoc(doc(aliceDb(), 'topic_assignments/calc-2023-a-a__q1')));
});

test('TA-P4: logged-in student reads a course topic', async () => {
  await assertSucceeds(getDoc(doc(aliceDb(), 'courses/calc/topics/derivatives')));
});
