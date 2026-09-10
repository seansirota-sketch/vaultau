/* ============================================================
   Course-wide student statistics.

   Computes privacy-safe aggregates for logged-in students without exposing
   other users' documents to the browser.
   ============================================================ */

const admin = require('firebase-admin');

const ALLOWED_ORIGINS = (process.env.ADMIN_FUNCTION_ORIGINS ||
  'https://vaultau.netlify.app,http://localhost:8888,http://localhost:5173,http://127.0.0.1:8888'
).split(',').map(s => s.trim()).filter(Boolean);

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };
}

function json(statusCode, body, origin) {
  return {
    statusCode,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function getAdmin() {
  if (admin.apps.length) return admin;
  if (process.env.FIREBASE_AUTH_EMULATOR_HOST || process.env.FIRESTORE_EMULATOR_HOST) {
    admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'eaxmbank' });
    return admin;
  }
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!sa) return null;
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(sa)) });
  return admin;
}

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

async function buildCourseStatistics(db, courseId) {
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
exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(origin), body: '' };
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' }, origin);

  const a = getAdmin();
  if (!a) {
    console.error('Missing env var: FIREBASE_SERVICE_ACCOUNT');
    return json(500, { error: 'Server misconfiguration' }, origin);
  }

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!idToken) return json(401, { error: 'Missing Authorization bearer token' }, origin);

  try {
    await a.auth().verifyIdToken(idToken);
  } catch (error) {
    console.warn('verifyIdToken failed:', error.message);
    return json(401, { error: 'Invalid ID token' }, origin);
  }

  const courseId = normalizeSubject(event.queryStringParameters && event.queryStringParameters.courseId);
  if (!courseId || courseId.length > 128) return json(400, { error: 'Invalid courseId' }, origin);

  try {
    const stats = await buildCourseStatistics(a.firestore(), courseId);
    return json(200, stats, origin);
  } catch (error) {
    console.error('course statistics failed:', error);
    return json(500, { error: 'Failed to calculate course statistics' }, origin);
  }
};
