'use strict';

const {
  getFirebaseAdmin,
  parseMorningCustomMetadata,
  paymentTotalsMatch,
  rawEventBody,
  verifyWebhookSignature,
} = require('./_morning.js');

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const secret = String(process.env.MORNING_WEBHOOK_SECRET || '');
  if (!secret) return json(500, { error: 'Server misconfiguration: webhook secret missing' });

  const rawBody = rawEventBody(event);
  const signature = event.headers['x-webhook-signature'] || event.headers['X-Webhook-Signature'] || '';
  if (!verifyWebhookSignature(rawBody, signature, secret)) {
    console.warn('morning-webhook invalid signature');
    return json(401, { error: 'Invalid webhook signature' });
  }

  const topic = event.headers['x-webhook-topic'] || event.headers['X-Webhook-Topic'] || '';
  if (topic !== 'payment/received') {
    return json(200, { ok: true, ignored: true, reason: 'unsupported_topic' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const metadata = parseMorningCustomMetadata(payload.custom);
  if (!metadata) {
    console.warn('morning-webhook signed payment without VaultAU metadata');
    return json(200, { ok: true, ignored: true, reason: 'missing_metadata' });
  }

  const firebaseAdmin = getFirebaseAdmin();
  if (!firebaseAdmin) {
    return json(500, { error: 'Server misconfiguration: Firebase Admin not initialized' });
  }
  const db = firebaseAdmin.firestore();
  const sessionRef = db.collection('payment_sessions').doc(metadata.purchaseId);

  try {
    const result = await db.runTransaction(async transaction => {
      const sessionSnap = await transaction.get(sessionRef);
      if (!sessionSnap.exists) return { ignored: 'unknown_purchase' };

      const session = sessionSnap.data() || {};
      if (session.status === 'completed') return { ignored: 'already_processed' };
      if (session.status !== 'pending') return { ignored: 'invalid_session_status' };
      if (session.userId !== metadata.userId || session.courseId !== metadata.courseId) {
        throw new Error('Payment metadata does not match checkout session');
      }
      if (!paymentTotalsMatch(payload.total, session.amount)) {
        throw new Error('Payment total does not match checkout amount');
      }

      const userRef = db.collection('users').doc(session.userId);
      const userSnap = await transaction.get(userRef);
      if (!userSnap.exists) throw new Error('Purchased course user no longer exists');
      const now = Date.now();
      const expiresAt = firebaseAdmin.firestore.Timestamp.fromMillis(
        now + Number(session.accessDurationDays) * 24 * 60 * 60 * 1000
      );

      transaction.set(userRef, {
        courseAccess: {
          [session.courseId]: {
            hasAccess: true,
            purchasedAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
            expiresAt,
            purchaseId: session.purchaseId,
            provider: 'morning',
            amount: session.amount,
            currency: session.currency,
          },
        },
      }, { merge: true });
      transaction.update(sessionRef, {
        status: 'completed',
        providerPaymentId: String(payload.id || ''),
        payer: payload.payer || null,
        providerAmount: Number(payload.total),
        completedAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
      });
      return { completed: true, courseId: session.courseId, userId: session.userId };
    });

    return json(200, { ok: true, ...result });
  } catch (error) {
    console.error('morning-webhook processing failed:', error);
    return json(422, { error: error.message });
  }
};
