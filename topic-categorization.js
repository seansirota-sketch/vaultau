/* ============================================================
   topic-categorization.js
   Admin-side UI + logic for hierarchical topic categorization.

   Loaded AFTER firebase-config.js, utils.js and admin.js on
   admin.html. Uses the global `db`, `auth`, `firebase` (v8 compat)
   and the topic helpers from utils.js.

   Responsibilities:
     - Course topic CRUD           (courses/{id}/topics)
     - AI categorization of a whole exam via /api/categorize-question
     - Atomic assignment writes honoring the question/clause either-or
       invariant + the denormalized topicIds cache on the exam doc
     - Course topic reset via /.netlify/functions/reset-course-topics

   See docs/topic-categorization-plan.md.
   ============================================================ */
(function () {
  'use strict';

  const CATEGORIZE_ENDPOINT = '/api/categorize-question';
  const RESET_ENDPOINT = '/.netlify/functions/reset-course-topics';
  const CONFIDENCE_REVIEW_THRESHOLD = 0.55;

  const FieldValue = () => firebase.firestore.FieldValue;
  const now = () => FieldValue().serverTimestamp();

  async function idToken() {
    const t = await (auth.currentUser && auth.currentUser.getIdToken());
    if (!t) throw new Error('לא מחובר — יש להתחבר מחדש');
    return t;
  }

  // ── Topic CRUD ────────────────────────────────────────────
  async function fetchCourseTopics(courseId) {
    const snap = await db.collection('courses').doc(courseId)
      .collection('topics').orderBy('order').get()
      .catch(async () => db.collection('courses').doc(courseId).collection('topics').get());
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  async function upsertTopic(courseId, topic) {
    const id = String(topic.id || slugify(topic.name));
    if (!id) throw new Error('נדרש מזהה נושא (id) או שם');
    const ref = db.collection('courses').doc(courseId).collection('topics').doc(id);
    const exists = (await ref.get()).exists;
    const payload = {
      name: String(topic.name || id),
      description: String(topic.description || ''),
      order: Number.isFinite(topic.order) ? topic.order : 100,
      status: topic.status === 'archived' ? 'archived' : 'active',
      updatedAt: now(),
    };
    if (!exists) { payload.createdAt = now(); payload.createdBy = auth.currentUser?.uid || null; }
    await ref.set(payload, { merge: true });
    return id;
  }

  async function deleteTopic(courseId, topicId) {
    await db.collection('courses').doc(courseId).collection('topics').doc(topicId).delete();
  }

  function slugify(name) {
    return String(name || '').trim().toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  }

  // ── Assignment writes (either/or invariant + exam cache) ──
  // Rebuild the exam's questions array with cached topicIds and produce the
  // list of topic_assignments doc operations for one question.
  function applyProposalToQuestion(examId, courseId, question, proposal, uid) {
    const clauses = getQuestionClauses(question);
    const ops = [];          // { ref, data } for set, or { ref, delete:true }
    const col = db.collection('topic_assignments');
    const qDocId = questionAssignmentId(examId, question.id);
    const clauseDocId = (cid) => clauseAssignmentId(examId, question.id, cid);

    const base = {
      courseId, examId, questionId: question.id,
      source: proposal.source || 'ai',
      updatedAt: now(), updatedBy: uid || null,
    };
    const aiMeta = proposal.source === 'manual' ? null : {
      relatedness: proposal.relatedness || null,
      confidence: typeof proposal.confidence === 'number' ? proposal.confidence : null,
      model: proposal.model || null,
      runId: proposal.runId || null,
    };
    const needsReview = aiMeta && typeof aiMeta.confidence === 'number'
      && aiMeta.confidence < CONFIDENCE_REVIEW_THRESHOLD;

    // Deep-clone question so we can mutate the cache safely.
    const nq = JSON.parse(JSON.stringify(question));
    const clauseKey = Array.isArray(nq.subs) ? 'subs' : (Array.isArray(nq.parts) ? 'parts' : 'subs');

    if (proposal.scope === 'clause') {
      // Clause-level: delete the question-level doc, set one doc per clause.
      ops.push({ ref: col.doc(qDocId), delete: true });
      if (nq.topicIds) delete nq.topicIds;
      const byClause = new Map((proposal.perClause || []).map(p => [p.clauseId, p.topicIds || []]));
      (nq[clauseKey] || []).forEach(c => {
        const topicIds = byClause.get(c.id) || [];
        c.topicIds = topicIds;
        ops.push({
          ref: col.doc(clauseDocId(c.id)),
          data: { ...base, clauseId: c.id, scope: 'clause', topicIds,
                  aiMeta: aiMeta || null, needsReview: !!needsReview, createdAt: now() },
        });
      });
    } else {
      // Question-level: set the question doc, delete every clause-level doc.
      const topicIds = proposal.questionTopicIds || [];
      nq.topicIds = topicIds;
      ops.push({
        ref: col.doc(qDocId),
        data: { ...base, clauseId: null, scope: 'question', topicIds,
                aiMeta: aiMeta || null, needsReview: !!needsReview, createdAt: now() },
      });
      (clauses || []).forEach(c => {
        ops.push({ ref: col.doc(clauseDocId(c.id)), delete: true });
        if (nq[clauseKey]) {
          const nc = (nq[clauseKey] || []).find(x => x.id === c.id);
          if (nc && nc.topicIds) delete nc.topicIds;
        }
      });
    }

    return { newQuestion: nq, ops, needsReview: !!needsReview };
  }

  // Commit proposals for many questions of ONE exam in a single atomic batch:
  // assignment docs + the rebuilt exam.questions cache.
  async function commitExamProposals(exam, proposalsByQuestionId) {
    const uid = auth.currentUser?.uid || null;
    const examRef = db.collection('exams').doc(exam.id);
    const batch = db.batch();
    let reviewCount = 0;

    const newQuestions = (exam.questions || []).map(q => {
      const proposal = proposalsByQuestionId[q.id];
      if (!proposal) return q;
      const { newQuestion, ops, needsReview } = applyProposalToQuestion(exam.id, exam.courseId, q, proposal, uid);
      if (needsReview) reviewCount++;
      ops.forEach(op => {
        if (op.delete) batch.delete(op.ref);
        else batch.set(op.ref, op.data);
      });
      return newQuestion;
    });

    batch.update(examRef, { questions: newQuestions });
    await batch.commit();
    return { reviewCount, updatedQuestions: newQuestions.length };
  }

  // ── AI categorization ─────────────────────────────────────
  async function categorizeQuestion(question, clauses, topics, token) {
    const res = await fetch(CATEGORIZE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        question: { id: question.id, text: question.text },
        clauses: (clauses || []).map(c => ({ id: c.id, label: c.label, text: c.text })),
        topics: topics.map(t => ({ id: t.id, name: t.name, description: t.description || '' })),
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  // Categorize an entire exam. Returns a summary. Skips questions that already
  // have a manual assignment unless overrideManual is true.
  async function categorizeExam(courseId, examId, opts = {}) {
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
    const token = await idToken();
    const topics = await fetchCourseTopics(courseId);
    if (!topics.length) throw new Error('אין נושאים מוגדרים לקורס — הוסף נושאים תחילה');

    const examSnap = await db.collection('exams').doc(examId).get();
    if (!examSnap.exists) throw new Error('מבחן לא נמצא');
    const exam = { id: examSnap.id, ...examSnap.data() };
    exam.courseId = exam.courseId || courseId;

    const manualIds = opts.overrideManual ? new Set() : await manualQuestionIds(examId);
    const runId = `categorize-${Date.now()}`;
    const proposals = {};
    const questions = exam.questions || [];
    let done = 0;

    for (const q of questions) {
      done++;
      if (manualIds.has(q.id)) { onProgress({ done, total: questions.length, questionId: q.id, skipped: true }); continue; }
      const clauses = getQuestionClauses(q);
      try {
        const { proposal, model } = await categorizeQuestion(q, clauses, topics, token);
        proposals[q.id] = { ...proposal, source: 'ai', model, runId };
        onProgress({ done, total: questions.length, questionId: q.id, proposal });
      } catch (e) {
        onProgress({ done, total: questions.length, questionId: q.id, error: e.message });
      }
    }

    const { reviewCount } = await commitExamProposals(exam, proposals);
    return { examId, categorized: Object.keys(proposals).length, reviewCount, runId };
  }

  async function manualQuestionIds(examId) {
    const snap = await db.collection('topic_assignments')
      .where('examId', '==', examId).where('source', '==', 'manual').get()
      .catch(() => ({ docs: [] }));
    return new Set(snap.docs.map(d => d.data().questionId));
  }

  // Manual override for a single question (source: 'manual', never overwritten
  // by AI runs). proposal is the same shape returned by the edge function.
  async function setManualAssignment(examId, courseId, questionId, proposal) {
    const examSnap = await db.collection('exams').doc(examId).get();
    if (!examSnap.exists) throw new Error('מבחן לא נמצא');
    const exam = { id: examSnap.id, ...examSnap.data() };
    exam.courseId = exam.courseId || courseId;
    return commitExamProposals(exam, { [questionId]: { ...proposal, source: 'manual' } });
  }

  // ── Reset ─────────────────────────────────────────────────
  async function resetCourseTopics(courseId, mode) {
    const token = await idToken();
    const res = await fetch(RESET_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        courseId,
        mode: mode === 'assignments_and_topics' ? 'assignments_and_topics' : 'assignments',
        confirmToken: courseId,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 207) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // ── Public API ────────────────────────────────────────────
  const api = {
    fetchCourseTopics,
    upsertTopic,
    deleteTopic,
    categorizeExam,
    setManualAssignment,
    resetCourseTopics,
    // low-level (exposed for tests / advanced use)
    applyProposalToQuestion,
    commitExamProposals,
  };
  if (typeof window !== 'undefined') window.TopicCategorization = api;
})();
