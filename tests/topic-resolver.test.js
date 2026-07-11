/**
 * topic-resolver.test.js
 *
 * Pure unit tests for the topic helpers in utils.js (no emulator needed):
 *   - effectiveQuestionTopics / effectiveClauseTopics inheritance
 *   - deterministic assignment doc ids
 *
 * Runner: node --test tests/topic-resolver.test.js
 */

'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  getQuestionClauses,
  questionAssignmentId,
  clauseAssignmentId,
  toTopicIdArray,
  effectiveQuestionTopics,
  effectiveClauseTopics,
} = require('../utils.js');

test('deterministic assignment ids', () => {
  assert.equal(questionAssignmentId('e1', 'q1'), 'e1__q1');
  assert.equal(clauseAssignmentId('e1', 'q1', 'q1a'), 'e1__q1__q1a');
});

test('getQuestionClauses tolerates subs and parts', () => {
  assert.deepEqual(getQuestionClauses({ subs: [{ id: 'a' }] }), [{ id: 'a' }]);
  assert.deepEqual(getQuestionClauses({ parts: [{ id: 'b' }] }), [{ id: 'b' }]);
  assert.deepEqual(getQuestionClauses({}), []);
});

test('toTopicIdArray normalizes shapes', () => {
  assert.deepEqual(toTopicIdArray(['x', 'y']), ['x', 'y']);
  assert.deepEqual(toTopicIdArray('x'), ['x']);
  assert.deepEqual(toTopicIdArray(''), []);
  assert.deepEqual(toTopicIdArray(null), []);
});

test('clause inherits question-level topic when it has none (dependent case)', () => {
  const q = { id: 'q1', topicIds: ['linked-lists'], subs: [{ id: 'q1a' }, { id: 'q1b' }] };
  assert.deepEqual(effectiveClauseTopics(q.subs[0], q), ['linked-lists']);
  assert.deepEqual(effectiveClauseTopics(q.subs[1], q), ['linked-lists']);
});

test('clause-level topic overrides question inheritance (independent case)', () => {
  const q = { id: 'q1', subs: [{ id: 'q1a', topicIds: ['poly-deriv'] }, { id: 'q1b', topicIds: ['chain-product'] }] };
  assert.deepEqual(effectiveClauseTopics(q.subs[0], q), ['poly-deriv']);
  assert.deepEqual(effectiveClauseTopics(q.subs[1], q), ['chain-product']);
});

test('falls back to legacy subject when no topicIds cache', () => {
  const q = { id: 'q3', subject: 'קיצון', subs: [] };
  assert.deepEqual(effectiveQuestionTopics(q), ['קיצון']);
  const clause = { id: 'q3a', subject: 'אינטגרל טריגונומטרי' };
  assert.deepEqual(effectiveClauseTopics(clause, q), ['אינטגרל טריגונומטרי']);
});

test('uncategorized question resolves to empty', () => {
  assert.deepEqual(effectiveQuestionTopics({ id: 'x' }), []);
});
