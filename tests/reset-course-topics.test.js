/**
 * reset-course-topics.test.js
 *
 * Pure unit tests for the reset helper that strips embedded topic assignment
 * fields from exam questions and clauses.
 *
 * Runner: node --test tests/reset-course-topics.test.js
 */

'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { stripAssignmentFields } = require('../netlify/functions/reset-course-topics.js');

test('stripAssignmentFields removes all embedded assignment fields', () => {
  const original = {
    id: 'q1',
    text: 'Question text',
    topicIds: ['limits'],
    subject: 'Limits',
    topic: 'legacy-topic',
    points: 10,
  };

  const stripped = stripAssignmentFields(original);

  assert.deepEqual(stripped, {
    id: 'q1',
    text: 'Question text',
    points: 10,
  });
  assert.deepEqual(original, {
    id: 'q1',
    text: 'Question text',
    topicIds: ['limits'],
    subject: 'Limits',
    topic: 'legacy-topic',
    points: 10,
  });
});

test('stripAssignmentFields leaves unrelated values unchanged', () => {
  assert.equal(stripAssignmentFields(null), null);
  assert.equal(stripAssignmentFields('x'), 'x');
  assert.deepEqual(stripAssignmentFields({ id: 'q2', text: 'ok' }), { id: 'q2', text: 'ok' });
});
