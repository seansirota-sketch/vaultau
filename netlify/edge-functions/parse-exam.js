/* ============================================================
   netlify/edge-functions/parse-exam.js
   Netlify Edge Function — proxies Claude API for exam parsing.
   Runs on Deno Deploy (no 26s timeout limit like regular functions).

   Features:
     - Model fallback: Opus → Sonnet → Haiku
     - API key stays server-side (Netlify env vars)
     - Firebase auth token verification
     - Supports: images (Vision), PDF document, plain text

   Environment Variables (Netlify → Site Settings):
     ANTHROPIC_API_KEY    — Anthropic Claude API key
     FIREBASE_WEB_API_KEY — Firebase project web API key
   ============================================================ */

const CLAUDE_DIRECT_URL  = 'https://api.anthropic.com/v1/messages';
// Sonnet-first: strong Hebrew + LaTeX at reasonable cost is the default.
// Opus is the escalation model; Haiku is the last-resort fallback.
const CLAUDE_MODELS  = [
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-haiku-4-5-20251001',
];
// Raised from 8192 → 16384 so multi-question exams stop truncating mid-JSON.
const CLAUDE_MAX_TOKENS = 16384;

// Exponential backoff (ms) for transient 529 (overloaded) / 5xx errors,
// retried against the SAME model before falling back to the next one.
const BACKOFF_MS = [1000, 3000, 8000];

// Forced tool use turns free-text JSON into schema-validated tool input,
// eliminating markdown-fence scraping and most "invalid format" failures.
const EXAM_TOOL_NAME = 'report_exam';
const EXAM_TOOL = {
  name: EXAM_TOOL_NAME,
  description: 'Report the fully parsed academic exam as structured data. Call this exactly once with every question and sub-question extracted from the exam.',
  input_schema: {
    type: 'object',
    properties: {
      metadata: {
        type: 'object',
        description: 'Exam metadata extracted from the header/first page.',
        properties: {
          courseName: { type: ['string', 'null'] },
          lecturers:  { type: 'array', items: { type: 'string' } },
          year:       { type: ['number', 'null'] },
          semester:   { type: ['string', 'null'] },
          moed:       { type: ['string', 'null'] },
        },
      },
      questions: {
        type: 'array',
        description: 'All questions in the exam, in order.',
        items: {
          type: 'object',
          properties: {
            number:  { type: ['number', 'string'] },
            text:    { type: 'string' },
            subject: { type: ['string', 'null'] },
            isBonus: { type: 'boolean' },
            parts: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  letter:  { type: ['string', 'null'] },
                  text:    { type: 'string' },
                  subject: { type: ['string', 'null'] },
                },
                required: ['text'],
              },
            },
            // Chunked parsing (set only when the exam is split across multiple calls).
            continuesFromPrevious: {
              type: 'boolean',
              description: 'True if this question is the continuation of a question that started in the previous chunk.',
            },
            continuesToNext: {
              type: 'boolean',
              description: 'True if this question is cut off at the end of the chunk and continues into the next chunk.',
            },
          },
          required: ['text'],
        },
      },
    },
    required: ['questions'],
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FIREBASE_PROJECT = 'eaxmbank';
const ROLE_ALLOWED = new Set(['instructor', 'admin']);

function normalizeRole(role) {
  const value = String(role || '').toLowerCase();
  if (value === 'administrator') return 'admin';
  if (value === 'teacher' || value === 'staff') return 'instructor';
  return value;
}

function roleFromCustomAttributes(customAttributes) {
  if (!customAttributes) return null;
  try {
    const parsed = JSON.parse(customAttributes);
    return normalizeRole(parsed?.ltiRole || parsed?.lti_role || parsed?.role || null);
  } catch {
    return null;
  }
}

function roleFromFirestoreDoc(userDoc) {
  const fields = userDoc?.fields || {};
  return normalizeRole(fields?.ltiRole?.stringValue || fields?.role?.stringValue || null);
}

