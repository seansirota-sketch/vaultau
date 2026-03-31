/* ============================================================
   netlify/edge-functions/generate-question.js
   Netlify Edge Function — streams Gemini API responses so the
   API key stays server-side and there's no 26-second timeout.

   Smart Generate System features:
     - Input validation & sanitization
     - Per-user quota enforcement  (user_quotas collection)
     - Gemini retry with exponential back-off
     - Claude API fallback when Gemini is down
     - Usage logging               (generate_usage collection)
     - Cache TTL management         (ai_questions_cache collection)

   Environment Variables (Netlify → Site Settings):
     GEMINI_API_KEY       — Google Gemini API key
     FIREBASE_WEB_API_KEY — Firebase project web API key
     ANTHROPIC_API_KEY    — Anthropic Claude API key (fallback)
   ============================================================ */

// ── Constants ───────────────────────────────────────────────
const GEMINI_MODEL   = 'gemini-3.1-pro-preview';
const GEMINI_URL     = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse`;
const CLAUDE_MODEL   = 'claude-sonnet-4-20250514';
const FIREBASE_PROJECT = 'eaxmbank';
const FIRESTORE_BASE   = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;

const MAX_PROMPT_LENGTH   = 8000;   // characters
const MAX_RETRIES         = 1;
const RETRY_BASE_MS       = 300;
const GEMINI_TIMEOUT_MS   = 25_000;  // 25s per Gemini attempt
const CLAUDE_TIMEOUT_MS   = 25_000;  // 25s for Claude fallback

// ── Quota limits ───────────────────────────────────────────
const QUOTA_DAILY  = 10;
const QUOTA_WEEKLY = 50;

// ── Feature flags (env vars) ────────────────────────────────
function featureEnabled(name, fallback = true) {
  const val = Deno.env.get(name);
  if (val === undefined || val === null) return fallback;
  return val === 'true' || val === '1';
}

// ── Main handler ────────────────────────────────────────────
export default async (request, _context) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: corsHeaders(request) });
  }

  // ── 1. Authenticate caller ────────────────────────────
  const authHeader = request.headers.get('Authorization') || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) return jsonResponse(401, { error: 'Unauthorized: missing token' }, request);

  const firebaseWebApiKey = Deno.env.get('FIREBASE_WEB_API_KEY');
  if (!firebaseWebApiKey) return jsonResponse(500, { error: 'Server misconfiguration: missing Firebase key' }, request);

  let uid;
  try {
    const verifyRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${firebaseWebApiKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) }
    );
    if (!verifyRes.ok) return jsonResponse(401, { error: 'Unauthorized: invalid or expired token' }, request);
    const verifyData = await verifyRes.json();
    if (!verifyData?.users?.length) return jsonResponse(401, { error: 'Unauthorized: user not found' }, request);
    uid = verifyData.users[0].localId;
  } catch {
    return jsonResponse(401, { error: 'Unauthorized: token verification failed' }, request);
  }

  try {
    // ── 2. Parse & validate input ───────────────────────────
    const body = await request.json();
    const { prompt } = body;

    // Feature-gated input validation
    if (featureEnabled('FEATURE_VALIDATE_INPUT', true)) {
      const validationError = validateInput(prompt);
      if (validationError) return jsonResponse(400, { error: validationError }, request);
    }

    const sanitizedPrompt = sanitizePrompt(prompt);

    // ── 3. Check user quota ─────────────────────────────────
    const quota = featureEnabled('FEATURE_RATE_LIMIT', true)
      ? await checkQuota(uid, idToken)
      : { used: 0, remaining: Infinity, limit: Infinity, resetAt: '' };

    if (quota.remaining <= 0) {
      const msg = quota.reason === 'weekly'
        ? `מכסת השאלות השבועית (${QUOTA_WEEKLY}) מוצתה. נסה שוב ביום ראשון.`
        : `מכסת השאלות היומית (${QUOTA_DAILY}) מוצתה. נסה שוב מחר.`;
      return jsonResponse(429, {
        error: msg,
        quota: { used: quota.used, limit: quota.limit, resetAt: quota.resetAt }
      }, request);
    }

    // ── 4. Start streaming IMMEDIATELY, then call AI inside ──
    //    This prevents Netlify's edge-function timeout by sending
    //    response headers right away (keeps the connection alive).
    const startTime = Date.now();
    const { readable, writable } = new TransformStream();
    const writer  = writable.getWriter();
    const encoder = new TextEncoder();

    // Background: call AI → pipe chunks → log usage
    (async () => {
      let apiUsed      = 'gemini';
      let fullText     = '';
      let inputTokens  = 0;
      let outputTokens = 0;
      let status       = 'success';
      let errorMessage = '';

      try {
        // Send a keep-alive comment so Netlify knows the stream is active
        await writer.write(encoder.encode(': keepalive\n\n'));

        // ── Call Gemini (primary) → Claude (fallback) ───────
        let stream;
        try {
          stream = await callGeminiWithRetry(sanitizedPrompt);
        } catch (geminiErr) {
          console.warn('Gemini failed, trying Claude fallback:', geminiErr.message);
          apiUsed = 'claude';
          stream = await callClaudeFallback(sanitizedPrompt);
        }

        // ── Pipe AI stream to client ────────────────────────
        if (apiUsed === 'gemini') {
          ({ fullText, inputTokens, outputTokens } = await pipeGeminiStream(stream, writer, encoder));
        } else {
          ({ fullText, inputTokens, outputTokens } = await pipeClaudeStream(stream, writer, encoder));
        }
        await writer.write(encoder.encode('data: [DONE]\n\n'));

      } catch (err) {
        status = 'error';
        errorMessage = err.message || 'Unknown error';
        console.error('AI generation failed:', errorMessage);
        try { await writer.write(encoder.encode(`data: ${JSON.stringify({ error: errorMessage })}\n\n`)); } catch { /* closed */ }
      } finally {
        try { await writer.close(); } catch { /* closed */ }
      }

      // ── Post-stream: log usage + increment quota ──────────
      const latencyMs = Date.now() - startTime;
      logUsage(uid, idToken, { api: apiUsed, latencyMs, cached: false, promptLength: sanitizedPrompt.length, responseLength: fullText.length, inputTokens, outputTokens, status, errorMessage }).catch(() => {});
      if (status === 'success') incrementQuota(uid, idToken).catch(() => {});
    })();

    return new Response(readable, {
      status: 200,
      headers: { ...corsHeaders(request), 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive',
        'X-Quota-Remaining': String(quota.remaining - 1),
        'X-Quota-Limit':     String(quota.limit),
      },
    });

  } catch (err) {
    console.error('generate-question error:', err);
    // Log the 500 error so the admin AI monitor can see it
    if (uid && idToken) {
      logUsage(uid, idToken, {
        api: 'none', latencyMs: 0, cached: false,
        promptLength: 0, responseLength: 0,
        inputTokens: 0, outputTokens: 0,
        status: 'error',
        errorMessage: `[500] ${err.message || 'Server error'}`,
      }).catch(() => {});
    }
    return jsonResponse(500, { error: err.message || 'Server error' }, request);
  }
};

// ── Input validation ────────────────────────────────────────
function validateInput(prompt) {
  if (!prompt || typeof prompt !== 'string') return 'Missing or invalid prompt';
  if (prompt.length > MAX_PROMPT_LENGTH) return `Prompt too long (max ${MAX_PROMPT_LENGTH} chars)`;
  if (prompt.trim().length < 10) return 'Prompt too short';
  return null;
}

function sanitizePrompt(prompt) {
  // Strip control characters (keep newlines and tabs for formatting)
  return prompt.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
}

// ── Quota management (Firestore REST API) ───────────────────
function todayKey() {
  return new Date().toISOString().slice(0, 10);           // "2026-03-23"
}
function weekKey() {
  const d = new Date();
  const day = d.getDay();                                 // 0=Sun
  d.setDate(d.getDate() - day);
  return d.toISOString().slice(0, 10);                    // Sunday of this week
}

async function checkQuota(uid, idToken) {
  try {
    const url = `${FIRESTORE_BASE}/user_quotas/${uid}`;
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${idToken}` } });

    if (res.status === 404 || !res.ok) {
      return { used: 0, remaining: QUOTA_DAILY, limit: QUOTA_DAILY, resetAt: tomorrowISO() };
    }

    const doc = await res.json();
    const fields = doc.fields || {};

    const storedDay   = fields.date_key?.stringValue || '';
    const storedWeek  = fields.week_key?.stringValue || '';
    const usedToday   = parseInt(fields.requests_today?.integerValue || '0', 10);
    const usedWeek    = parseInt(fields.requests_this_week?.integerValue || '0', 10);

    const dailyUsed  = (storedDay === todayKey())  ? usedToday : 0;
    const weeklyUsed = (storedWeek === weekKey()) ? usedWeek   : 0;

    if (weeklyUsed >= QUOTA_WEEKLY) {
      return { used: weeklyUsed, remaining: 0, limit: QUOTA_WEEKLY, resetAt: nextSundayISO(), reason: 'weekly' };
    }

    const remaining = QUOTA_DAILY - dailyUsed;
    return { used: dailyUsed, remaining, limit: QUOTA_DAILY, resetAt: tomorrowISO() };
  } catch (err) {
    console.warn('Quota check failed, allowing request:', err.message);
    return { used: 0, remaining: QUOTA_DAILY, limit: QUOTA_DAILY, resetAt: tomorrowISO() };
  }
}

