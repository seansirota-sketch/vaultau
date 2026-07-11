/* ============================================================
   SHARED UTILITIES  —  utils.js
   Loaded before admin.js and course.js in both HTML pages.
   ============================================================ */

function normalizeImageAlign(v) {
  return ['left', 'center', 'right'].includes(v) ? v : 'center';
}

/* ============================================================
   TOPIC CATEGORIZATION — shared helpers
   Hierarchical topics: a topic is assigned either to a whole
   question (inherited by all clauses) OR to individual clauses.
   Source of truth is the `topic_assignments` collection; these
   helpers resolve the *effective* topics for rendering.
   See docs/topic-categorization-plan.md.
   ============================================================ */

// Return the clause array for a question, tolerating both `subs` (canonical)
// and the legacy `parts` alias.
function getQuestionClauses(question) {
  if (!question) return [];
  if (Array.isArray(question.subs)) return question.subs;
  if (Array.isArray(question.parts)) return question.parts;
  return [];
}

// Deterministic document ids for topic_assignments (must match the reset
// function + admin write path). clauseId omitted / null ⇒ question-level.
function questionAssignmentId(examId, questionId) {
  return `${examId}__${questionId}`;
}
function clauseAssignmentId(examId, questionId, clauseId) {
  return `${examId}__${questionId}__${clauseId}`;
}

// Normalize whatever is stored (array, single string, or legacy `subject`)
// into a clean string array of topic ids.
function toTopicIdArray(value) {
  if (Array.isArray(value)) return value.filter(v => typeof v === 'string' && v.length);
  if (typeof value === 'string' && value.length) return [value];
  return [];
}

// Effective topics for a whole question (question with no clauses, or the
// question-level tag). Prefers the denormalized cache, then legacy `subject`.
function effectiveQuestionTopics(question) {
  const cached = toTopicIdArray(question && question.topicIds);
  if (cached.length) return cached;
  return toTopicIdArray(question && (question.subject || question.topic));
}

// Effective topics for a single clause, applying inheritance:
//   clause-level topic  →  else question-level topic  →  else []
// `clause` and its parent `question` are the raw embedded objects.
function effectiveClauseTopics(clause, question) {
  const clauseTopics = toTopicIdArray(clause && clause.topicIds);
  if (clauseTopics.length) return clauseTopics;
  const legacyClause = toTopicIdArray(clause && (clause.subject || clause.topic));
  if (legacyClause.length) return legacyClause;
  return effectiveQuestionTopics(question || {});
}

// Expose on window for non-module scripts (admin.js / course.js / tests).
if (typeof window !== 'undefined') {
  window.getQuestionClauses = getQuestionClauses;
  window.questionAssignmentId = questionAssignmentId;
  window.clauseAssignmentId = clauseAssignmentId;
  window.toTopicIdArray = toTopicIdArray;
  window.effectiveQuestionTopics = effectiveQuestionTopics;
  window.effectiveClauseTopics = effectiveClauseTopics;
}

// CommonJS export so unit tests can require() these helpers directly.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    getQuestionClauses,
    questionAssignmentId,
    clauseAssignmentId,
    toTopicIdArray,
    effectiveQuestionTopics,
    effectiveClauseTopics,
  };
}
