/* ============================================================
   netlify/functions/send-verification-email.js
   שולח קוד אימות 6 ספרות למייל אוניברסיטאי בזמן הרשמה
   ============================================================

   Environment Variables (Netlify → Site Settings → Environment Variables):
     SENDGRID_API_KEY   — המפתח הסודי מ-SendGrid
     SENDER_EMAIL       — כתובת השולח המאומתת ב-SendGrid
     VERIFICATION_SECRET — מפתח סודי ליצירת HMAC (מחרוזת כלשהי)
   ============================================================ */

const sgMail = require('@sendgrid/mail');
const crypto = require('crypto');

/* ── CORS headers ── */
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const ALLOWED_DOMAIN = 'mail.tau.ac.il';
const CODE_EXPIRY_MINUTES = 10;

/* ── HTML email template ── */
function buildVerificationHtml({ code, email }) {
  const displayName = email.split('@')[0];
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>קוד אימות — VaultAU</title>
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
              <div style="font-size:42px;margin-bottom:12px">🔐</div>
              <h1 style="margin:0;color:#ffffff;font-size:28px;font-weight:700;">VaultAU</h1>
              <p style="margin:8px 0 0;color:rgba(255,255,255,.8);font-size:16px">אימות כתובת המייל</p>
            </td>
          </tr>

          <tr>
            <td style="padding:40px 48px">
              <h2 style="margin:0 0 16px;color:#1f2937;font-size:22px;">היי ${displayName},</h2>
              
              <p style="margin:0 0 24px;color:#4b5563;font-size:16px;line-height:1.7">
                הקוד שלך לאימות הרשמה ל-<strong>VaultAU</strong>:
              </p>

              <div style="text-align:center;margin:0 0 28px">
                <div style="display:inline-block;background:#f0f4ff;border:2px dashed #667eea;
                            border-radius:12px;padding:20px 40px;font-size:36px;
                            font-weight:700;letter-spacing:8px;color:#4338ca;
                            font-family:'Courier New',monospace" dir="ltr">
                  ${code}
                </div>
              </div>

              <div style="background:#fefce8;border-right:4px solid #eab308;padding:15px;
                          margin-bottom:25px;color:#854d0e;font-size:14px;line-height:1.7">
                <strong>שים לב:</strong> הקוד תקף ל-${CODE_EXPIRY_MINUTES} דקות בלבד.
                <br>אם לא ביקשת הרשמה ל-VaultAU, ניתן להתעלם ממייל זה.
              </div>

              <p style="margin:0;color:#9ca3af;font-size:13px;line-height:1.6;
                        border-top:1px solid #f3f4f6;padding-top:20px">
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
function buildVerificationText({ code, email }) {
  return `שלום,

קוד האימות שלך להרשמה ל-VaultAU הוא: ${code}

הקוד תקף ל-${CODE_EXPIRY_MINUTES} דקות.
אם לא ביקשת הרשמה, ניתן להתעלם ממייל זה.

נשלח אל: ${email}`;
}

/* ── Generate HMAC token ── */
function generateToken(email, code, expiresAt, secret) {
  const data = `${email}:${code}:${expiresAt}`;
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
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
  const apiKey       = process.env.SENDGRID_API_KEY;
  const senderEmail  = process.env.SENDER_EMAIL;
  const secret       = process.env.VERIFICATION_SECRET;

  if (!apiKey || !senderEmail || !secret) {
    console.error('Missing env vars: SENDGRID_API_KEY, SENDER_EMAIL, or VERIFICATION_SECRET');
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: 'Server misconfiguration — env vars missing' }),
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

  /* ── Validate email domain ── */
  if (!email || !email.endsWith('@' + ALLOWED_DOMAIN)) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ error: `ניתן להירשם רק עם מייל @${ALLOWED_DOMAIN}` }),
    };
  }

  /* ── Generate 6-digit code ── */
  const code = String(crypto.randomInt(100000, 999999));
  const expiresAt = Date.now() + CODE_EXPIRY_MINUTES * 60 * 1000;
  const token = generateToken(email, code, expiresAt, secret);

  /* ── Send via SendGrid ── */
  sgMail.setApiKey(apiKey);

  const msg = {
    to:   email,
    from: {
      email: senderEmail,
      name:  'VaultAU',
    },
    subject: `🔐 קוד אימות להרשמה ל-VaultAU: ${code}`,
    text: buildVerificationText({ code, email }),
    html: buildVerificationHtml({ code, email }),
  };

  try {
    await sgMail.send(msg);
    console.log(`Verification email sent → ${email}`);
    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        token,
        expiresAt,
      }),
    };
  } catch (err) {
    const sgError = err.response?.body?.errors?.[0]?.message || err.message;
    console.error('SendGrid error:', sgError);
    return {
      statusCode: 502,
      headers: CORS,
      body: JSON.stringify({ error: 'Failed to send verification email', details: sgError }),
    };
  }
};