async function incrementQuota(uid, idToken) {
  const url = `${FIRESTORE_BASE}/user_quotas/${uid}`;
  const now = new Date().toISOString();
  const today = todayKey();
  const week  = weekKey();

  // First, read to check if date_key needs resetting
  let needsReset = false;
  let needsWeekReset = false;
  try {
    const getRes = await fetch(url, { headers: { 'Authorization': `Bearer ${idToken}` } });
    if (getRes.ok) {
      const doc = await getRes.json();
      const storedDay  = doc.fields?.date_key?.stringValue || '';
      const storedWeek = doc.fields?.week_key?.stringValue || '';
      if (storedDay !== today) needsReset = true;
      if (storedWeek !== week) needsWeekReset = true;
    } else {
      needsReset = true;
      needsWeekReset = true;
    }
  } catch { needsReset = true; needsWeekReset = true; }

  // If day or week rolled over, reset counters then set to 1
  if (needsReset || needsWeekReset) {
    const patchBody = {
      fields: {
        requests_today:     { integerValue: '1' },
        requests_this_week: { integerValue: needsWeekReset ? '1' : undefined },
        date_key:           { stringValue: today },
        week_key:           { stringValue: week },
        last_request:       { stringValue: now },
      }
    };
    // Remove undefined fields
    if (!needsWeekReset) delete patchBody.fields.requests_this_week;

    const fields = Object.keys(patchBody.fields);
    const mask = fields.map(f => `updateMask.fieldPaths=${f}`).join('&');
    await fetch(`${url}?${mask}`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(patchBody),
    });
    return;
  }

  // Same day — use Firestore commit with fieldTransforms for atomic increment
  const commitUrl = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents:commit`;
  const docPath = `projects/${FIREBASE_PROJECT}/databases/(default)/documents/user_quotas/${uid}`;
  const commitBody = {
    writes: [{
      transform: {
        document: docPath,
        fieldTransforms: [
          { fieldPath: 'requests_today',     increment: { integerValue: '1' } },
          { fieldPath: 'requests_this_week', increment: { integerValue: '1' } },
        ]
      }
    }, {
      update: {
        name: docPath,
        fields: {
          last_request: { stringValue: now },
          date_key:     { stringValue: today },
          week_key:     { stringValue: week },
        }
      },
      updateMask: { fieldPaths: ['last_request', 'date_key', 'week_key'] }
    }]
  };

  await fetch(commitUrl, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commitBody),
  });
}

function tomorrowISO() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function nextSundayISO() {
  const d = new Date();
  const day = d.getDay(); // 0=Sun
  d.setDate(d.getDate() + (7 - day));
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

// ── Usage logging ───────────────────────────────────────────
async function logUsage(uid, idToken, data) {
  const url = `${FIRESTORE_BASE}/generate_usage`;
  const body = {
    fields: {
      uid:            { stringValue: uid },
      api:            { stringValue: data.api },
      latencyMs:      { integerValue: String(data.latencyMs) },
      cached:         { booleanValue: data.cached },
      promptLength:   { integerValue: String(data.promptLength) },
      responseLength: { integerValue: String(data.responseLength) },
      inputTokens:    { integerValue: String(data.inputTokens  || 0) },
      outputTokens:   { integerValue: String(data.outputTokens || 0) },
      status:         { stringValue: data.status || 'success' },
      errorMessage:   { stringValue: data.errorMessage || '' },
      timestamp:      { stringValue: new Date().toISOString() },
      date_key:       { stringValue: todayKey() },
    }
  };

  await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ── Gemini API with retry ───────────────────────────────────
async function callGeminiWithRetry(prompt) {
  const apiKey = Deno.env.get('GEMINI_API_KEY');
  if (!apiKey) throw new Error('Gemini API key not configured');

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await sleep(RETRY_BASE_MS * Math.pow(2, attempt - 1));
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
      const res = await fetch(`${GEMINI_URL}&key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.65, maxOutputTokens: 8192 },
        }),
      });
      clearTimeout(timer);
      if (res.ok) return res;

      const errData = await res.json().catch(() => ({}));
      lastError = new Error(errData?.error?.message || `Gemini HTTP ${res.status}`);

      // Don't retry on 4xx client errors (except 429 rate limit)
      if (res.status >= 400 && res.status < 500 && res.status !== 429) throw lastError;
    } catch (err) {
      lastError = err;
      if (err.name === 'AbortError') {
        lastError = new Error(`Gemini timeout (${GEMINI_TIMEOUT_MS}ms) — attempt ${attempt + 1}`);
        console.warn(lastError.message);
      } else if (err.message?.includes('Gemini HTTP 4')) throw err;  // client error, don't retry
    }
  }
  throw lastError;
}

