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
  const cutoff = admin.firestore.Timestamp.fromMillis(cutoffMs);
  const [usersSnap, examsSnap, topicsSnap, assignmentsSnap, courseSnap, eventsSnap] = await Promise.all([
    db.collection('users').get(),
    db.collection('exams').where('courseId', '==', courseId).get(),
    db.collection('courses').doc(courseId).collection('topics').get(),
    db.collection('topic_assignments').where('courseId', '==', courseId).get(),
    db.collection('courses').doc(courseId).get(),
    db.collection('analytics_events').where('timestamp', '>=', cutoff).get(),
  ]);

  const topicNames = {};
  topicsSnap.forEach(doc => { topicNames[doc.id] = doc.data().name || doc.id; });
  const entitySubjects = buildEntitySubjects(examsSnap.docs, topicNames, assignmentsSnap.docs);
  const courseCode = normalizeSubject(courseSnap.exists ? courseSnap.data().code : '');
  const examsById = new Map();
  const examsByLabel = new Map();
  examsSnap.docs.forEach(doc => {
    const exam = { id: doc.id, ...doc.data() };
    examsById.set(exam.id, exam);
    const label = examLabel(courseCode, exam);
    if (label) examsByLabel.set(label, exam);
  });

  const usersById = new Map();
  usersSnap.docs.forEach(doc => {
    const user = doc.data();
    usersById.set(user.uid || doc.id, user);
  });
  const events = eventsSnap.docs.map(doc => doc.data()).sort((a, b) => timestampMs(a.timestamp) - timestampMs(b.timestamp));
  const activeUids = new Set();

  usersById.forEach((user, uid) => {
    if (timestampMs(user.courseExamLastOpenedAt && user.courseExamLastOpenedAt[courseId]) >= cutoffMs) activeUids.add(uid);
  });
  events.forEach(event => {
    if (event.event === 'exam_open' && eventMatchesCourse(event, courseId, courseCode, examsById, examsByLabel)) {
      if (event.uid) activeUids.add(event.uid);
    }
  });

  const doneStates = new Map();
  const ratedSubjects = new Map();

  activeUids.forEach(uid => {
    const user = usersById.get(uid) || {};
    Object.entries(user.doneExamMeta || {}).forEach(([examId, meta]) => {
      if (!examsById.has(examId) || timestampMs(meta && meta.updatedAt) < cutoffMs) return;
      doneStates.set(uid + ':' + examId, meta.status === 'done');
    });
    Object.keys(user.difficultyVotes || {}).forEach(entityId => {
      const meta = (user.difficultyVoteMeta || {})[entityId] || {};
      if (timestampMs(meta.updatedAt) < cutoffMs) return;
      if (meta.courseId && meta.courseId !== courseId) return;
      const subject = entitySubjects.get(entityId);
      if (subject) ratedSubjects.set(uid + ':' + entityId, subject);
    });
  });

  events.forEach(event => {
    if (!event.uid || !activeUids.has(event.uid)) return;
    if (!eventMatchesCourse(event, courseId, courseCode, examsById, examsByLabel)) return;
    const payload = event.payload || {};
    if (event.event === 'exam_status_changed') {
      const exam = resolveEventExam(payload, examsById, examsByLabel);
      const key = event.uid + ':' + (exam ? exam.id : (payload.rawExamId || payload.examId || ''));
      if (key.endsWith(':')) return;
      doneStates.set(key, payload.status === 'done');
    }
    if (event.event === 'difficulty_voted') {
      const resolved = resolveEventQuestion(payload, examsById, examsByLabel, entitySubjects);
      if (resolved) ratedSubjects.set(event.uid + ':' + resolved.entityId, resolved.subject);
    }
  });

  const totalCompletedExams = [...doneStates.values()].filter(Boolean).length;
  const subjectCounts = {};
  ratedSubjects.forEach(subject => { subjectCounts[subject] = (subjectCounts[subject] || 0) + 1; });
  const studentCount = activeUids.size;
  const result = {
    studentCount,
    windowDays: 30,
    averageCompletedExams: studentCount ? Number((totalCompletedExams / studentCount).toFixed(2)) : 0,
    totalRatedQuestions: ratedSubjects.size,
    subjectCounts,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await db.collection('course_statistics').doc(courseId).set(result, { merge: false });
  return { ...result, updatedAt: new Date().toISOString() };
}

function latinLabel(value) {
  const map = { '\u05d0': 'A', '\u05d1': 'B', '\u05d2': 'C', '\u05d3': 'D' };
  return map[value] || String(value || '').toUpperCase();
}

function examLabel(courseCode, exam) {
  return [courseCode, exam.year, latinLabel(exam.semester), latinLabel(exam.moed)].filter(Boolean).join('_');
}

function resolveEventExam(payload, examsById, examsByLabel) {
  return examsById.get(payload.rawExamId) || examsById.get(payload.examId) || examsByLabel.get(payload.examId) || null;
}

function eventMatchesCourse(event, courseId, courseCode, examsById, examsByLabel) {
  const payload = event.payload || {};
  if (payload.courseId === courseId) return true;
  const eventCourse = normalizeSubject(payload.courseCode);
  if (eventCourse === normalizeSubject(courseId) || (courseCode && eventCourse === courseCode)) return true;
  return !!resolveEventExam(payload, examsById, examsByLabel);
}

function resolveEventQuestion(payload, examsById, examsByLabel, entitySubjects) {
  if (payload.rawQuestionId && entitySubjects.has(payload.rawQuestionId)) {
    return { entityId: payload.rawQuestionId, subject: entitySubjects.get(payload.rawQuestionId) };
  }
  const exam = resolveEventExam(payload, examsById, examsByLabel);
  const match = /^Q(\d+)([a-z])?$/i.exec(String(payload.questionId || ''));
  if (!exam || !match) return null;
  const question = (exam.questions || [])[Number(match[1]) - 1];
  if (!question) return null;
  let entity = question;
  if (match[2]) entity = (question.subs || question.parts || [])[match[2].toLowerCase().charCodeAt(0) - 97];
  if (!entity || !entity.id) return null;
  const subject = entitySubjects.get(entity.id);
  return subject ? { entityId: entity.id, subject } : null;
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
