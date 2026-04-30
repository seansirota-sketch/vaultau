/* ============================================================
   netlify/functions/lecturer-video-init.js

   Step 1 of lecturer video upload flow.
   Caller (lecturer) requests an upload slot for a question.
   This function:
     1. Verifies the caller is an authenticated lecturer assigned
        to the exam that owns this question (or an admin).
     2. Calls Bunny.net Stream API to create an empty video shell
        in the configured library, returning a videoGuid.
     3. Computes a TUS authorization signature so the browser can
        upload the bytes directly to Bunny without ever exposing
        the API key.

   Returns:
     { videoGuid, libraryId, authorizationSignature,
       authorizationExpire, tusEndpoint }

   Environment Variables:
     FIREBASE_SERVICE_ACCOUNT  — JSON string of a Firebase service account key
     BUNNY_STREAM_LIBRARY_ID   — numeric library id
     BUNNY_STREAM_API_KEY      — Bunny Stream library API key
     ADMIN_FUNCTION_ORIGINS    — comma-separated list of allowed origins (optional)
   ============================================================ */

const admin   = require('firebase-admin');
const crypto  = require('crypto');
const https   = require('https');

const ALLOWED_ORIGINS = (process.env.ADMIN_FUNCTION_ORIGINS ||
  'https://vaultau.netlify.app,http://localhost:8888,http://localhost:5173,http://127.0.0.1:8888'
).split(',').map(s => s.trim()).filter(Boolean);

const BUNNY_TUS_ENDPOINT = 'https://video.bunnycdn.com/tusupload';
const UPLOAD_EXPIRY_SECONDS = 60 * 60 * 6; // 6 hours

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

/* Create the empty Bunny video shell. Resolves to the GUID. */
function bunnyCreateVideo({ libraryId, apiKey, title }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ title: title.slice(0, 250) });
    const req = https.request({
      method: 'POST',
      hostname: 'video.bunnycdn.com',
      path: `/library/${libraryId}/videos`,
      headers: {
        'AccessKey':    apiKey,
        'Content-Type': 'application/json',
        'Accept':       'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const data = JSON.parse(buf);
            if (data && data.guid) return resolve(data.guid);
            return reject(new Error('Bunny response missing guid: ' + buf.slice(0, 200)));
          } catch (e) {
            return reject(new Error('Bunny invalid JSON: ' + buf.slice(0, 200)));
          }
        }
        reject(new Error(`Bunny ${res.statusCode}: ${buf.slice(0, 200)}`));
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(origin), body: '' };
  if (event.httpMethod !== 'POST')    return json(405, { error: 'Method Not Allowed' }, origin);

  const libraryId = process.env.BUNNY_STREAM_LIBRARY_ID;
  const apiKey    = process.env.BUNNY_STREAM_API_KEY;
  if (!libraryId || !apiKey) {
    console.error('Missing BUNNY_STREAM_LIBRARY_ID / BUNNY_STREAM_API_KEY');
    return json(500, { error: 'Server misconfiguration: Bunny Stream not configured' }, origin);
  }

  const a = getAdmin();
  if (!a) return json(500, { error: 'Server misconfiguration: Firebase Admin not initialized' }, origin);

  // ── Verify caller ──
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!idToken) return json(401, { error: 'Missing Authorization bearer token' }, origin);

  let callerUid, callerEmail;
  try {
    const decoded = await a.auth().verifyIdToken(idToken);
    callerUid = decoded.uid;
    callerEmail = decoded.email || '';
  } catch (e) {
    console.warn('verifyIdToken failed:', e.message);
    return json(401, { error: 'Invalid ID token' }, origin);
  }

  // ── Parse body ──
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON body' }, origin); }

  const examId     = String(body.examId     || '').trim();
  const questionId = String(body.questionId || '').trim();
  const title      = String(body.title      || '').trim() || `Lecturer upload Q${questionId}`;
  if (!examId || !questionId) {
    return json(400, { error: 'examId and questionId are required' }, origin);
  }

  // ── Authorize: caller must be admin OR an assigned lecturer on this exam ──
  const db = a.firestore();
  let callerRole = 'student';
  try {
    const userSnap = await db.collection('users').doc(callerUid).get();
    callerRole = userSnap.exists ? (userSnap.data().role || 'student') : 'student';
  } catch (e) {
    console.error('user role lookup failed:', e);
    return json(500, { error: 'Role lookup failed' }, origin);
  }
  const isAdmin    = callerRole === 'admin';
  const isLecturer = callerRole === 'instructor' || callerRole === 'מרצה';
  if (!isAdmin && !isLecturer) {
    return json(403, { error: 'Forbidden: lecturer or admin role required' }, origin);
  }

  if (!isAdmin) {
    // Verify lecturer is assigned to this exam
    let assigned = [];
    try {
      const examSnap = await db.collection('exams').doc(examId).get();
      if (!examSnap.exists) return json(404, { error: 'Exam not found' }, origin);
      assigned = Array.isArray(examSnap.data().assignedLecturers) ? examSnap.data().assignedLecturers : [];
    } catch (e) {
      console.error('exam lookup failed:', e);
      return json(500, { error: 'Exam lookup failed' }, origin);
    }
    if (!assigned.includes(callerUid)) {
      return json(403, { error: 'Forbidden: not assigned to this exam' }, origin);
    }
  }

  // ── Create empty Bunny video shell ──
  let videoGuid;
  try {
    videoGuid = await bunnyCreateVideo({ libraryId, apiKey, title });
  } catch (e) {
    console.error('bunnyCreateVideo failed:', e.message);
    return json(502, { error: 'Failed to create Bunny video: ' + e.message }, origin);
  }

  // ── Compute TUS authorization signature ──
  // Bunny TUS spec: SHA256( libraryId + apiKey + expirationTime + videoGuid )
  const authorizationExpire = Math.floor(Date.now() / 1000) + UPLOAD_EXPIRY_SECONDS;
  const authorizationSignature = crypto
    .createHash('sha256')
    .update(`${libraryId}${apiKey}${authorizationExpire}${videoGuid}`)
    .digest('hex');

  // ── Pre-create a "draft" submission so we can correlate later ──
  // (Lecturer will call -submit after upload completes to fill in notes/chapters
  //  and flip status to 'pending'. If they abandon, we keep status 'draft' and
  //  reports-cleanup can prune it later.)
  try {
    await db.collection('video_submissions').doc(videoGuid).set({
      examId,
      questionId,
      libraryId: String(libraryId),
      videoGuid,
      uploadedByUid:   callerUid,
      uploadedByEmail: callerEmail,
      status:          'draft',
      createdAt:       admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.error('draft submission write failed:', e);
    // Non-fatal: lecturer can still upload; submit step will overwrite.
  }

  return json(200, {
    videoGuid,
    libraryId: String(libraryId),
    authorizationSignature,
    authorizationExpire,
    tusEndpoint: BUNNY_TUS_ENDPOINT,
  }, origin);
};