// ── Claude API fallback ─────────────────────────────────────
async function callClaudeFallback(prompt) {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('Claude API key not configured');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLAUDE_TIMEOUT_MS);
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':      apiKey,
        'content-type':   'application/json',
        'anthropic-version': '2023-06-01',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 4096,
        stream: true,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error(`Claude timeout (${CLAUDE_TIMEOUT_MS}ms)`);
    throw err;
  }
  clearTimeout(timer);

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData?.error?.message || `Claude HTTP ${res.status}`);
  }
  return res;
}

// ── Stream piping helpers ───────────────────────────────────
async function pipeGeminiStream(geminiRes, writer, encoder) {
  const reader  = geminiRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer       = '';
  let fullText     = '';
  let inputTokens  = 0;
  let outputTokens = 0;

  const parseChunk = line => {
    if (!line.startsWith('data: ')) return null;
    const json = line.slice(6).trim();
    if (!json || json === '[DONE]') return null;
    try { return JSON.parse(json); } catch { return null; }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const chunk = parseChunk(line);
      if (!chunk) continue;
      const text = chunk?.candidates?.[0]?.content?.parts?.[0]?.text || null;
      if (text) {
        fullText += text;
        await writer.write(encoder.encode(`data: ${JSON.stringify({ text })}\n\n`));
      }
      if (chunk.usageMetadata) {
        inputTokens  = chunk.usageMetadata.promptTokenCount     || 0;
        outputTokens = chunk.usageMetadata.candidatesTokenCount || 0;
      }
    }
  }

  // Flush remaining buffer
  if (buffer) {
    const chunk = parseChunk(buffer);
    if (chunk) {
      const text = chunk?.candidates?.[0]?.content?.parts?.[0]?.text || null;
      if (text) {
        fullText += text;
        await writer.write(encoder.encode(`data: ${JSON.stringify({ text })}\n\n`));
      }
      if (chunk.usageMetadata) {
        inputTokens  = chunk.usageMetadata.promptTokenCount     || 0;
        outputTokens = chunk.usageMetadata.candidatesTokenCount || 0;
      }
    }
  }
  return { fullText, inputTokens, outputTokens };
}

