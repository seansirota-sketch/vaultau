/* ============================================================
   netlify/functions/force-password-reset.js
   Admin-only: mark a user so they MUST change their password
   on the next login. No email is sent — the client UI blocks
   the user until they pick a new password.

   Steps performed:
     1. Verify caller's ID token + admin role from Firestore.
     2. Resolve target Firebase Auth user (by uid or email).
     3. Revoke all refresh tokens (kills active sessions on next refresh).
     4. Set users/{uid}.mustChangePassword = true (+ audit fields).

   Environment Variables:
     FIREBASE_SERVICE_ACCOUNT — JSON string of a Firebase service account key
   ============================================================ */

const admin = require('firebase-admin');

const ALLOWED_ORIGINS = (process.env.ADMIN_FUNCTION_ORIGINS ||
  'https://vaultau.netlify.app,http://localhost:8888,http://localhost:5173,http://127.0.0.1:8888'
).split(',').map(s => s.trim()).filter(Boolean);

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin':  allow,
    'Vary':                         'Origin',
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

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(origin), body: '' };
  if (event.httpMethod !== 'POST')   return json(405, { error: 'Method Not Allowed' }, origin);

  const a = getAdmin();
  if (!a) return json(500, { error: 'Server misconfiguration (FIREBASE_SERVICE_ACCOUNT)' }, origin);

  // ── Verify caller is admin ──
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
    const callerSnap = await db.collection('users').doc(callerUid).get();
    if (callerSnap.exists) callerRole = callerSnap.data().role || 'student';
  } catch (e) {
    return json(500, { error: 'Role lookup failed' }, origin);
  }
  if (callerRole !== 'admin') return json(403, { error: 'Forbidden: admin role required' }, origin);

  // ── Parse body ──
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON body' }, origin); }

  const targetEmailRaw = (body.email || '').toLowerCase().trim();
  const targetUidRaw   = (body.uid   || '').trim();

  if (!targetEmailRaw && !targetUidRaw) {
    return json(400, { error: 'Must provide email or uid' }, origin);
  }

  // ── Resolve target user ──
  let userRecord;
  try {
    if (targetUidRaw) {
      userRecord = await a.auth().getUser(targetUidRaw);
    } else {
      userRecord = await a.auth().getUserByEmail(targetEmailRaw);
    }
  } catch (e) {
    if (e.code === 'auth/user-not-found') {
      return json(404, { error: 'User not found in Firebase Auth' }, origin);
    }
    console.error('user lookup failed:', e);
    return json(500, { error: 'User lookup failed' }, origin);
  }

  const targetUid = userRecord.uid;

  if (targetUid === callerUid) {
    return json(400, { error: 'Use the standard reset flow for your own account' }, origin);
  }

  // ── Revoke refresh tokens (active sessions die on next token refresh) ──
  try {
    await a.auth().revokeRefreshTokens(targetUid);
  } catch (e) {
    console.warn('revokeRefreshTokens failed:', e.message);
  }

  // ── Flag the user doc so the login UI forces a password change ──
  try {
    await db.collection('users').doc(targetUid).set({
      mustChangePassword: true,
      passwordResetForcedAt: admin.firestore.FieldValue.serverTimestamp(),
      passwordResetForcedBy: callerUid,
    }, { merge: true });
  } catch (e) {
    console.error('flag mustChangePassword failed:', e);
    return json(500, { error: 'Failed to flag user: ' + e.message }, origin);
  }

  // ── Audit log (best-effort) ──
  try {
    await db.collection('audit_logs').add({
      action: 'admin.forcePasswordReset',
      callerUid,
      targetUid,
      targetEmail: userRecord.email || null,
      ts: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.warn('audit log write failed:', e.message);
  }

  return json(200, {
    ok: true,
    targetUid,
    targetEmail: userRecord.email || null,
    revokedRefreshTokens: true,
    flagged: true,
  }, origin);
};
