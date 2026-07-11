/* ============================================================
   netlify/edge-functions/categorize-question.js
   Netlify Edge Function — proxies Claude to categorize ONE exam
   question (with its clauses/סעיפים) into a course's topics.

   Design mirrors parse-exam.js: the edge function is stateless and
   returns a *validated proposal*; the admin client performs the
   atomic Firestore writes (honoring the question/clause either-or
   invariant). This matches the existing "parse → client writes"
   flow and keeps privileged writes on the (admin) client.

   Decides:
     - relatedness: are the clauses dependent (share context / same
       topic) or independent (self-contained on different topics)?
     - where to attach the topic: question level (inherited by all
       clauses) vs. per-clause.

   Environment Variables (Netlify → Site Settings):
     ANTHROPIC_API_KEY / CLAUDE_KEY — Anthropic Claude API key
     FIREBASE_WEB_API_KEY           — Firebase project web API key
   ============================================================ */

const CLAUDE_DIRECT_URL = 'https://api.anthropic.com/v1/messages';
// Sonnet-first: strong Hebrew + reasoning at reasonable cost. Haiku is the
// cheap fallback. Categorization is lighter than parsing, so no Opus by default.
const CLAUDE_MODELS = [
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
];
const CLAUDE_MAX_TOKENS = 2048;
const BACKOFF_MS = [1000, 3000, 8000];

const TOOL_NAME = 'report_categorization';
const CATEGORIZE_TOOL = {
  name: TOOL_NAME,
  description: 'Report the topic categorization for a single exam question and its clauses. Call exactly once.',
  input_schema: {
    type: 'object',
    properties: {
      relatedness: {
        type: 'string',
        enum: ['single', 'dependent', 'independent'],
        description: 'single = no/one clause; dependent = clauses share context or the same topic (assign at question level); independent = clauses are self-contained on different topics (assign per clause).',
      },
      reasoning: { type: 'string', description: 'One short sentence justifying the relatedness decision.' },
      confidence: { type: 'number', description: '0.0–1.0 confidence in the assignment.' },
      // Present when relatedness is 'single' or 'dependent'.
      questionTopicIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'topicId(s) for the whole question. Use ONLY when scope is question-level.',
      },
      // Present when relatedness is 'independent'.
      perClause: {
        type: 'array',
        description: 'Per-clause topics. Use ONLY when relatedness is independent.',
        items: {
          type: 'object',
          properties: {
            clauseId: { type: 'string' },
            topicIds: { type: 'array', items: { type: 'string' } },
          },
          required: ['clauseId', 'topicIds'],
        },
      },
    },
    required: ['relatedness', 'reasoning', 'confidence'],
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
        return { error: jsonResponse(503, { error: 'Service temporarily unavailable — please retry' }, request) };
      }
      if (claimRole) return { role: claimRole, source: 'claims_denied_firestore_unavailable' };
      return { error: jsonResponse(403, { error: 'Forbidden: unable to verify role' }, request) };
    }
    const userDoc = await userDocRes.json();
    const dbRole = roleFromFirestoreDoc(userDoc);
    if (ROLE_ALLOWED.has(dbRole)) return { role: dbRole, source: 'firestore' };
    return { role: claimRole || dbRole || null, source: claimRole ? 'claims' : 'firestore' };
  } catch (_roleErr) {
    return { error: jsonResponse(503, { error: 'Service temporarily unavailable — role check failed' }, request) };
  }
}

