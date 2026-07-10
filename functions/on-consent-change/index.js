'use strict';

/**
 * on-consent-change — Cloud Function (gen2, Node 20)
 *
 * Trigger : Firestore onWrite  users/{uid}
 * Purpose :
 *   (a) Mirror users/{uid}.analyticsConsent → custom auth claim
 *         consentT2 = { v: <termsVersion>, exp: <epochSec> } | null
 *       so security rules can validate Tier-2 writes without a per-write
 *       get() of the user document (fast path).
 *   (b) On revoke, hard-delete every telemetry_t2 doc for that uid
 *       (right-to-erasure).
 *   (c) Append an audit_log entry for every grant/revoke transition.
 *
 * Design: docs/architecture-telemetry-difficulty-admin.md §2.2, §4.2
 *
 * Existing consent shape in this repo:
 *   users/{uid}.analyticsConsent : boolean
 *   users/{uid}.consentDate      : timestamp | null
 *   users/{uid}.consentAuditLog  : array<{ status, at }>
 * We DO NOT change that shape — this function only reads it and writes
 * derived state (custom claim + audit_log + t2 purge).
 */

const functions = require('firebase-functions/v2/firestore');
const admin     = require('firebase-admin');

if (!admin.apps.length) admin.initializeApp();
const db   = admin.firestore();
const auth = admin.auth();

const CONSENT_TERMS_VERSION = process.env.CONSENT_TERMS_VERSION || '2026-01';
// Claim TTL: 30 days safety net. Client should force getIdToken(true) right
// after any grant/revoke so revocation is near-real-time.
const CLAIM_TTL_SEC = 30 * 24 * 60 * 60;

const T2_PURGE_BATCH = 400;

exports.onUserConsentChange = functions.onDocumentWritten(
  'users/{uid}',
  async (event) => {
    const uid = event.params.uid;

    const before = event.data && event.data.before ? event.data.before.data() : null;
    const after  = event.data && event.data.after  ? event.data.after.data()  : null;

    const prevConsent = before ? before.analyticsConsent === true : false;
    const nextConsent = after  ? after.analyticsConsent  === true : false;

    if (prevConsent === nextConsent && before && after) return;

    try {
      const user = await auth.getUser(uid);
      const existing = user.customClaims || {};
      const nextClaims = { ...existing };

      if (nextConsent) {
        nextClaims.consentT2 = {
          v:   CONSENT_TERMS_VERSION,
          exp: Math.floor(Date.now() / 1000) + CLAIM_TTL_SEC,
        };
      } else {
        delete nextClaims.consentT2;
      }
      await auth.setCustomUserClaims(uid, nextClaims);
    } catch (err) {
      if (err && err.code !== 'auth/user-not-found') {
        console.error('onUserConsentChange: setCustomUserClaims failed', uid, err);
        throw err;
      }
    }

    let purged = 0;
    if (prevConsent && !nextConsent) {
      purged = await purgeTier2ForUid(uid);
    }

    await db.collection('audit_log').add({
      actorUid:  uid,
      action:    nextConsent ? 'consent_grant' : 'consent_revoke',
      target:    `users/${uid}`,
      detail:    {
        prev: prevConsent,
        next: nextConsent,
        termsVersion: CONSENT_TERMS_VERSION,
        purgedTier2Docs: purged,
      },
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: new Date(Date.now() + 400 * 24 * 60 * 60 * 1000),
    });
  },
);

async function purgeTier2ForUid(uid) {
  let total = 0;
  // Requires composite index (uid, timestamp) — declared in firestore.indexes.json.
  while (true) {
    const snap = await db.collection('telemetry_t2')
      .where('uid', '==', uid)
      .limit(T2_PURGE_BATCH)
      .get();

    if (snap.empty) break;

    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    total += snap.size;

    if (snap.size < T2_PURGE_BATCH) break;
  }
  console.log(`onUserConsentChange: purged ${total} telemetry_t2 docs for uid=${uid}`);
  return total;
}