async function pipeClaudeStream(claudeRes, writer, encoder) {
  const reader  = claudeRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer       = '';
  let fullText     = '';
  let inputTokens  = 0;
  let outputTokens = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const json = line.slice(6).trim();
      if (!json || json === '[DONE]') continue;
      try {
        const evt = JSON.parse(json);
        if (evt.type === 'message_start') {
          inputTokens  = evt.message?.usage?.input_tokens  || 0;
          outputTokens = evt.message?.usage?.output_tokens || 0;
        } else if (evt.type === 'message_delta') {
          outputTokens = evt.usage?.output_tokens || outputTokens;
        } else if (evt.type === 'content_block_delta') {
          const text = evt.delta?.text || '';
          if (text) {
            fullText += text;
            await writer.write(encoder.encode(`data: ${JSON.stringify({ text })}\n\n`));
          }
        }
      } catch { /* skip */ }
    }
  }
  return { fullText, inputTokens, outputTokens };
}

// ── Utilities ───────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const ALLOWED_ORIGINS = [
  'https://vaultau.netlify.app',
  'http://localhost:8888',
];

function corsHeaders(request) {
  const origin = request?.headers?.get('origin') || '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin':  allowedOrigin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Expose-Headers': 'X-Quota-Remaining, X-Quota-Limit, X-Api-Used',
  };
}

function jsonResponse(status, body, request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(request), 'Content-Type': 'application/json' },
  });
}

export const config = {
  path: '/api/generate-question',
};