// ── Prompt construction ─────────────────────────────────────
const SYSTEM_PROMPT = `You are categorizing an academic exam question into a fixed list of course topics.
You will receive the question stem, its clauses (סעיפים, may be empty), and the allowed topics.

DECISION RUBRIC — clause relatedness:
1. "single"      — the question has no clauses, or exactly one clause. Assign at question level (questionTopicIds).
2. "dependent"   — the clauses share a common setup/scenario, reference one another
                   ("using your answer from part א…"), or all exercise the SAME topic.
                   ⇒ assign ONE topic set to the whole question via questionTopicIds.
3. "independent" — the clauses are self-contained mini-questions testing DIFFERENT topics
                   (e.g. "differentiate the following", where each part needs a different technique).
                   ⇒ assign topics per clause via perClause.

TIE-BREAKERS:
- If clauses share a scenario but a later clause cannot be understood without earlier ones, prefer "dependent".
- If ≥80% of the clauses map to the SAME single topic, prefer "dependent" with that topic.
- A question stem that itself carries the topic (e.g. "compute the derivative of:") applies to every clause — weigh it toward "dependent".
- You MUST only use topicId values from the provided list. If nothing fits well, pick the closest topicId and lower your confidence.
- Answer in the language of the exam content (Hebrew) for the reasoning field only; topicIds must be the provided ids verbatim.

Call the report_categorization tool exactly once.`;

function buildUserMessage({ question, clauses, topics }) {
  const topicLines = topics.map(t => `- ${t.id}: ${t.name}${t.description ? ` — ${t.description}` : ''}`).join('\n');
  const clauseLines = (clauses && clauses.length)
    ? clauses.map(c => `  [${c.id}] (${c.label || ''}) ${c.text || ''}`).join('\n')
    : '  (no clauses)';
  return `ALLOWED TOPICS (use these topicId values only):
${topicLines}

QUESTION STEM:
${question.text || ''}

CLAUSES (clauseId, label, text):
${clauseLines}`;
}

// ── Server-side validation of the model proposal ────────────
function validateAndShape(raw, { clauses, topics }) {
  const topicIdSet = new Set(topics.map(t => t.id));
  const clauseIds = (clauses || []).map(c => c.id);
  const clauseIdSet = new Set(clauseIds);
  const keepTopics = (arr) => Array.isArray(arr) ? arr.filter(id => topicIdSet.has(id)) : [];

  let relatedness = ['single', 'dependent', 'independent'].includes(raw.relatedness) ? raw.relatedness : 'single';
  // No clauses ⇒ force single regardless of what the model said.
  if (!clauseIds.length) relatedness = 'single';

  const confidence = typeof raw.confidence === 'number'
    ? Math.max(0, Math.min(1, raw.confidence)) : 0.5;
  const reasoning = String(raw.reasoning || '').slice(0, 400);

  if (relatedness === 'independent') {
    const seen = new Map();
    (Array.isArray(raw.perClause) ? raw.perClause : []).forEach(pc => {
      if (pc && clauseIdSet.has(pc.clauseId)) seen.set(pc.clauseId, keepTopics(pc.topicIds));
    });
    // Backfill any clause the model skipped with the modal topic (or empty).
    const modal = modalTopic([...seen.values()].flat());
    const perClause = clauseIds.map(id => ({
      clauseId: id,
      topicIds: (seen.get(id)?.length ? seen.get(id) : (modal ? [modal] : [])),
    }));
    return { scope: 'clause', relatedness, confidence, reasoning, perClause };
  }

  // single | dependent ⇒ question-level.
  return {
    scope: 'question',
    relatedness,
    confidence,
    reasoning,
    questionTopicIds: keepTopics(raw.questionTopicIds),
  };
}

function modalTopic(ids) {
  const counts = new Map();
  ids.forEach(id => counts.set(id, (counts.get(id) || 0) + 1));
  let best = null, bestN = 0;
  counts.forEach((n, id) => { if (n > bestN) { bestN = n; best = id; } });
  return best;
}

