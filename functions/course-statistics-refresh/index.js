'use strict';

const functions = require('firebase-functions/v2/firestore');
const admin = require('firebase-admin');

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

async function buildCourseStatistics(courseId) {
  const [usersSnap, examsSnap, topicsSnap] = await Promise.all([
    db.collection('users').where('savedCourses', 'array-contains', courseId).get(),
    db.collection('exams').where('courseId', '==', courseId).get(),
    db.collection('courses').doc(courseId).collection('topics').get(),
  ]);
  const topicNames = {};
  topicsSnap.forEach(doc => { topicNames[doc.id] = doc.data().name || doc.id; });
  const questionSubjects = new Map();
  const examIds = new Set();
  examsSnap.forEach(examDoc => {
    examIds.add(examDoc.id);
    (examDoc.data().questions || []).forEach(question => {
      const subject = resolveSubject(question, topicNames);
      questionSubjects.set(question.id, subject);
      (question.subs || question.parts || []).forEach(sub => {
        questionSubjects.set(sub.id, resolveSubject(sub, topicNames) || subject);
      });
    });
  });

  let totalStudySeconds = 0;
  let totalCompletedExams = 0;
  const subjectTotals = {};
  usersSnap.forEach(userDoc => {
    const user = userDoc.data();
    totalStudySeconds += Number(user.studyTimeByCourse?.[courseId]) || 0;
    totalCompletedExams += (user.doneExams || []).filter(id => examIds.has(id)).length;
    Object.keys(user.difficultyVotes || {}).forEach(questionId => {
      const subject = questionSubjects.get(questionId);
      if (subject) subjectTotals[subject] = (subjectTotals[subject] || 0) + 1;
    });
  });

  const studentCount = usersSnap.size;
  await db.collection('course_statistics').doc(courseId).set({
    studentCount,
    averageStudyTimeSeconds: studentCount ? Math.round(totalStudySeconds / studentCount) : 0,
    averageCompletedExams: studentCount ? Number((totalCompletedExams / studentCount).toFixed(2)) : 0,
    questionSolvedGraph: Object.entries(subjectTotals)
      .sort((a, b) => b[1] - a[1])
      .map(([subject, total]) => ({
        subject,
        total,
        average: studentCount ? Number((total / studentCount).toFixed(2)) : 0,
      })),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

function resolveSubject(entity, topicNames) {
  const ids = Array.isArray(entity.topicIds)
    ? entity.topicIds
    : (entity.topicIds ? [entity.topicIds] : []);
  if (ids.length) return topicNames[ids[0]] || ids[0];
  return String(entity.subject || entity.topic || '').trim();
}

exports.courseStatisticsRefresh = functions.onDocumentWritten('users/{userId}', async event => {
  const before = event.data?.before?.data() || {};
  const after = event.data?.after?.data() || {};
  const courseIds = new Set([
    ...(Array.isArray(before.savedCourses) ? before.savedCourses : []),
    ...(Array.isArray(after.savedCourses) ? after.savedCourses : []),
  ]);
  await Promise.all([...courseIds].map(buildCourseStatistics));
});
