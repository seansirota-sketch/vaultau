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
const CLAUDE_MODELS  = [
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
];
const CLAUDE_MAX_TOKENS = 8192;

const FIREBASE_PROJECT = 'eaxmbank';

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

      // Verify caller has admin role in Firestore
      const uid = verifyData.users[0].localId;
      try {
        const userDocRes = await fetch(
          `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/users/${uid}`,
          { headers: { 'Authorization': `Bearer ${idToken}` } }
        );
        if (!userDocRes.ok) return jsonResponse(403, { error: 'Forbidden: unable to verify role' }, request);
        const userDoc = await userDocRes.json();
        if (userDoc?.fields?.role?.stringValue !== 'admin') {
          return jsonResponse(403, { error: 'Forbidden: admin access required' }, request);
        }
      } catch (_roleErr) {
        return jsonResponse(403, { error: 'Forbidden: role check failed' }, request);
      }
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
      });

      const bodySizeMB = (requestBody.length / 1_048_576).toFixed(2);
      console.log(`parse-exam: trying ${model} (${bodySizeMB}MB, attempt ${i + 1}/${modelsToTry.length})`);

      const response = await fetch(claudeApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: requestBody,
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        let errMsg = `${model}: HTTP ${response.status}`;
        try { const d = JSON.parse(errText); errMsg = d.error?.message || errMsg; } catch (_e) { /* ignore */ }

        // 529 = overloaded, 5xx = server error → try next model
        if (response.status === 529 || response.status >= 500) {
          console.warn(`⚠️ ${errMsg} — trying next model...`);
          lastErr = errMsg;
          // In single-model mode, return retryable error so client can try next
          if (requestedModel) {
            return jsonResponse(response.status, { error: errMsg, retryable: true }, request);
          }
          continue;
        }
        return jsonResponse(response.status, { error: errMsg }, request);
      }

      const data = await response.json();

      // ── Extract and validate JSON from response ─────────
      let jsonStr = (data.content?.find(c => c.type === 'text')?.text || '').trim();

      // Strip markdown fences
      const fenceRe = new RegExp('```(?:json)?\\s*([\\s\\S]*?)```');
      const fence = jsonStr.match(fenceRe);      if (fence) jsonStr = fence[1].trim();

      let parsed;
      try { parsed = JSON.parse(jsonStr); } catch (_e) {
        const m = jsonStr.match(/\{[\s\S]*\}/);
        if (m) try { parsed = JSON.parse(m[0]); } catch (_e2) { /* fall through */ }
      }

      if (!parsed || !Array.isArray(parsed.questions)) {
        console.warn(`⚠️ ${model}: invalid JSON — trying next model...`);
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
