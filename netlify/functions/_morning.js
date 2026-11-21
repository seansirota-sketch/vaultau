'use strict';

const crypto = require('crypto');
const admin = require('firebase-admin');

const DEFAULT_PAYMENT_DURATION_DAYS = 365;
const SUPPORTED_CURRENCIES = new Set(['ILS', 'USD', 'EUR', 'GBP']);

function getFirebaseAdmin() {
  if (admin.apps.length) return admin;
  if (process.env.FIREBASE_AUTH_EMULATOR_HOST || process.env.FIRESTORE_EMULATOR_HOST) {
    admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'eaxmbank' });
    return admin;
  }

  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!serviceAccount) return null;
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(serviceAccount)) });
  return admin;
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function getMorningConfig(env = process.env) {
  const apiBaseUrl = normalizeBaseUrl(env.MORNING_API_BASE_URL);
  const clientId = String(env.MORNING_API_KEY || '').trim();
  const clientSecret = String(env.MORNING_API_SECRET || '').trim();

  if (!apiBaseUrl || !clientId || !clientSecret) {
    throw new Error('Morning API is not configured');
  }

  let tokenUrl = String(env.MORNING_TOKEN_URL || '').trim();
  if (!tokenUrl) {
    tokenUrl = apiBaseUrl.includes('sandbox')
      ? 'https://api.sandbox.morning.dev/idp/v1/oauth/token'
      : 'https://api.morning.co/idp/v1/oauth/token';
  }

  return { apiBaseUrl, clientId, clientSecret, tokenUrl };
}

function normalizeCoursePayment(course) {
  const raw = course && course.accessSettings && course.accessSettings.payment;
  if (!raw || raw.enabled !== true) return null;

  const amount = Number(raw.price);
  const currency = String(raw.currency || 'ILS').toUpperCase();
  const durationDays = Math.floor(Number(raw.durationDays || DEFAULT_PAYMENT_DURATION_DAYS));

  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (!SUPPORTED_CURRENCIES.has(currency)) return null;
  if (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 3650) return null;

  return { amount: Math.round(amount * 100) / 100, currency, durationDays };
}

function createMorningCustomMetadata({ purchaseId, userId, courseId }) {
  return JSON.stringify({ purchaseId, userId, courseId });
}

function parseMorningCustomMetadata(raw) {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const purchaseId = String(value.purchaseId || '').trim();
  const userId = String(value.userId || value.uid || '').trim();
  const courseId = String(value.courseId || '').trim();
  if (!purchaseId || !userId || !courseId) return null;
  return { purchaseId, userId, courseId };
}

function rawEventBody(event) {
  const body = String(event.body || '');
  return event.isBase64Encoded ? Buffer.from(body, 'base64') : Buffer.from(body, 'utf8');
}

function verifyWebhookSignature(rawBody, signature, secret) {
  const supplied = String(signature || '').trim();
  const signingSecret = String(secret || '');
  if (!supplied || !signingSecret || !/^[0-9a-f]{64}$/i.test(supplied)) return false;

  const expected = crypto.createHmac('sha256', signingSecret).update(rawBody).digest('hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  const suppliedBuffer = Buffer.from(supplied, 'hex');
  return expectedBuffer.length === suppliedBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function paymentTotalsMatch(receivedTotal, expectedAmount) {
  const received = Number(receivedTotal);
  const expected = Number(expectedAmount);
  return Number.isFinite(received) && Number.isFinite(expected)
    && Math.round(received * 100) === Math.round(expected * 100);
}

async function getMorningAccessToken(config, fetchImpl = fetch) {
  const response = await fetchImpl(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.accessToken) {
    const details = payload.error_description || payload.error || `HTTP ${response.status}`;
    throw new Error('Morning authentication failed: ' + details);
  }
  return payload.accessToken;
}

async function createMorningPaymentForm(config, accessToken, payload, fetchImpl = fetch) {
  const response = await fetchImpl(`${config.apiBaseUrl}/payments/form`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.errorCode !== 0 || !result.url) {
    const details = result.errorDescription || result.error || `HTTP ${response.status}`;
    throw new Error('Morning checkout creation failed: ' + details);
  }
  return result.url;
}

module.exports = {
  createMorningCustomMetadata,
  createMorningPaymentForm,
  getFirebaseAdmin,
  getMorningAccessToken,
  getMorningConfig,
  normalizeCoursePayment,
  parseMorningCustomMetadata,
  paymentTotalsMatch,
  rawEventBody,
  verifyWebhookSignature,
};
