/* ============================================================
   netlify/functions/lecturer-video-submit.js

   Step 2 of lecturer video upload flow.
   Called AFTER the browser successfully finishes the TUS upload
   to Bunny.net. Marks the video_submissions doc as 'pending' and
   stores lecturer notes + chapters. Also writes a report so the
   admin gets a notification badge.

   Body:
     { videoGuid, notes, chapters: [{ timeSeconds, title }] }

   The submission doc is keyed by videoGuid (created in the -init step
   with status:'draft'). We re-verify the caller is the same lecturer
   who owns that draft (or an admin).
   ============================================================ */

const admin = require('firebase-admin');

const ALLOWED_ORIGINS = (process.env.ADMIN_FUNCTION_ORIGINS ||
  'https://vaultau.netlify.app,http://localhost:8888,http://localhost:5173,http://127.0.0.1:8888'
).split(',').map(s => s.trim()).filter(Boolean);

const MAX_CHAPTERS    = 30;
const MAX_NOTES_CHARS = 4000;
const MAX_TITLE_CHARS = 200;

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin':  allow,
    'Vary':                         'Origin',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
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

function sanitizeChapters(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const t = Number(c.timeSeconds);
    const title = String(c.title || '').trim().slice(0, MAX_TITLE_CHARS);
    if (!Number.isFinite(t) || t < 0 || !title) continue;
    const item = { timeSeconds: Math.floor(t), title };
    const e = Number(c.endSeconds);
    if (Number.isFinite(e) && e > t) item.endSeconds = Math.floor(e);
    out.push(item);
    if (out.length >= MAX_CHAPTERS) break;
  }
  // sort ascending by time
  out.sort((a, b) => a.timeSeconds - b.timeSeconds);
  return out;
}

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(origin), body: '' };
  if (event.httpMethod !== 'POST')    return json(405, { error: 'Method Not Allowed' }, origin);

  const a = getAdmin();
  if (!a) return json(500, { error: 'Server misconfiguration: Firebase Admin not initialized' }, origin);

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!idToken) return json(401, { error: 'Missing Authorization bearer token' }, origin);

  let callerUid, callerEmail;
  try {
    const decoded = await a.auth().verifyIdToken(idToken);
    callerUid   = decoded.uid;
    callerEmail = decoded.email || '';
  } catch (e) {
    return json(401, { error: 'Invalid ID token' }, origin);
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON body' }, origin); }

  const videoGuid = String(body.videoGuid || '').trim();
  const notes     = String(body.notes     || '').trim().slice(0, MAX_NOTES_CHARS);
  const chapters  = sanitizeChapters(body.chapters);
  if (!videoGuid) return json(400, { error: 'videoGuid is required' }, origin);

  const db = a.firestore();

  // Check caller role for admin shortcut
  let callerRole = 'student';
  try {
    const userSnap = await db.collection('users').doc(callerUid).get();
    callerRole = userSnap.exists ? (userSnap.data().role || 'student') : 'student';
  } catch (e) {
    return json(500, { error: 'Role lookup failed' }, origin);
  }
  const isAdmin = callerRole === 'admin';

  // Load draft submission
  const subRef = db.collection('video_submissions').doc(videoGuid);
  let subSnap;
  try { subSnap = await subRef.get(); }
  catch (e) { return json(500, { error: 'Submission lookup failed' }, origin); }
  if (!subSnap.exists) return json(404, { error: 'Submission draft not found' }, origin);
  const sub = subSnap.data();

  if (!isAdmin && sub.uploadedByUid !== callerUid) {
    return json(403, { error: 'Forbidden: you do not own this submission' }, origin);
  }

  // Update to 'pending' with lecturer-supplied metadata
  try {
    await subRef.update({
      notes,
      chapters,
      status:      'pending',
      submittedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.error('submission update failed:', e);
    return json(500, { error: 'Failed to update submission' }, origin);
  }

  // Resolve friendly labels (exam title + question number / sub-question letter)
  let examTitle = '';
  let questionLabel = `שאלה ${sub.questionId}`;
  try {
    if (sub.examId) {
      const exSnap = await db.collection('exams').doc(sub.examId).get();
      if (exSnap.exists) {
        const ex = exSnap.data() || {};
        examTitle = ex.title || ex.name || '';
        const qs = Array.isArray(ex.questions) ? ex.questions : [];
        const qIdx = qs.findIndex(q => q && q.id === sub.questionId);
        if (qIdx >= 0) {
          questionLabel = `שאלה ${qIdx + 1}`;
        } else {
          for (let i = 0; i < qs.length; i++) {
            const subs = Array.isArray(qs[i]?.subQuestions) ? qs[i].subQuestions : [];
            const sIdx = subs.findIndex(s => s && s.id === sub.questionId);
            if (sIdx >= 0) {
              const HEB_ALEF = 0x05D0;
              const letter = subs[sIdx].letter || String.fromCharCode(HEB_ALEF + sIdx);
              questionLabel = `שאלה ${i + 1} סעיף ${letter}`;
              break;
            }
          }
        }
      }
    }
  } catch (e) { /* non-fatal */ }
  const examPart = examTitle ? ` במבחן ${examTitle}` : '';
  const reportMessage = `סרטון חדש להעלאה: ${questionLabel}${examPart}`;

  // Write a report doc so the admin sees the notification badge
  try {
    await db.collection('reports').add({
      category:           'lecturer_video_submission',
      message:            reportMessage,
      userId:             callerUid,
      userEmail:          callerEmail || sub.uploadedByEmail || '',
      examId:             sub.examId || '',
      examTitle:          examTitle || '',
      questionId:         sub.questionId || '',
      submissionId:       videoGuid,
      createdAt:          admin.firestore.FieldValue.serverTimestamp(),
      status:             'open',
      adminResponseText:  '',
      adminResponseAt:    null,
      userLastReadAt:     null,
      adminDeletedAt:     null,
      userDeletedAt:      null,
      bothDeletedAt:      null,
    });
  } catch (e) {
    console.error('report write failed:', e);
    // Non-fatal; submission already saved.
  }

  return json(200, { ok: true, videoGuid, status: 'pending' }, origin);
};
