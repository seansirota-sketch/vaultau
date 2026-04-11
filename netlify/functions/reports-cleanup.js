const admin = require('firebase-admin');

const DAY_MS = 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * DAY_MS;
const ONE_EIGHTY_DAYS_MS = 180 * DAY_MS;

function getHeader(event, name) {
  const headers = event?.headers || {};
  const target = String(name || '').toLowerCase();
  for (const key of Object.keys(headers)) {
    if (String(key).toLowerCase() === target) return headers[key];
  }
  return '';
}

function isAuthorizedInvocation(event) {
  const eventType = String(getHeader(event, 'x-netlify-event') || '').toLowerCase();
  if (eventType === 'schedule') return true;

  const manualToken = process.env.REPORTS_CLEANUP_TOKEN;
  if (!manualToken) return false;

  const authHeader = String(getHeader(event, 'authorization') || '');
  return authHeader === `Bearer ${manualToken}`;
}

function getAdmin() {
  if (admin.apps.length) return admin;

  const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!sa) throw new Error('missing_firebase_service_account');

  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(sa)),
  });
  return admin;
}

async function deleteDocsByQuery(db, query) {
  const snap = await query.get();
  if (snap.empty) return 0;

  let deleted = 0;
  let batch = db.batch();
  let count = 0;

  for (const doc of snap.docs) {
    batch.delete(doc.ref);
    count++;
    deleted++;

    if (count >= 450) {
      await batch.commit();
      batch = db.batch();
      count = 0;
    }
  }

  if (count > 0) await batch.commit();
  return deleted;
}

exports.handler = async (event) => {
  try {
    if (!isAuthorizedInvocation(event || {})) {
      return {
        statusCode: 401,
        body: JSON.stringify({ ok: false, error: 'unauthorized_cleanup_invocation' }),
      };
    }

    const firebaseAdmin = getAdmin();
    const db = firebaseAdmin.firestore();

    const now = Date.now();
    const cutoff30 = firebaseAdmin.firestore.Timestamp.fromMillis(now - THIRTY_DAYS_MS);
    const cutoff180 = firebaseAdmin.firestore.Timestamp.fromMillis(now - ONE_EIGHTY_DAYS_MS);

    // 1) Purge reports where both sides deleted and 30 days passed.
    const dualDeletedQuery = db.collection('reports')
      .where('bothDeletedAt', '<=', cutoff30)
      .limit(2000);

    // 2) Purge closed reports older than 180 days.
    const closedOldQuery = db.collection('reports')
      .where('status', '==', 'closed')
      .where('closedAt', '<=', cutoff180)
      .limit(2000);

    // 3) Purge unanswered reports older than 180 days.
    // "unanswered" = no adminResponseAt, and still open.
    const openOldQuery = db.collection('reports')
      .where('status', '==', 'open')
      .where('createdAt', '<=', cutoff180)
      .limit(2000);

    const deletedDual = await deleteDocsByQuery(db, dualDeletedQuery);
    const deletedClosed = await deleteDocsByQuery(db, closedOldQuery);

    const openOldSnap = await openOldQuery.get();
    let deletedUnanswered = 0;
    if (!openOldSnap.empty) {
      let batch = db.batch();
      let count = 0;
      for (const doc of openOldSnap.docs) {
        const data = doc.data() || {};
        if (data.adminResponseAt) continue;

        batch.delete(doc.ref);
        count++;
        deletedUnanswered++;

        if (count >= 450) {
          await batch.commit();
          batch = db.batch();
          count = 0;
        }
      }
      if (count > 0) await batch.commit();
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        deletedDual,
        deletedClosed,
        deletedUnanswered,
      }),
    };
  } catch (err) {
    console.error('reports-cleanup failed:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: err.message || 'cleanup_failed' }),
    };
  }
};
