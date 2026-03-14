/* ============================================================
   netlify/functions/send-welcome-email.js
   שולח מייל ברכה לסטודנט שקיבל הרשאת גישה חדשה
   ============================================================

   ⚠️  אל תכניס את ה-API Key לקוד זה!
   הגדר ב-Netlify → Site Settings → Environment Variables:
     SENDGRID_API_KEY   — המפתח הסודי מ-SendGrid
     SENDER_EMAIL       — כתובת השולח המאומתת ב-SendGrid (למשל: noreply@vaultau.com)
     SITE_URL           — כתובת האתר (למשל: https://vaultau.netlify.app)
   ============================================================ */

const sgMail = require('@sendgrid/mail');

/* ── CORS headers ── */
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/* ── HTML email template ── */
function buildEmailHtml({ name, email }) {
  const displayName = name || email.split('@')[0];
  // הכתובת המדויקת שביקשת
  const loginUrl = 'https://vaultau.netlify.app/';

  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>אישור גישה ל-VaultAU</title>
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
              <div style="font-size:42px;margin-bottom:12px">🎓</div>
              <h1 style="margin:0;color:#ffffff;font-size:28px;font-weight:700;">VaultAU</h1>
              <p style="margin:8px 0 0;color:rgba(255,255,255,.8);font-size:16px">הרשאת הגישה שלך אושרה</p>
            </td>
          </tr>

          <tr>
            <td style="padding:40px 48px">
              <h2 style="margin:0 0 16px;color:#1f2937;font-size:22px;">היי ${displayName},</h2>
              
              <p style="margin:0 0 20px;color:#4b5563;font-size:16px;line-height:1.7">
                המייל שלך נוסף בהצלחה למאגר המורשים של <strong>VaultAU</strong>.
                <br><br>
                <strong>מה עליך לעשות עכשיו?</strong>
                <br>
                עליך להיכנס לאתר וליצור חשבון חדש (Sign Up) באמצעות המייל האוניברסיטאי שלך.
              </p>

              <div style="background:#f0fdf4; border-right:4px solid #22c55e; padding:15px; margin-bottom:25px; color:#166534; font-size:14px;">
                <strong>חשוב:</strong> עליך להירשם עם המייל הזה בלבד: <br>
                <strong dir="ltr">${email}</strong>
              </div>

              <table cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td align="center" style="padding-bottom:32px">
                    <a href="${loginUrl}"
                       style="display:inline-block;background:linear-gradient(135deg,#667eea,#764ba2);
                              color:#ffffff;text-decoration:none;padding:16px 45px;
                              border-radius:12px;font-size:18px;font-weight:600;
                              box-shadow:0 4px 14px rgba(102,126,234,.4)">
                      כניסה ליצירת חשבון
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:0;color:#9ca3af;font-size:13px;line-height:1.6;
                        border-top:1px solid #f3f4f6;padding-top:20px">
                נשלח אל: <span dir="ltr">${email}</span><br>
                אם לא ביקשת גישה זו, ניתן להתעלם ממייל זה.
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
function buildEmailText({ name, email }) {
  const displayName = name || email.split('@')[0];
  return `שלום ${displayName},

מעתה יש לך הרשאת גישה ל-VaultAU.
כעת עליך להיכנס לכתובת הבאה ולהירשם (ליצור חשבון) עם המייל האוניברסיטאי שלך:

https://vaultau.netlify.app/

שימי לב שעליך להשתמש בכתובת המייל הזו בלבד: ${email}

בהצלחה!`;
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
  const apiKey     = process.env.SENDGRID_API_KEY;
  const senderEmail = process.env.SENDER_EMAIL;
  const siteUrl    = process.env.SITE_URL;

  if (!apiKey || !senderEmail) {
    console.error('Missing env vars: SENDGRID_API_KEY or SENDER_EMAIL');
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: 'Server misconfiguration — email env vars missing' }),
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

  const { email, name } = body;

  /* ── Validate email ── */
  if (!email || !email.includes('@')) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ error: 'Missing or invalid field: email' }),
    };
  }

  /* ── Send via SendGrid ── */
  sgMail.setApiKey(apiKey);

  const templateData = { name, email, siteUrl };

  const msg = {
    to:      email,
    from: {
      email: senderEmail,
      name:  'VaultAU',
    },
    subject: '✅ הרשאת הגישה שלך ל-VaultAU אושרה',
    text:    buildEmailText(templateData),
    html:    buildEmailHtml(templateData),
  };

  try {
    await sgMail.send(msg);
    console.log(`Welcome email sent → ${email}`);
    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, sentTo: email }),
    };
  } catch (err) {
    const sgError = err.response?.body?.errors?.[0]?.message || err.message;
    console.error('SendGrid error:', sgError);
    return {
      statusCode: 502,
      headers: CORS,
      body: JSON.stringify({ error: 'Failed to send email', details: sgError }),
    };
  }
};
