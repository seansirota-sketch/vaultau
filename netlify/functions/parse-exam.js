/* ============================================================
   netlify/functions/parse-exam.js
   Proxy מאובטח ל-Claude API — בנק מבחנים
   ============================================================

   ⚠️  אל תכניס את ה-API Key לקוד זה!
   הוא נקרא אוטומטית מ-Environment Variables של Netlify.
   ============================================================ */

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const MODEL      = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 4096;

/* ── CORS headers ── */
const CORS = {
  'Access-Control-Allow-Origin':  process.env.ALLOWED_ORIGIN || '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/* ── Rate limiting (in-memory, resets on cold start) ── */
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX       = 10;     // max 10 requests per minute per IP

function isRateLimited(ip) {
  const now    = Date.now();
  const record = rateLimitMap.get(ip) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };

  if (now > record.resetAt) {
    record.count   = 0;
    record.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }

  record.count++;
  rateLimitMap.set(ip, record);

  return record.count > RATE_LIMIT_MAX;
}

/* ── Prompt builder ── */
function buildPrompt(text, titleHint) {
  const hint = titleHint ? `שם/קוד המבחן: "${titleHint}". ` : '';
  return `${hint}אתה מנתח מבחן אקדמי. שלוף את כל השאלות והסעיפים.

החזר JSON בלבד (ללא markdown, ללא טקסט נוסף) בפורמט הזה בדיוק:
{"questions":[{"number":1,"text":"טקסט שאלה ראשית","parts":[{"letter":"א","text":"טקסט סעיף"}]}]}

הוראות:
- שלוף את כל השאלות
- אם לשאלה יש סעיפים (א)(ב)(ג) — כלול ב-parts
- אם אין סעיפים — parts יהיה []
- נוסחאות מתמטיות: LaTeX עם $...$ או $$...$$
- שמור על הטקסט העברי המקורי
- החזר JSON תקני בלבד

טקסט המבחן:
${text}`;
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

  /* ── API key guard ── */
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is not set in Netlify environment variables!');
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: 'Server misconfiguration — API key missing' }),
    };
  }

  /* ── Rate limiting ── */
  const ip = event.headers['x-forwarded-for']?.split(',')[0].trim()
          || event.headers['client-ip']
          || 'unknown';

  if (isRateLimited(ip)) {
    return {
      statusCode: 429,
      headers: { ...CORS, 'Retry-After': '60' },
      body: JSON.stringify({ error: 'Too many requests — try again in a minute' }),
    };
  }

  /* ── Parse request body ── */
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

  const { text, titleHint, isPDF, base64 } = body;

  if (!text && !base64) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ error: 'Missing required field: text or base64' }),
    };
  }

  /* ── Build Claude messages ── */
  let messages;

  if (isPDF && base64) {
    /* Vision mode — send PDF as base64 document */
    messages = [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: base64 },
        },
        {
          type: 'text',
          text:  buildPrompt('(ראה מסמך המצורף)', titleHint || ''),
        },
      ],
    }];
  } else {
    /* Text mode */
    messages = [{
      role:    'user',
      content: buildPrompt(text, titleHint || ''),
    }];
  }

  /* ── Call Claude API ── */
  try {
    const response = await fetch(CLAUDE_API, {
      method:  'POST',
      headers: {
        'Content-Type':       'application/json',
        'x-api-key':          apiKey,
        'anthropic-version':  '2023-06-01',
      },
      body: JSON.stringify({
        model:      MODEL,
        max_tokens: MAX_TOKENS,
        messages,
      }),
    });

    /* ── Forward error from Anthropic ── */
    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      console.error('Anthropic API error:', response.status, errData);
      return {
        statusCode: response.status,
        headers: CORS,
        body: JSON.stringify({
          error:   errData.error?.message || 'Anthropic API error',
          details: errData,
        }),
      };
    }

    const data = await response.json();

    /* ── Extract and validate JSON from Claude's response ── */
    let jsonStr = (data.content?.find(c => c.type === 'text')?.text || '').trim();

    // Strip markdown fences if Claude added them despite instructions
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();

    // Validate it's actually parseable JSON
    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      // Try to extract the JSON object if there's surrounding text
      const objMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (objMatch) {
        try { parsed = JSON.parse(objMatch[0]); }
        catch { /* will fall through to error response */ }
      }
    }

    if (!parsed || !Array.isArray(parsed.questions)) {
      console.error('Claude returned non-JSON:', jsonStr.slice(0, 300));
      return {
        statusCode: 502,
        headers: CORS,
        body: JSON.stringify({ error: 'AI returned invalid format', raw: jsonStr.slice(0, 300) }),
      };
    }

    /* ── Return clean result to frontend ── */
    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        questions: parsed.questions,
        usage:     data.usage, // tokens used — useful for monitoring
      }),
    };

  } catch (err) {
    console.error('Proxy internal error:', err);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: 'Internal proxy error: ' + err.message }),
    };
  }
};
