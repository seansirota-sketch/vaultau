# Vaultau — Hierarchical Topic Categorization: Implementation Plan

**Audience:** implementing agent. This plan is grounded in the existing codebase (Firestore NoSQL, vanilla JS frontend, Netlify edge functions for Claude/Gemini proxying, Firebase Cloud Functions for triggers).

---

## 0. Context & Constraints (existing system facts)

- DB: **Firebase Firestore** (document-based, no ORM). Recommendation: **stay NoSQL** — do NOT introduce SQL. The data is read-heavy, course-scoped, and already denormalized.
- Questions are **embedded** inside `exams/{examId}.questions[]`. Each question has `id`, `text`, `subject` (free-text string), and `parts[]` (clauses/סעיפים) each with `id`, `label`, `text`, `subject`.
- Existing AI proxy pattern: Netlify **edge functions** (`/api/parse-exam`, `/api/generate-question`) with Firebase ID-token auth, Claude forced-tool-use, retry/fallback chains, usage logging in `generate_usage`, quotas in `user_quotas`.
- Security: `firestore.rules` gate everything; admin role stored on `users/{uid}.role`.
- Naming conventions: collections `snake_case`, fields `camelCase`, IDs kebab/alphanumeric.

**Problem with the status quo:** `subject` is a free-text string duplicated per question and per part — no canonical topic list per course, no way to distinguish "question-level topic (inherited by all clauses)" from "clause-level topics", and no way to reset a course's taxonomy safely.

---

## 1. Data Model (Firestore)

### 1.1 `courses/{courseId}/topics/{topicId}` — canonical topic list (subcollection)

```javascript
{
  id: 'derivatives',            // slug, doc ID
  name: 'נגזרות',               // display name (Hebrew)
  description: '',              // optional, helps the LLM disambiguate
  order: 10,                    // display ordering
  status: 'active',             // 'active' | 'archived'
  createdAt, updatedAt, createdBy
}
```

Why a subcollection: topics are strictly course-scoped, reset = delete the subcollection, and rules inherit the course path naturally.

### 1.2 `topic_assignments/{assignmentId}` — top-level collection (the core)

**One document per assignment target** (question OR clause). Deterministic doc ID prevents duplicates:

- Question-level: `{examId}__{questionId}` → e.g. `calc-2023-a-a__q1`
- Clause-level: `{examId}__{questionId}__{clauseId}` → e.g. `calc-2023-a-a__q1__q1a`

```javascript
{
  courseId: 'calculus',            // REQUIRED — enables course-wide reset & queries
  examId: 'calc-2023-a-a',
  questionId: 'q1',
  clauseId: 'q1a' | null,          // null ⇒ question-level assignment
  scope: 'question' | 'clause',    // redundant with clauseId but makes queries/rules simple
  topicIds: ['derivatives'],       // array — supports multi-topic; usually length 1
  source: 'ai' | 'manual',         // who assigned it
  aiMeta: {                        // present when source === 'ai'
    relatedness: 'dependent' | 'independent',  // the AI's clause-relatedness verdict for the question
    confidence: 0.0–1.0,
    model: 'claude-sonnet-4-6',
    runId: 'categorize-<timestamp>'  // groups one categorization batch
  },
  createdAt, updatedAt, updatedBy
}
```

