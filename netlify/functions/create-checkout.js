'use strict';

const crypto = require('crypto');
const {
  createMorningCustomMetadata,
  createMorningPaymentForm,
  getFirebaseAdmin,
  getMorningAccessToken,
  getMorningConfig,
  normalizeCoursePayment,
} = require('./_morning.js');

const ALLOWED_ORIGINS = (process.env.ADMIN_FUNCTION_ORIGINS ||
  'https://vaultau.netlify.app,http://localhost:8888,http://localhost:5173,http://127.0.0.1:8888'
).split(',').map(value => value.trim()).filter(Boolean);

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    Vary: 'Origin',
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

function getAppUrl(origin) {
  const configured = String(process.env.MORNING_APP_URL || '').trim();
  const candidate = configured || (ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
  const url = new URL(candidate);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('MORNING_APP_URL must use HTTPS');
  }
  return url.origin;
}

function returnUrl(appUrl, status, courseId, purchaseId) {
  const url = new URL(appUrl);
  url.searchParams.set('payment', status);
  url.searchParams.set('courseId', courseId);
  url.searchParams.set('purchaseId', purchaseId);
  return url.toString();
}

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(origin), body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' }, origin);
  if (origin && !ALLOWED_ORIGINS.includes(origin)) return json(403, { error: 'Origin is not allowed' }, origin);

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!idToken) return json(401, { error: 'Missing Authorization bearer token' }, origin);

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' }, origin);
  }

  const courseId = String(body.courseId || '').trim();
  if (!courseId) return json(400, { error: 'courseId is required' }, origin);
  if (body.termsAccepted !== true) {
    return json(400, { error: 'Terms of Use must be accepted' }, origin);
  }

  const firebaseAdmin = getFirebaseAdmin();
  if (!firebaseAdmin) {
    return json(500, { error: 'Server misconfiguration: Firebase Admin not initialized' }, origin);
  }

  let caller;
  try {
    caller = await firebaseAdmin.auth().verifyIdToken(idToken);
  } catch (error) {
    console.warn('create-checkout token verification failed:', error.message);
    return json(401, { error: 'Invalid ID token' }, origin);
  }

  const db = firebaseAdmin.firestore();
  let user;
  let course;
  try {
    const [userSnap, courseSnap] = await Promise.all([
      db.collection('users').doc(caller.uid).get(),
      db.collection('courses').doc(courseId).get(),
    ]);
    if (!userSnap.exists) return json(404, { error: 'User profile not found' }, origin);
    if (!courseSnap.exists) return json(404, { error: 'Course not found' }, origin);
    user = userSnap.data() || {};
    course = courseSnap.data() || {};
  } catch (error) {
    console.error('create-checkout lookup failed:', error);
    return json(500, { error: 'Checkout data lookup failed' }, origin);
  }

  if (user.acceptedTerms !== true) {
    return json(403, { error: 'Terms of Use have not been accepted' }, origin);
  }
  if (course.status !== 'published') {
    return json(409, { error: 'Course is not available for purchase' }, origin);
  }

  const payment = normalizeCoursePayment(course);
  if (!payment || course.accessSettings?.tier !== 'premium') {
    return json(409, { error: 'This course is not configured for online purchase' }, origin);
  }

  const activeEntitlement = user.courseAccess && user.courseAccess[courseId];
  const expiresAtMs = activeEntitlement && activeEntitlement.expiresAt && activeEntitlement.expiresAt.toMillis
    ? activeEntitlement.expiresAt.toMillis()
    : 0;
  if (activeEntitlement?.hasAccess === true && expiresAtMs > Date.now()) {
    return json(409, { error: 'Course access is already active', code: 'already_purchased' }, origin);
  }

  let morning;
  let appUrl;
  try {
    morning = getMorningConfig();
    appUrl = getAppUrl(origin);
  } catch (error) {
    console.error('create-checkout configuration failed:', error.message);
    return json(500, { error: error.message }, origin);
  }

  const purchaseId = crypto.randomUUID();
  const metadata = createMorningCustomMetadata({ purchaseId, userId: caller.uid, courseId });
  const buyerName = String(user.displayName || caller.name || caller.email || '').trim();
  const buyerEmail = String(caller.email || user.email || '').trim();
  const courseName = String(course.name || courseId).trim();
  const sessionRef = db.collection('payment_sessions').doc(purchaseId);

  try {
    await sessionRef.set({
      purchaseId,
      provider: 'morning',
      userId: caller.uid,
      courseId,
      status: 'pending',
      amount: payment.amount,
      currency: payment.currency,
      accessDurationDays: payment.durationDays,
      termsAcceptedAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
      custom: metadata,
      createdAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (error) {
    console.error('create-checkout session write failed:', error);
    return json(500, { error: 'Failed to initialize checkout' }, origin);
  }

  try {
    const accessToken = await getMorningAccessToken(morning);
    const checkoutUrl = await createMorningPaymentForm(morning, accessToken, {
      description: `VaultAU - ${courseName}`,
      type: 400,
      amount: payment.amount,
      currency: payment.currency,
      vatType: 0,
      lang: 'he',
      maxPayments: 1,
      client: {
        name: buyerName || buyerEmail,
        emails: buyerEmail ? [buyerEmail] : [],
        add: true,
      },
      income: [{
        catalogNum: courseId,
        description: courseName,
        quantity: 1,
        price: payment.amount,
        currency: payment.currency,
        vatType: 1,
      }],
      remarks: `VaultAU course purchase ${purchaseId}`,
      successUrl: returnUrl(appUrl, 'success', courseId, purchaseId),
      failureUrl: returnUrl(appUrl, 'failure', courseId, purchaseId),
      custom: metadata,
    });

    await sessionRef.update({
      checkoutCreatedAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
    });
    return json(200, {
      ok: true,
      checkoutUrl,
      purchaseId,
      amount: payment.amount,
      currency: payment.currency,
    }, origin);
  } catch (error) {
    console.error('create-checkout Morning request failed:', error);
    await sessionRef.update({
      status: 'failed',
      failureReason: error.message.slice(0, 500),
      failedAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
    return json(502, { error: error.message }, origin);
  }
};
