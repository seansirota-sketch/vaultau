/* ============================================================
   netlify/functions/verify-email-code.js
   מאמת קוד אימות שנשלח למייל
   ============================================================

   Environment Variables (same as send-verification-email):
     VERIFICATION_SECRET — מפתח סודי ליצירת HMAC
   ============================================================ */

const crypto = require('crypto');

/* ── CORS ── */
const ALLOWED_ORIGINS = [
  'https://vaultau.netlify.app',
  'http://localhost:8888',
];

function corsHeaders(event) {
  const origin = (event.headers || {}).origin || '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

/* ── Rate limiting (in-memory, resets on cold start) ── */
const rateMap = new Map();
const RATE_LIMIT     = 5;       // max attempts per window
const RATE_WINDOW_MS = 600000;  // 10 minutes

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateMap.get(ip);
  if (!entry || now - entry.start > RATE_WINDOW_MS) {
    rateMap.set(ip, { start: now, count: 1 });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT;
}

/* ── Verify HMAC token ── */
function verifyToken(email, code, expiresAt, token, secret) {
  const data = `${email}:${code}:${expiresAt}`;
  const expected = crypto.createHmac('sha256', secret).update(data).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token));
}

/* ── Main handler ── */
exports.handler = async (event) => {

  const cors = corsHeaders(event);

  /* ── Preflight (CORS) ── */
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors, body: '' };
  }

  /* ── Method guard ── */
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: cors,
      body: JSON.stringify({ error: 'Method Not Allowed' }),
    };
  }

  /* ── Rate limit ── */
  const ip = (event.headers['x-forwarded-for'] || event.headers['client-ip'] || 'unknown').split(',')[0].trim();
  if (isRateLimited(ip)) {
    return {
      statusCode: 429,
      headers: { ...cors, 'Retry-After': '600' },
      body: JSON.stringify({ error: 'יותר מדי ניסיונות — נסה שוב מאוחר יותר' }),
    };
  }

  /* ── Env vars guard ── */
  const secret = process.env.VERIFICATION_SECRET;
  if (!secret) {
    console.error('Missing env var: VERIFICATION_SECRET');
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: 'Server misconfiguration' }),
    };
  }

  /* ── Parse body ── */
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers: cors,
      body: JSON.stringify({ error: 'Invalid JSON body' }),
    };
  }

  const email     = (body.email || '').toLowerCase().trim();
  const code      = (body.code  || '').trim();
  const token     = (body.token || '').trim();
  const expiresAt = body.expiresAt;

  /* ── Validate input ── */
  if (!email || !code || !token || !expiresAt) {
    return {
      statusCode: 400,
      headers: cors,
      body: JSON.stringify({ error: 'Missing required fields' }),
    };
  }

  /* ── Check expiration ── */
  if (Date.now() > expiresAt) {
    return {
      statusCode: 400,
      headers: cors,
      body: JSON.stringify({ error: 'קוד האימות פג תוקף. נא לבקש קוד חדש.', expired: true }),
    };
  }

  /* ── Verify HMAC ── */
  try {
    const valid = verifyToken(email, code, expiresAt, token, secret);
    if (!valid) {
      return {
        statusCode: 400,
        headers: cors,
        body: JSON.stringify({ error: 'קוד אימות שגוי. נסה שוב.' }),
      };
    }
  } catch (err) {
    return {
      statusCode: 400,
      headers: cors,
      body: JSON.stringify({ error: 'קוד אימות שגוי. נסה שוב.' }),
    };
  }

  /* ── Success ── */
  return {
    statusCode: 200,
    headers: { ...cors, 'Content-Type': 'application/json' },
    body: JSON.stringify({ success: true, verified: true }),
  };
};
