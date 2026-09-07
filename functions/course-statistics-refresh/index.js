'use strict';

const functions = require('firebase-functions/v2/firestore');
const admin = require('firebase-admin');

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

function normalizeSubject(raw) {
  return String(raw || '').trim().replace(/\s+/g, ' ');
}

function topicName(topicIds, topicNames) {
  const ids = Array.isArray(topicIds) ? topicIds : (topicIds ? [topicIds] : []);
  if (!ids.length) return '';
  return normalizeSubject(topicNames[ids[0]] || ids[0]);
}

function embeddedSubject(entity, topicNames) {
  return topicName(entity.topicIds, topicNames) || normalizeSubject(entity.subject || entity.topic || '');
}

function buildEntitySubjects(examDocs, topicNames, assignmentDocs) {
  const entitySubjects = new Map();
  const questionToClauses = new Map();

  examDocs.forEach(examDoc => {
    const exam = examDoc.data();
    (exam.questions || []).forEach(question => {
      const questionSubject = embeddedSubject(question, topicNames);
      if (questionSubject) entitySubjects.set(question.id, questionSubject);
      const clauses = question.subs || question.parts || [];
      questionToClauses.set(question.id, clauses.map(clause => clause.id).filter(Boolean));
      clauses.forEach(clause => {
        const clauseSubject = embeddedSubject(clause, topicNames) || questionSubject;
        if (clauseSubject) entitySubjects.set(clause.id, clauseSubject);
      });
    });
  });

  assignmentDocs
    .map(doc => doc.data())
    .filter(a => a.scope !== 'clause')
    .forEach(a => {
      const subject = topicName(a.topicIds, topicNames);
      if (!subject || !a.questionId) return;
      entitySubjects.set(a.questionId, subject);
      (questionToClauses.get(a.questionId) || []).forEach(clauseId => entitySubjects.set(clauseId, subject));
    });

  assignmentDocs
    .map(doc => doc.data())
    .filter(a => a.scope === 'clause')
    .forEach(a => {
      const subject = topicName(a.topicIds, topicNames);
      if (subject && a.clauseId) entitySubjects.set(a.clauseId, subject);
    });

  return entitySubjects;
}

async function buildCourseStatistics(courseId) {
  const cutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const [usersSnap, examsSnap, topicsSnap, assignmentsSnap] = await Promise.all([
    db.collection('users').get(),
    db.collection('exams').where('courseId', '==', courseId).get(),
    db.collection('courses').doc(courseId).collection('topics').get(),
    db.collection('topic_assignments').where('courseId', '==', courseId).get(),
  ]);

  const topicNames = {};
  topicsSnap.forEach(doc => { topicNames[doc.id] = doc.data().name || doc.id; });
  const entitySubjects = buildEntitySubjects(examsSnap.docs, topicNames, assignmentsSnap.docs);
  const examIds = new Set(examsSnap.docs.map(doc => doc.id));

  let studentCount = 0;
  let totalCompletedExams = 0;
  let totalRatedQuestions = 0;
  const subjectCounts = {};

  usersSnap.forEach(userDoc => {
    const user = userDoc.data();
    if (timestampMs(user.courseExamLastOpenedAt && user.courseExamLastOpenedAt[courseId]) < cutoffMs) return;

    studentCount += 1;

    Object.entries(user.doneExamMeta || {}).forEach(([examId, meta]) => {
      if (!examIds.has(examId)) return;
      if (meta && meta.courseId && meta.courseId !== courseId) return;
      if (!meta || meta.status !== 'done') return;
      if (timestampMs(meta.updatedAt) < cutoffMs) return;
      totalCompletedExams += 1;
    });

    Object.keys(user.difficultyVotes || {}).forEach(entityId => {
      const meta = (user.difficultyVoteMeta || {})[entityId] || {};
      if (meta.courseId && meta.courseId !== courseId) return;
      if (timestampMs(meta.updatedAt) < cutoffMs) return;
      const subject = entitySubjects.get(entityId);
      if (!subject) return;
      totalRatedQuestions += 1;
      subjectCounts[subject] = (subjectCounts[subject] || 0) + 1;
    });
  });

  const result = {
    studentCount,
    windowDays: 30,
    averageCompletedExams: studentCount ? Number((totalCompletedExams / studentCount).toFixed(2)) : 0,
    totalRatedQuestions,
    subjectCounts,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await db.collection('course_statistics').doc(courseId).set(result, { merge: false });
  return { ...result, updatedAt: new Date().toISOString() };
}

function timestampMs(value) {
  if (!value) return 0;
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.seconds === 'number') return value.seconds * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
async function allCourseIds() {
  const snap = await db.collection('courses').get();
  return snap.docs.map(doc => doc.id);
}

exports.courseStatisticsRefresh = functions.onDocumentWritten('users/{userId}', async event => {
  const before = event.data?.before?.data() || {};
  const after = event.data?.after?.data() || {};
  const courseIds = new Set([
    ...(Array.isArray(before.savedCourses) ? before.savedCourses : []),
    ...(Array.isArray(after.savedCourses) ? after.savedCourses : []),
    ...Object.keys(before.studyTimeByCourse || {}),
    ...Object.keys(after.studyTimeByCourse || {}),
    ...Object.keys(before.courseExamLastOpenedAt || {}),
    ...Object.keys(after.courseExamLastOpenedAt || {}),
  ]);
  if (JSON.stringify(before.difficultyVotes || {}) !== JSON.stringify(after.difficultyVotes || {}) ||
      JSON.stringify(before.doneExamMeta || {}) !== JSON.stringify(after.doneExamMeta || {})) {
    (await allCourseIds()).forEach(courseId => courseIds.add(courseId));
  }
  await Promise.all([...courseIds].map(buildCourseStatistics));
});
