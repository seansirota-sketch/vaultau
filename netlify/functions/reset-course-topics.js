/* ============================================================
   netlify/functions/reset-course-topics.js
   Wipe a course's topic architecture WITHOUT touching questions.

   Deletes (hard, via BulkWriter):
     - all topic_assignments where courseId == <courseId>
     - (optional) courses/<courseId>/topics/*      when mode includes topics
     - embedded topic-assignment fields on that course's exam docs

   Questions and clauses remain intact; only topic-assignment fields are removed.

   Caller MUST be an authenticated admin.

   Environment Variables:
     FIREBASE_SERVICE_ACCOUNT — JSON string of a service account key
   ============================================================ */

const admin = require('firebase-admin');

const ALLOWED_ORIGINS = (process.env.ADMIN_FUNCTION_ORIGINS ||
  'https://vaultau.netlify.app,http://localhost:8888,http://localhost:5173,http://127.0.0.1:8888'
).split(',').map(s => s.trim()).filter(Boolean);

const PAGE = 400;

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
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

function json(statusCode, body, origin) {
  return {
    statusCode,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

// Delete every doc matched by a course-scoped query, paged so the loop is
// resumable if it fails partway (a re-run just finishes the remainder).
async function deleteCourseAssignments(db, bulkWriter, courseId) {
  let total = 0;
  while (true) {
    const snap = await db.collection('topic_assignments')
      .where('courseId', '==', courseId)
      .limit(PAGE)
      .get();
    if (snap.empty) break;
    snap.docs.forEach(d => { bulkWriter.delete(d.ref); total++; });
    await bulkWriter.flush();
    if (snap.size < PAGE) break;
  }
  return total;
}

async function deleteCourseTopics(db, courseId) {
  const col = db.collection('courses').doc(courseId).collection('topics');
  let total = 0;
  while (true) {
    const snap = await col.limit(PAGE).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach(d => { batch.delete(d.ref); total++; });
    await batch.commit();
    if (snap.size < PAGE) break;
  }
  return total;
}

function stripAssignmentFields(entity) {
  if (!entity || typeof entity !== 'object') return entity;
  const next = { ...entity };
  delete next.topicIds;
  delete next.subject;
  delete next.topic;
  return next;
}

// Strip embedded topic-assignment fields from the exam's questions/clauses so
// the UI no longer falls back to legacy subject/topic values after a reset.
async function clearExamCache(db, courseId) {
  const snap = await db.collection('exams').where('courseId', '==', courseId).get();
  let updated = 0;
  for (const doc of snap.docs) {
    const data = doc.data();
    if (!Array.isArray(data.questions)) continue;
    let touched = false;
    const questions = data.questions.map(q => {
      const hasQuestionAssignmentFields = q && typeof q === 'object'
        && (('topicIds' in q) || ('subject' in q) || ('topic' in q));
      if (hasQuestionAssignmentFields) touched = true;
      const nq = stripAssignmentFields(q);
      const clauseKey = Array.isArray(nq.subs) ? 'subs' : (Array.isArray(nq.parts) ? 'parts' : null);
      if (clauseKey) {
        nq[clauseKey] = nq[clauseKey].map(c => {
          const hasClauseAssignmentFields = c && typeof c === 'object'
            && (('topicIds' in c) || ('subject' in c) || ('topic' in c));
          if (hasClauseAssignmentFields) touched = true;
          return stripAssignmentFields(c);
        });
      }
      return nq;
    });
    if (touched) { await doc.ref.update({ questions }); updated++; }
  }
  return updated;
}

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(origin), body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' }, origin);

  const a = getAdmin();
  if (!a) {
    console.error('Missing env var: FIREBASE_SERVICE_ACCOUNT');
    return json(500, { error: 'Server misconfiguration' }, origin);
  }

  // ── Verify caller ID token ──
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!idToken) return json(401, { error: 'Missing Authorization bearer token' }, origin);

  let callerUid;
  try {
    const decoded = await a.auth().verifyIdToken(idToken);
    callerUid = decoded.uid;
  } catch (e) {
    return json(401, { error: 'Invalid ID token' }, origin);
  }

  const db = a.firestore();
  let callerRole;
  try {
    const snap = await db.collection('users').doc(callerUid).get();
    callerRole = snap.exists ? (snap.data().role || 'student') : 'student';
  } catch (e) {
    return json(500, { error: 'Role lookup failed' }, origin);
  }
  if (callerRole !== 'admin') return json(403, { error: 'Forbidden: admin role required' }, origin);

  // ── Parse body ──
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON body' }, origin); }

  const courseId = String(body.courseId || '').trim();
  const mode = body.mode === 'assignments_and_topics' ? 'assignments_and_topics' : 'assignments';
  const confirmToken = String(body.confirmToken || '');
  const confirmed = body.confirmed === true;

  if (!courseId) return json(400, { error: 'Missing courseId' }, origin);
  // Accept either the new explicit boolean confirmation or the legacy
  // confirmToken echo so older admin bundles keep working during rollout.
  if (!confirmed && confirmToken !== courseId) {
    return json(400, { error: 'Reset action must be explicitly confirmed' }, origin);
  }

  let deletedAssignments = 0;
  let deletedTopics = 0;
  let examsCleared = 0;
  const errors = [];

  try {
    const bulkWriter = db.bulkWriter();
    deletedAssignments = await deleteCourseAssignments(db, bulkWriter, courseId);
    await bulkWriter.close();
  } catch (e) {
    console.error('assignment deletion failed:', e.message);
    errors.push({ step: 'assignments', error: e.message });
  }

  try {
    examsCleared = await clearExamCache(db, courseId);
  } catch (e) {
    console.error('exam cache clear failed:', e.message);
    errors.push({ step: 'exam_cache', error: e.message });
  }

  if (mode === 'assignments_and_topics') {
    try {
      deletedTopics = await deleteCourseTopics(db, courseId);
    } catch (e) {
      console.error('topic deletion failed:', e.message);
      errors.push({ step: 'topics', error: e.message });
    }
  }

  // ── Audit (best-effort) ──
  try {
    await db.collection('audit_log').add({
      action: 'admin.resetCourseTopics',
      callerUid,
      courseId,
      mode,
      deletedAssignments,
      deletedTopics,
      examsCleared,
      errors,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.warn('audit log write failed:', e.message);
  }

  return json(errors.length ? 207 : 200, {
    ok: errors.length === 0,
    courseId,
    mode,
    deletedAssignments,
    deletedTopics,
    examsCleared,
    errors,
  }, origin);
};

module.exports.stripAssignmentFields = stripAssignmentFields;
