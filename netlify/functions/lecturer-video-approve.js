/* ============================================================
   netlify/functions/lecturer-video-approve.js

   Step 3 (admin only): approve OR reject a pending lecturer video.

   Body:
     { videoGuid, action: 'approve'|'reject', adminNotes?, chapters? }

   On 'approve':
     - Optionally overrides chapters (admin can edit before publish).
     - Writes/merges question_videos/{questionId} with
         { libraryId, videoId: videoGuid, chapters, source: 'lecturer',
           submissionId, updatedAt }
       so the existing student-side 🎬 surface picks it up.
     - Marks submission status:'approved' and processedAt.

   On 'reject':
     - Deletes the Bunny video to free storage quota.
     - Marks submission status:'rejected'.

   Caller MUST be admin (verified server-side).
   ============================================================ */

const admin = require('firebase-admin');
const https = require('https');

const ALLOWED_ORIGINS = (process.env.ADMIN_FUNCTION_ORIGINS ||
  'https://vaultau.netlify.app,http://localhost:8888,http://localhost:5173,http://127.0.0.1:8888'
).split(',').map(s => s.trim()).filter(Boolean);

const MAX_CHAPTERS    = 30;
const MAX_TITLE_CHARS = 200;
const MAX_NOTES_CHARS = 4000;

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

function bunnyDeleteVideo({ libraryId, apiKey, videoGuid }) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      method: 'DELETE',
      hostname: 'video.bunnycdn.com',
      path: `/library/${libraryId}/videos/${videoGuid}`,
      headers: { 'AccessKey': apiKey, 'Accept': 'application/json' },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(true);
        // 404 = already gone — treat as success
        if (res.statusCode === 404) return resolve(true);
        reject(new Error(`Bunny DELETE ${res.statusCode}: ${buf.slice(0, 200)}`));
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function sanitizeChapters(raw) {
  if (!Array.isArray(raw)) return null; // null = "do not override"
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
  out.sort((a, b) => a.timeSeconds - b.timeSeconds);
  return out;
}

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(origin), body: '' };
  if (event.httpMethod !== 'POST')    return json(405, { error: 'Method Not Allowed' }, origin);

  const a = getAdmin();
  if (!a) return json(500, { error: 'Server misconfiguration: Firebase Admin not initialized' }, origin);

  const libraryId = process.env.BUNNY_STREAM_LIBRARY_ID;
  const apiKey    = process.env.BUNNY_STREAM_API_KEY;
  if (!libraryId || !apiKey) {
    return json(500, { error: 'Server misconfiguration: Bunny Stream not configured' }, origin);
  }

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
  let callerRole = 'student';
  try {
    const userSnap = await db.collection('users').doc(callerUid).get();
    callerRole = userSnap.exists ? (userSnap.data().role || 'student') : 'student';
  } catch (e) {
    return json(500, { error: 'Role lookup failed' }, origin);
  }
  if (callerRole !== 'admin') {
    return json(403, { error: 'Forbidden: admin role required' }, origin);
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON body' }, origin); }

  const videoGuid  = String(body.videoGuid || '').trim();
  const action     = String(body.action    || '').trim();
  const adminNotes = String(body.adminNotes || '').trim().slice(0, MAX_NOTES_CHARS);
  const chaptersOverride = sanitizeChapters(body.chapters);

  if (!videoGuid) return json(400, { error: 'videoGuid is required' }, origin);
  if (action !== 'approve' && action !== 'reject') {
    return json(400, { error: "action must be 'approve' or 'reject'" }, origin);
  }

  const subRef = db.collection('video_submissions').doc(videoGuid);
  const subSnap = await subRef.get();
  if (!subSnap.exists) return json(404, { error: 'Submission not found' }, origin);
  const sub = subSnap.data();

  if (action === 'reject') {
    try { await bunnyDeleteVideo({ libraryId, apiKey, videoGuid }); }
    catch (e) { console.warn('Bunny delete failed (continuing):', e.message); }
    await subRef.update({
      status:        'rejected',
      adminNotes,
      processedAt:   admin.firestore.FieldValue.serverTimestamp(),
      processedBy:   callerUid,
    });
    return json(200, { ok: true, status: 'rejected' }, origin);
  }

  // ── approve ──
  const finalChapters = (chaptersOverride !== null) ? chaptersOverride : (sub.chapters || []);
  const questionId    = sub.questionId;
  const examId        = sub.examId;

  if (!questionId) return json(400, { error: 'submission missing questionId' }, origin);

  // Write to question_videos so existing student 🎬 surface picks it up
  try {
    await db.collection('question_videos').doc(questionId).set({
      libraryId:    String(sub.libraryId || libraryId),
      videoId:      videoGuid,
      chapters:     finalChapters,
      source:       'lecturer',
      submissionId: videoGuid,
      examId:       examId || '',
      questionId,
      updatedAt:    admin.firestore.FieldValue.serverTimestamp(),
      updatedBy:    callerUid,
    }, { merge: true });
  } catch (e) {
    console.error('question_videos write failed:', e);
    return json(500, { error: 'Failed to publish video' }, origin);
  }

  await subRef.update({
    status:        'approved',
    adminNotes,
    chapters:      finalChapters,
    processedAt:   admin.firestore.FieldValue.serverTimestamp(),
    processedBy:   callerUid,
  });

  return json(200, { ok: true, status: 'approved', questionId }, origin);
};
