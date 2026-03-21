/* ============================================================
   netlify/functions/send-reset-password-email.js
   שולח מייל עם לינק לאיפוס סיסמה באמצעות Firebase Admin + SendGrid
   ============================================================

   Environment Variables (Netlify → Site Settings → Environment Variables):
     SENDGRID_API_KEY         — המפתח הסודי מ-SendGrid
     SENDER_EMAIL             — כתובת השולח המאומתת ב-SendGrid
     FIREBASE_SERVICE_ACCOUNT — JSON string של service account key מ-Firebase
     SITE_URL                 — כתובת האתר (לדוגמה https://vaultau.netlify.app)
   ============================================================ */

const sgMail = require('@sendgrid/mail');
const admin  = require('firebase-admin');

/* ── CORS headers ── */
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/* ── Rate limiting (in-memory, resets on cold start) ── */
const rateMap = new Map();
const RATE_LIMIT = 3;           // max requests
const RATE_WINDOW_MS = 600000;  // per 10 minutes

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

/* ── Lazy-init Firebase Admin (singleton) ── */
function getAdmin() {
  if (admin.apps.length) return admin;
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!sa) return null;
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(sa)),
  });
  return admin;
}

/* ── HTML email template ── */
function buildResetHtml({ resetUrl, email }) {
  const displayName = email.split('@')[0];
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>איפוס סיסמה — VaultAU</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:'Segoe UI',Arial,sans-serif;direction:rtl">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:40px 20px">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0"
               style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;
                      overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">

          <tr>
            <td style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);
                        padding:40px 48px;text-align:center">
              <div style="font-size:42px;margin-bottom:12px">🔑</div>
              <h1 style="margin:0;color:#ffffff;font-size:28px;font-weight:700;">VaultAU</h1>
              <p style="margin:8px 0 0;color:rgba(255,255,255,.8);font-size:16px">איפוס סיסמה</p>
            </td>
          </tr>

          <tr>
            <td style="padding:40px 48px">
              <h2 style="margin:0 0 16px;color:#1f2937;font-size:22px;">היי ${displayName},</h2>

              <p style="margin:0 0 24px;color:#4b5563;font-size:16px;line-height:1.7">
                קיבלנו בקשה לאיפוס הסיסמה שלך ב-<strong>VaultAU</strong>.<br>
                לחץ על הכפתור למטה כדי לבחור סיסמה חדשה:
              </p>

              <div style="text-align:center;margin:0 0 28px">
                <a href="${resetUrl}"
                   style="display:inline-block;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);
                          color:#ffffff;text-decoration:none;padding:14px 36px;border-radius:8px;
                          font-size:17px;font-weight:700;letter-spacing:.5px">
                  איפוס סיסמה ←
                </a>
              </div>

              <div style="background:#fefce8;border-right:4px solid #eab308;padding:15px;
                          margin-bottom:25px;color:#854d0e;font-size:14px;line-height:1.7">
                <strong>שים לב:</strong> הלינק תקף לשעה אחת בלבד.
                <br>אם לא ביקשת איפוס סיסמה, ניתן להתעלם ממייל זה.
              </div>

              <p style="margin:0 0 12px;color:#9ca3af;font-size:13px;line-height:1.6;
                        border-top:1px solid #f3f4f6;padding-top:20px">
                אם הכפתור לא עובד, העתק את הלינק הבא לדפדפן:
              </p>
              <p style="margin:0;word-break:break-all;color:#667eea;font-size:13px" dir="ltr">
                ${resetUrl}
              </p>

              <p style="margin:16px 0 0;color:#9ca3af;font-size:13px;line-height:1.6">
                נשלח אל: <span dir="ltr">${email}</span>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/* ── Plain-text fallback ── */
function buildResetText({ resetUrl, email }) {
  return `שלום,

קיבלנו בקשה לאיפוס הסיסמה שלך ב-VaultAU.
לחץ על הלינק הבא כדי לבחור סיסמה חדשה:

${resetUrl}

הלינק תקף לשעה אחת בלבד.
אם לא ביקשת איפוס סיסמה, ניתן להתעלם ממייל זה.

נשלח אל: ${email}`;
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

  /* ── Rate limit ── */
  const ip = (event.headers['x-forwarded-for'] || event.headers['client-ip'] || 'unknown').split(',')[0].trim();
  if (isRateLimited(ip)) {
    return {
      statusCode: 429,
      headers: { ...CORS, 'Retry-After': '600' },
      body: JSON.stringify({ error: 'יותר מדי בקשות — נסה שוב מאוחר יותר' }),
    };
  }

  /* ── Env vars guard ── */
  const apiKey      = process.env.SENDGRID_API_KEY;
  const senderEmail = process.env.SENDER_EMAIL;
  const siteUrl     = process.env.SITE_URL || 'https://vaultau.netlify.app';

  if (!apiKey || !senderEmail) {
    console.error('Missing env vars: SENDGRID_API_KEY or SENDER_EMAIL');
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: 'Server misconfiguration' }),
    };
  }

  const adminSdk = getAdmin();
  if (!adminSdk) {
    console.error('Missing env var: FIREBASE_SERVICE_ACCOUNT');
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

  const email = (body.email || '').toLowerCase().trim();

  if (!email) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ error: 'נא להזין כתובת אימייל' }),
    };
  }

  /* ── Generate reset link + send email ── */
  try {
    // Generate Firebase password reset link (includes oobCode)
    const firebaseLink = await adminSdk.auth().generatePasswordResetLink(email, {
      url: siteUrl,
    });

    // Extract the oobCode from Firebase's link and build our custom URL
    const linkUrl  = new URL(firebaseLink);
    const oobCode  = linkUrl.searchParams.get('oobCode');
    const resetUrl = `${siteUrl}/?mode=resetPassword&oobCode=${encodeURIComponent(oobCode)}`;

    // Send via SendGrid
    sgMail.setApiKey(apiKey);

    await sgMail.send({
      to:   email,
      from: { email: senderEmail, name: 'VaultAU' },
      subject: '🔑 איפוס סיסמה — VaultAU',
      text: buildResetText({ resetUrl, email }),
      html: buildResetHtml({ resetUrl, email }),
    });

    console.log(`Password reset email sent to ${email}`);
  } catch (err) {
    // Log the real error but ALWAYS return success to prevent email enumeration
    console.error('Password reset error (suppressed):', err.code || err.message);
  }

  // Always return success — don't reveal whether the email exists
  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ success: true }),
  };
};