// ── Main handler ────────────────────────────────────────────
export default async (request, _context) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'Method Not Allowed' }, request);
  }

  const rawKey = (Deno.env.get('CLAUDE_KEY') || Deno.env.get('ANTHROPIC_API_KEY') || '').trim();
  const isGatewayJwt = rawKey.startsWith('eyJ');
  const apiKey = rawKey;
  const claudeApiUrl = isGatewayJwt
    ? (Deno.env.get('ANTHROPIC_BASE_URL') || CLAUDE_DIRECT_URL) + '/v1/messages'
    : CLAUDE_DIRECT_URL;

  if (!apiKey) {
    return jsonResponse(500, { error: 'Server misconfiguration — API key missing' }, request);
  }

  // ── Authenticate caller via Firebase ID token ──
  const isLocalDev = Deno.env.get('NETLIFY_DEV') === 'true';
  const authHeader = request.headers.get('Authorization') || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) return jsonResponse(401, { error: 'Unauthorized: missing token' }, request);

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
        return jsonResponse(403, { error: 'Forbidden: instructor or admin role required' }, request);
      }
    } catch (_e) {
      return jsonResponse(401, { error: 'Unauthorized: token verification failed' }, request);
    }
  }

  // ── Parse body ──
  let body;
  try { body = await request.json(); }
  catch (_e) { return jsonResponse(400, { error: 'Invalid JSON body' }, request); }

  const { question, clauses, topics, model: requestedModel } = body || {};
  if (!question || typeof question.text !== 'string') {
    return jsonResponse(400, { error: 'Missing required field: question.text' }, request);
  }
  if (!Array.isArray(topics) || !topics.length) {
    return jsonResponse(400, { error: 'Missing required field: topics (non-empty array)' }, request);
  }
  const safeClauses = Array.isArray(clauses) ? clauses : [];

  const messages = [{
    role: 'user',
    content: buildUserMessage({ question, clauses: safeClauses, topics }),
  }];

  const modelsToTry = requestedModel && CLAUDE_MODELS.includes(requestedModel)
    ? [requestedModel] : CLAUDE_MODELS;

  let lastErr = null;

  for (let i = 0; i < modelsToTry.length; i++) {
    const model = modelsToTry[i];
    try {
      const requestBody = JSON.stringify({
        model,
        max_tokens: CLAUDE_MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages,
        tools: [CATEGORIZE_TOOL],
        tool_choice: { type: 'tool', name: TOOL_NAME },
      });

      let response = null;
      let transientErr = null;
      for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
        response = await fetch(claudeApiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: requestBody,
        });
        if (response.ok) { transientErr = null; break; }

        const errText = await response.text().catch(() => '');
        let errMsg = `${model}: HTTP ${response.status}`;
        try { const d = JSON.parse(errText); errMsg = d.error?.message || errMsg; } catch (_e) { /* ignore */ }

        if (response.status === 529 || response.status >= 500) {
          transientErr = { status: response.status, msg: errMsg };
          if (attempt < BACKOFF_MS.length) {
            await sleep(BACKOFF_MS[attempt] + Math.floor(Math.random() * 400));
            continue;
          }
          break;
        }
        return jsonResponse(response.status, { error: errMsg }, request);
      }

      if (transientErr) {
        lastErr = transientErr.msg;
        if (requestedModel) return jsonResponse(transientErr.status, { error: transientErr.msg, retryable: true }, request);
        continue;
      }

      const data = await response.json();
      let parsed = data.content?.find(c => c.type === 'tool_use' && c.name === TOOL_NAME)?.input || null;

      if (!parsed || typeof parsed !== 'object') {
        lastErr = `${model}: AI returned invalid format`;
        if (requestedModel) return jsonResponse(422, { error: lastErr, retryable: true }, request);
        continue;
      }

      const proposal = validateAndShape(parsed, { clauses: safeClauses, topics });

      return jsonResponse(200, {
        proposal,
        questionId: question.id || null,
        usage: data.usage,
        model,
      }, request);

    } catch (err) {
      lastErr = err.message;
      if (requestedModel) return jsonResponse(502, { error: lastErr, retryable: true }, request);
      continue;
    }
  }

  return jsonResponse(502, { error: lastErr || 'כל המודלים נכשלו' }, request);
};

// ── Utilities ───────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://vaultau.netlify.app',
  'http://localhost:8888',
];
const NETLIFY_PREVIEW_RE = /^https:\/\/[a-z0-9-]+--vaultau\.netlify\.app$/;

function corsHeaders(request) {
  const origin = request?.headers?.get('origin') || '';
  const isAllowed = ALLOWED_ORIGINS.includes(origin) || NETLIFY_PREVIEW_RE.test(origin);
  const allowedOrigin = isAllowed ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
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
  path: '/api/categorize-question',
};