**Integrity invariant (the "either/or" rule):** for a given `(examId, questionId)`, EITHER one question-level doc exists (`clauseId == null`) OR one-or-more clause-level docs exist — **never both**. Enforcement is application-level (Firestore can't enforce cross-doc constraints):
- The write path (edge function / admin UI) always deletes the opposing scope in the **same batched write** when switching scope (see §1.5).
- Deterministic IDs make this cheap: switching q1 to question-level = batch { set `..__q1`, delete `..__q1__q1a`, delete `..__q1__q1b`, … } where clause IDs come from the exam doc's `parts[]`.

**Effective-topic resolution (read logic, in `utils.js`):**
```
effectiveTopics(clause) = clauseAssignment?.topicIds
                        ?? questionAssignment?.topicIds
                        ?? []          // uncategorized
effectiveTopics(question with no parts) = questionAssignment?.topicIds ?? []
```
This gives inheritance (Case 2) for free with zero redundancy: dependent clauses have NO clause docs, only the parent's.

### 1.3 Denormalized read cache on the exam doc (optional but recommended)

To avoid N reads when rendering an exam page, mirror resolved topics back into the embedded questions on write:

```javascript
// exams/{examId}.questions[i]
{ ..., topicIds: ['derivatives'],          // question-level (or null)
  parts: [{ ..., topicIds: ['poly-deriv'] }] }  // clause-level (or absent ⇒ inherit)
```

- **Source of truth is `topic_assignments`**; exam-doc fields are a cache updated in the same write batch (or by a Cloud Function trigger `onDocumentWritten('topic_assignments/{id}')` — prefer same-batch for simplicity since writes go through server functions anyway).
- Keep the legacy `subject` string fields untouched during migration (§5); UI switches to `topicIds` + a topic-name lookup.

### 1.4 Required composite indexes (`firestore.indexes.json`)

```
topic_assignments: (courseId ASC, updatedAt DESC)
topic_assignments: (courseId ASC, topicIds ARRAY_CONTAINS)   // "all questions in topic X"
topic_assignments: (examId ASC, questionId ASC)
```

### 1.5 Firestore rules (`firestore.rules`)

```
match /topic_assignments/{id} {
  allow read: if signedIn();                       // students read topics
  allow write: if isAdmin() || isInstructorOfCourse(resource/request);  // reuse existing role helpers
}
match /courses/{courseId}/topics/{topicId} {
  allow read: if true;                             // or signedIn(), match courses read policy
  allow write: if isAdmin();
}
```
(Adapt helper names to the actual functions already defined in `firestore.rules`.)

---

## 2. "Smart" Categorization Pipeline (LLM)

### 2.1 New edge function: `POST /api/categorize-question`

Clone the structure of `netlify/edge-functions/parse-exam.js` (auth via Firebase ID token, admin/instructor only, Claude with **forced tool use**, retry chain claude-sonnet → claude-haiku, log to `generate_usage`).

**Request body:**
```json
{
  "courseId": "calculus",
  "examId": "calc-2023-a-a",
  "questionIds": ["q1", "q2"]      // omit ⇒ whole exam
}
```
The function reads the exam doc + the course's `topics` subcollection server-side (never trust client-provided text) and processes questions **one at a time** (a question + all its clauses is one LLM call — the relatedness judgment needs the full local context, but cross-question context adds nothing).

### 2.2 The LLM tool schema (forced tool_choice)

```json
{
  "name": "categorize_question",
  "input_schema": {
    "type": "object",
    "required": ["relatedness", "reasoning", "assignment"],
    "properties": {
      "relatedness": { "enum": ["dependent", "independent", "single"] },
      "reasoning": { "type": "string", "maxLength": 300 },
      "confidence": { "type": "number" },
      "assignment": {
        "oneOf": [
          { "type": "object", "properties": {
              "scope": { "const": "question" },
              "topicIds": { "type": "array", "items": { "type": "string" } } } },
          { "type": "object", "properties": {
              "scope": { "const": "clause" },
              "perClause": { "type": "array", "items": { "type": "object",
                  "properties": { "clauseId": {"type":"string"},
                                  "topicIds": {"type":"array","items":{"type":"string"}} } } } } }
        ]
      }
    }
  }
}
```

### 2.3 Prompt design (system prompt, Hebrew-aware)

Give Claude: (a) the course topic list as `id: name — description` lines, (b) the question stem + every clause with its label, (c) this decision rubric:

```
You are categorizing an academic exam question into course topics.

DECISION RUBRIC — clause relatedness:
1. "single"      — the question has no clauses, or one clause. Assign at question level.
2. "dependent"   — clauses share a common setup/scenario, reference each other
                   ("using your answer from part א…"), or all exercise the SAME topic.
                   ⇒ scope = "question": assign ONE topic set to the whole question.
3. "independent" — clauses are self-contained mini-questions on DIFFERENT topics
                   (e.g., "differentiate the following functions" where each part
                   needs a different technique/topic).
                   ⇒ scope = "clause": assign topics per clause.

TIE-BREAKERS:
- If clauses share a scenario but test different topics, prefer "independent"
  (per-clause) ONLY if a later clause can be understood without earlier ones;
  otherwise "dependent".
- If ≥80% of clauses map to the same single topic, prefer "dependent" with that topic.
- You MUST only use topicIds from the provided list. If nothing fits well,
  use the closest topic and lower your confidence.
- Question stem text that carries the topic (e.g., "compute the derivative of:")
  applies to all clauses — weigh it in the dependent/independent decision.
```

### 2.4 Post-processing & write (server-side, in the edge function)

1. **Validate**: every returned `topicId` exists in the course topic list; every `clauseId` exists in `parts[]`; scope=clause covers all clauses (fill uncovered clauses by falling back to the modal topic or flagging).
2. **Confidence gate**: if `confidence < 0.55` → write assignment with `aiMeta.confidence` but also add doc to a lightweight review queue (reuse `reports`-style pattern or a `needsReview: true` flag queryable by admin UI). Do NOT block the write — admins curate later.
3. **Atomic batch write** honoring the either/or invariant (§1.2): set new docs + delete opposing-scope docs + update the exam-doc cache (§1.3) in one `WriteBatch`.
4. **Idempotency**: `source: 'manual'` assignments are never overwritten by AI runs (skip questions that have any manual assignment unless request passes `overrideManual: true`).

### 2.5 Batch/course-wide runs

Admin UI button "Categorize course": client iterates exams of the course and calls the endpoint per exam (matches existing parse-exam UX in `admin.js`); show progress + per-question relatedness verdicts with an inline override control (dropdown: question-level topic vs per-clause topics). Manual override writes `source: 'manual'`.

---

## 3. Course Reset Functionality

### 3.1 Endpoint: Netlify function `POST /.netlify/functions/reset-course-topics`

(Netlify function, not edge, because it needs `firebase-admin` + `BulkWriter`; follows the pattern of `delete-user.js`.)

**Request:**
```json
{
  "courseId": "calculus",
  "mode": "assignments" | "assignments_and_topics",
  "confirmToken": "calculus"   // client must echo courseId — guards fat-finger resets
}
```
**Auth:** Firebase ID token, `role === 'admin'` only.

### 3.2 Deletion strategy — hard delete via Admin SDK `BulkWriter`

Soft deletes are unnecessary here (assignments are cheap to regenerate via the AI pipeline) and would pollute every read query with `where deleted == false`. Use **hard batch deletion**, which Firestore handles efficiently server-side:

```javascript
const bulkWriter = db.bulkWriter();          // auto-throttles, handles retries
// 1. Delete all assignments for the course (paged query, 500/page):
let q = db.collection('topic_assignments').where('courseId', '==', courseId).limit(500);
// loop: get page → bulkWriter.delete(each ref) → repeat until empty
// 2. If mode === 'assignments_and_topics':
//    delete courses/{courseId}/topics/* the same way (db.recursiveDelete also works)
// 3. Clear the denormalized cache: for each exam where courseId == courseId,
//    strip topicIds fields from questions[]/parts[] (one update per exam doc).
await bulkWriter.close();
```

Key properties:
- **Questions/clauses are untouched** — only `topic_assignments` docs, `topics` docs (optional), and the cached `topicIds` fields are removed. Legacy `subject` strings remain as historical data.
- **Idempotent & resumable**: paged loop means a re-run after a mid-way failure just finishes the remainder.
- **No Firestore cascade exists** — this explicit server-side batch delete IS the cascade; deterministic doc IDs + the `courseId` field make it a single indexed query.
- **Audit**: write one doc to the existing `audit_log` collection: `{ action: 'reset_course_topics', courseId, mode, deletedAssignments: n, deletedTopics: m, uid, at }`.
- Return `{ deletedAssignments, deletedTopics }` counts to the caller; admin UI shows a typed-confirmation dialog ("type the course id to confirm") before calling.

---

## 4. Deliverables Checklist (for the implementing agent)

1. **Schema/rules**
   - [ ] `firestore.rules`: rules for `topic_assignments` + `courses/{id}/topics` (§1.5)
   - [ ] `firestore.indexes.json`: three composite indexes (§1.4)
2. **Server**
   - [ ] `netlify/edge-functions/categorize-question.js` (+ route in `netlify.toml` → `/api/categorize-question`) — §2
   - [ ] `netlify/functions/reset-course-topics.js` — §3
3. **Client**
   - [ ] `utils.js`: `effectiveTopics()` resolver (§1.2) + topic-name lookup cache
   - [ ] `admin.js`: topic CRUD per course; "Categorize" (per exam / per course) with progress + relatedness override UI; "Reset topics" with typed confirmation; review queue filter (`needsReview`)
   - [ ] `course.js` / student UI: filter-by-topic reads from `topicIds` cache on exam docs, falling back to legacy `subject`
4. **Migration (one-off script in `seed/` style)**
   - [ ] For each course: collect distinct legacy `subject` strings → optionally seed as draft topics (admin curates/merges) → do NOT auto-create assignments; the AI pipeline (§2) is the backfill mechanism.
5. **Tests**
   - [ ] Rules tests (extend `tests/rules-difficulty-telemetry.test.js` pattern): student cannot write assignments; admin can.
   - [ ] Unit tests for the either/or batch logic and `effectiveTopics()` inheritance.
   - [ ] Emulator seed (`seed/seed.js`): add sample topics + mixed question/clause assignments (one dependent question, one independent question).

## 5. Rollout order

1. Rules + indexes + topics CRUD (safe, additive).
2. Categorization edge function behind admin UI; run on one course; curate via review queue.
3. Student-facing topic filters switch to new model with legacy-`subject` fallback.
4. Reset endpoint last (it's destructive; ship after the pipeline proves it can regenerate).
