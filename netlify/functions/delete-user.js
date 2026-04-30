/* ============================================================
   netlify/functions/delete-user.js
   Hard-delete a user: Firestore user docs + Firebase Auth account.

   Caller MUST be an authenticated admin (verified via ID token
   + role check in the corresponding users/{uid} doc).

   Environment Variables:
     FIREBASE_SERVICE_ACCOUNT — JSON string of a Firebase service account key
   ============================================================ */

const admin = require('firebase-admin');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function getAdmin() {
  if (admin.apps.length) return admin;
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!sa) return null;
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(sa)),
  });
  return admin;
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { ...CORS, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method Not Allowed' });
  }

  const a = getAdmin();
  if (!a) {
    console.error('Missing env var: FIREBASE_SERVICE_ACCOUNT');
    return json(500, { error: 'Server misconfiguration' });
  }

  // ── Verify caller's ID token ──
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!idToken) return json(401, { error: 'Missing Authorization bearer token' });

  let callerUid;
  try {
    const decoded = await a.auth().verifyIdToken(idToken);
    callerUid = decoded.uid;
  } catch (e) {
    console.warn('verifyIdToken failed:', e.message);
    return json(401, { error: 'Invalid ID token' });
  }

  // ── Confirm caller is admin (server-side role check from Firestore) ──
  const db = a.firestore();
  let callerRole;
  try {
    const callerSnap = await db.collection('users').doc(callerUid).get();
    callerRole = callerSnap.exists ? (callerSnap.data().role || 'student') : 'student';
  } catch (e) {
    console.error('caller role lookup failed:', e);
    return json(500, { error: 'Role lookup failed' });
  }
  if (callerRole !== 'admin') {
    return json(403, { error: 'Forbidden: admin role required' });
  }

  // ── Parse body ──
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON body' }); }

  const targetUid = (body.uid || '').trim();
  const targetEmail = (body.email || '').toLowerCase().trim();
  const extraDocIds = Array.isArray(body.extraDocIds) ? body.extraDocIds : [];

  if (!targetUid && !targetEmail && extraDocIds.length === 0) {
    return json(400, { error: 'Must provide uid, email, or extraDocIds' });
  }

  // ── Self-delete guard ──
  if (targetUid && targetUid === callerUid) {
    return json(400, { error: 'You cannot delete your own account from here' });
  }

  // ── Collect all Firestore user doc IDs to delete ──
  const docIdsToDelete = new Set(extraDocIds.filter(Boolean));
  if (targetUid) docIdsToDelete.add(targetUid);

  // Find all docs matching the email (covers duplicates)
  if (targetEmail) {
    try {
      const dupSnap = await db.collection('users').where('email', '==', targetEmail).get();
      dupSnap.forEach(d => docIdsToDelete.add(d.id));
    } catch (e) {
      console.warn('email duplicate lookup failed:', e.message);
    }
  }

  // Also include any doc whose `uid` field matches targetUid (legacy docs with random IDs)
  if (targetUid) {
    try {
      const uidSnap = await db.collection('users').where('uid', '==', targetUid).get();
      uidSnap.forEach(d => docIdsToDelete.add(d.id));
    } catch (e) {
      console.warn('uid-field lookup failed:', e.message);
    }
  }

  // Don't allow caller to nuke their own doc via duplicates either
  docIdsToDelete.delete(callerUid);

  // ── Delete Firestore docs in batches (with subcollections) ──
  let firestoreDeleted = 0;
  const docDeleteErrors = [];
  for (const id of docIdsToDelete) {
    try {
      // recursiveDelete handles known subcollections (ai_tasks, user_grades)
      await a.firestore().recursiveDelete(db.collection('users').doc(id));
      firestoreDeleted++;
    } catch (e) {
      console.error(`recursiveDelete users/${id} failed:`, e.message);
      docDeleteErrors.push({ id, error: e.message });
    }
  }

  // ── Delete Firebase Auth account ──
  let authDeleted = false;
  let authError = null;

  // Resolve UID from email if not provided
  let uidForAuth = targetUid;
  if (!uidForAuth && targetEmail) {
    try {
      const userRecord = await a.auth().getUserByEmail(targetEmail);
      uidForAuth = userRecord.uid;
    } catch (e) {
      if (e.code !== 'auth/user-not-found') {
        console.warn('getUserByEmail failed:', e.message);
      }
    }
  }

  if (uidForAuth && uidForAuth !== callerUid) {
    try {
      await a.auth().deleteUser(uidForAuth);
      authDeleted = true;
    } catch (e) {
      if (e.code === 'auth/user-not-found') {
        authDeleted = false; // already gone — not an error
      } else {
        console.error('auth deleteUser failed:', e.message);
        authError = e.message;
      }
    }
  }

  return json(200, {
    ok: docDeleteErrors.length === 0 && !authError,
    firestoreDeleted,
    authDeleted,
    authError,
    docDeleteErrors,
    deletedDocIds: [...docIdsToDelete],
  });
};
