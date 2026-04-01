/* ============================================================
   netlify/functions/verify-email-code.js
   מאמת קוד אימות שנשלח למייל
   ============================================================

   Environment Variables (same as send-verification-email):
     VERIFICATION_SECRET — מפתח סודי ליצירת HMAC
   ============================================================ */

const crypto = require('crypto');

/* ── CORS headers ── */
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/* ── Verify HMAC token ── */
function verifyToken(email, code, expiresAt, token, secret) {
  const data = `${email}:${code}:${expiresAt}`;
  const expected = crypto.createHmac('sha256', secret).update(data).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token));
}

/* ── Main handler ── */
exports.handler = async (event) => {

  /* ── Preflight (CORS) ── */
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  /* ── Method guard ── */
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: CORS,
      body: JSON.stringify({ error: 'Method Not Allowed' }),
    };
  }

  /* ── Env vars guard ── */
  const secret = process.env.VERIFICATION_SECRET;
  if (!secret) {
    console.error('Missing env var: VERIFICATION_SECRET');
    return {
      statusCode: 500,
      headers: CORS,
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
      headers: CORS,
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
      headers: CORS,
      body: JSON.stringify({ error: 'Missing required fields' }),
    };
  }

  /* ── Check expiration ── */
  if (Date.now() > expiresAt) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ error: 'קוד האימות פג תוקף. נא לבקש קוד חדש.', expired: true }),
    };
  }

  /* ── Verify HMAC ── */
  try {
    const valid = verifyToken(email, code, expiresAt, token, secret);
    if (!valid) {
      return {
        statusCode: 400,
        headers: CORS,
        body: JSON.stringify({ error: 'קוד אימות שגוי. נסה שוב.' }),
      };
    }
  } catch (err) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ error: 'קוד אימות שגוי. נסה שוב.' }),
    };
  }

  /* ── Success ── */
  return {
    statusCode: 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ success: true, verified: true }),
  };
};