async function resolveCallerRole(uid, idToken, verifyDataUser, request) {
  const claimRole = roleFromCustomAttributes(verifyDataUser?.customAttributes);

  if (claimRole && ROLE_ALLOWED.has(claimRole)) {
    return { role: claimRole, source: 'claims' };
  }

  try {
    const userDocRes = await fetch(
      `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/users/${uid}`,
      { headers: { 'Authorization': `Bearer ${idToken}` } }
    );
    if (!userDocRes.ok) {
      const status = userDocRes.status;
      if (status >= 500) {
        console.error(`parse-exam: Firestore role lookup failed with ${status} for uid=${uid}`);
        return { error: jsonResponse(503, { error: 'Service temporarily unavailable — please retry' }, request) };
      }
      console.warn(`parse-exam: Firestore role lookup denied (HTTP ${status}) for uid=${uid}`);
      if (claimRole) {
        return { role: claimRole, source: 'claims_denied_firestore_unavailable' };
      }
      return { error: jsonResponse(403, { error: 'Forbidden: unable to verify role' }, request) };
    }

    const userDoc = await userDocRes.json();
    const dbRole = roleFromFirestoreDoc(userDoc);
    if (ROLE_ALLOWED.has(dbRole)) {
      if (claimRole && claimRole !== dbRole) {
        console.warn(JSON.stringify({
          event: 'authz_role_override',
          endpoint: 'parse-exam',
          uid,
          claimRole,
          dbRole,
          source: 'firestore_override',
        }));
      }
      return { role: dbRole, source: 'firestore' };
    }

    return { role: claimRole || dbRole || null, source: claimRole ? 'claims' : 'firestore' };
  } catch (_roleErr) {
    console.error('parse-exam: Firestore role check threw an exception:', _roleErr?.message);
    return { error: jsonResponse(503, { error: 'Service temporarily unavailable — role check failed' }, request) };
  }
}

