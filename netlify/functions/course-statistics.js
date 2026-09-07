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
  let totalStudySeconds = 0;
  let totalCompletedExams = 0;
  let totalRatedQuestions = 0;
  const subjectCounts = {};

  usersSnap.forEach(userDoc => {
    const user = userDoc.data();
    const savedCourses = Array.isArray(user.savedCourses) ? user.savedCourses : [];
    const studySeconds = Number(user.studyTimeByCourse && user.studyTimeByCourse[courseId]) || 0;
    const completedExamCount = (Array.isArray(user.doneExams) ? user.doneExams : [])
      .filter(id => examIds.has(id)).length;
    let ratedInCourse = 0;

    Object.keys(user.difficultyVotes || {}).forEach(entityId => {
      const subject = entitySubjects.get(entityId);
      if (!subject) return;
      ratedInCourse += 1;
      totalRatedQuestions += 1;
      subjectCounts[subject] = (subjectCounts[subject] || 0) + 1;
    });

    if (!savedCourses.includes(courseId) && !studySeconds && !completedExamCount && !ratedInCourse) return;
    studentCount += 1;
    totalStudySeconds += studySeconds;
    totalCompletedExams += completedExamCount;
  });

  const result = {
    studentCount,
    averageStudyTimeSeconds: studentCount ? Math.round(totalStudySeconds / studentCount) : 0,
    averageCompletedExams: studentCount ? Number((totalCompletedExams / studentCount).toFixed(2)) : 0,
    totalRatedQuestions,
    subjectCounts,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await db.collection('course_statistics').doc(courseId).set(result, { merge: false });
  return { ...result, updatedAt: new Date().toISOString() };
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