// ── Main handler ────────────────────────────────────────────
export default async (request, _context) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'Method Not Allowed' }, request);
  }

  // ── API key guard ─────────────────────────────────────────
  // Netlify Dev AI Gateway overrides ANTHROPIC_API_KEY with a JWT and sets
  // ANTHROPIC_BASE_URL to its proxy. Use CLAUDE_KEY (unmangled) when available;
  // fall back to ANTHROPIC_API_KEY + gateway URL if it's a JWT.
  const rawKey = (Deno.env.get('CLAUDE_KEY') || Deno.env.get('ANTHROPIC_API_KEY') || '').trim();
  const isGatewayJwt = rawKey.startsWith('eyJ');
  const apiKey = rawKey;
  const claudeApiUrl = isGatewayJwt
    ? (Deno.env.get('ANTHROPIC_BASE_URL') || CLAUDE_DIRECT_URL) + '/v1/messages'
    : CLAUDE_DIRECT_URL;

  console.log(`parse-exam: key=*****(${apiKey.length}), url=${claudeApiUrl}, gateway=${isGatewayJwt}`);

  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY / CLAUDE_KEY is not set');
    return jsonResponse(500, { error: 'Server misconfiguration — API key missing' }, request);
  }

  // ── Authenticate caller via Firebase ID token ─────────────
  const isLocalDev = Deno.env.get('NETLIFY_DEV') === 'true';
  const authHeader = request.headers.get('Authorization') || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) {
    return jsonResponse(401, { error: 'Unauthorized: missing token' }, request);
  }

  // Skip token verification in local dev (emulator tokens can't validate against production)
  if (!isLocalDev) {
    const firebaseWebApiKey = Deno.env.get('FIREBASE_WEB_API_KEY');
    if (!firebaseWebApiKey) {
      return jsonResponse(500, { error: 'Server misconfiguration: missing Firebase key' }, request);
    }

    try {
      const verifyRes = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${firebaseWebApiKey}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) }
      );
      if (!verifyRes.ok) return jsonResponse(401, { error: 'Unauthorized: invalid token' }, request);
      const verifyData = await verifyRes.json();
      if (!verifyData?.users?.length) return jsonResponse(401, { error: 'Unauthorized: user not found' }, request);

      const uid = verifyData.users[0].localId;
      const resolved = await resolveCallerRole(uid, idToken, verifyData.users[0], request);
      if (resolved.error) return resolved.error;

      if (!ROLE_ALLOWED.has(resolved.role)) {
        console.warn(JSON.stringify({
          event: 'authz_denied',
          endpoint: 'parse-exam',
          uid,
          role: resolved.role || 'unknown',
          roleSource: resolved.source,
          reason: 'role_not_allowed',
        }));
        return jsonResponse(403, { error: 'Forbidden: instructor or admin role required' }, request);
      }

      console.log(`parse-exam: authz allow uid=${uid} role=${resolved.role} source=${resolved.source}`);
    } catch (_e) {
      return jsonResponse(401, { error: 'Unauthorized: token verification failed' }, request);
    }
  } else {
    console.log('⚠️ Local dev mode — skipping auth token verification');
  }

  // ── Parse request body ────────────────────────────────────
  let body;
  try {
    body = await request.json();
  } catch (_e) {
    return jsonResponse(400, { error: 'Invalid JSON body' }, request);
  }

  const { messages, model: requestedModel } = body;

  if (!messages || !Array.isArray(messages) || !messages.length) {
    return jsonResponse(400, { error: 'Missing required field: messages' }, request);
  }

  // If client specifies a model, try only that one; otherwise full fallback
  const modelsToTry = requestedModel && CLAUDE_MODELS.includes(requestedModel)
    ? [requestedModel]
    : CLAUDE_MODELS;

  // ── Call Claude with model fallback ───────────────────────
  let lastErr = null;

  for (let i = 0; i < modelsToTry.length; i++) {
    const model = modelsToTry[i];

    try {
      const requestBody = JSON.stringify({
        model,
        max_tokens: CLAUDE_MAX_TOKENS,
        messages,
        // Force the model to answer via the tool → schema-validated JSON.
        tools: [EXAM_TOOL],
        tool_choice: { type: 'tool', name: EXAM_TOOL_NAME },
      });

      const bodySizeMB = (requestBody.length / 1_048_576).toFixed(2);
      console.log(`parse-exam: trying ${model} (${bodySizeMB}MB, attempt ${i + 1}/${modelsToTry.length})`);

      // ── Fetch with 529/5xx backoff against the SAME model ────
      let response = null;
      let transientErr = null;
      for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
        response = await fetch(claudeApiUrl, {
          method: 'POST',
          headers: {
            'Content-Type':      'application/json',
            'x-api-key':         apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: requestBody,
        });

        if (response.ok) { transientErr = null; break; }

        const errText = await response.text().catch(() => '');
        let errMsg = `${model}: HTTP ${response.status}`;
        try { const d = JSON.parse(errText); errMsg = d.error?.message || errMsg; } catch (_e) { /* ignore */ }

        // 529 = overloaded, 5xx = server error → retry same model, then fall back
        if (response.status === 529 || response.status >= 500) {
          transientErr = { status: response.status, msg: errMsg };
          if (attempt < BACKOFF_MS.length) {
            const wait = BACKOFF_MS[attempt] + Math.floor(Math.random() * 400); // jitter
            console.warn(`⚠️ ${errMsg} — retrying ${model} in ${wait}ms (${attempt + 1}/${BACKOFF_MS.length})`);
            await sleep(wait);
            continue;
          }
          break; // exhausted retries for this model
        }

        // Non-transient error (4xx) → return immediately, no retry/fallback
        return jsonResponse(response.status, { error: errMsg }, request);
      }

      if (transientErr) {
        console.warn(`⚠️ ${transientErr.msg} — trying next model...`);
        lastErr = transientErr.msg;
        if (requestedModel) {
          return jsonResponse(transientErr.status, { error: transientErr.msg, retryable: true }, request);
        }
        continue;
      }

      const data = await response.json();

      // ── Truncation guard: never parse a cut-off response ────
      if (data.stop_reason === 'max_tokens') {
        console.warn(`⚠️ ${model}: output truncated (max_tokens=${CLAUDE_MAX_TOKENS})`);
        lastErr = `${model}: exam too large — output truncated`;
        // Falling back to another model won't help; surface a clear error.
        return jsonResponse(422, { error: lastErr, truncated: true, retryable: false }, request);
      }

      // ── Extract structured data: tool_use first, text fallback ──
      let parsed = data.content?.find(c => c.type === 'tool_use' && c.name === EXAM_TOOL_NAME)?.input || null;

      if (!parsed) {
        // Legacy fallback: scrape JSON from a text block (fences or raw braces).
        let jsonStr = (data.content?.find(c => c.type === 'text')?.text || '').trim();
        const fenceRe = new RegExp('```(?:json)?\\s*([\\s\\S]*?)```');
        const fence = jsonStr.match(fenceRe);      if (fence) jsonStr = fence[1].trim();
        try { parsed = JSON.parse(jsonStr); } catch (_e) {
          const m = jsonStr.match(/\{[\s\S]*\}/);
          if (m) try { parsed = JSON.parse(m[0]); } catch (_e2) { /* fall through */ }
        }
      }

      if (!parsed || !Array.isArray(parsed.questions)) {
        console.warn(`⚠️ ${model}: invalid format — trying next model...`);
        lastErr = `${model}: AI returned invalid format`;
        if (requestedModel) {
          return jsonResponse(422, { error: lastErr, retryable: true }, request);
        }
        continue;
      }

      console.log(`✅ ${model}: ${parsed.questions.length} questions parsed`);

      return jsonResponse(200, {
        questions: parsed.questions,
        metadata:  parsed.metadata || null,
        usage:     data.usage,
        model,
      }, request);

    } catch (err) {
      console.warn(`⚠️ ${model}: ${err.message}`);
      lastErr = err.message;
      if (requestedModel) {
        return jsonResponse(502, { error: lastErr, retryable: true }, request);
      }
      continue;
    }
  }

  // All models failed
  return jsonResponse(502, {
    error: lastErr || 'כל המודלים נכשלו',
  }, request);
};

// ── Utilities ───────────────────────────────────────────────
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
  };
}

function jsonResponse(status, body, request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(request), 'Content-Type': 'application/json' },
  });
}

export const config = {
  path: '/api/parse-exam',
};
