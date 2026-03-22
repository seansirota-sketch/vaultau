/* ============================================================
   netlify/edge-functions/generate-question.js
   Netlify Edge Function — streams Gemini API responses so the
   API key stays server-side and there's no 26-second timeout.

   Environment Variables (Netlify → Site Settings):
     GEMINI_API_KEY     — Google Gemini API key
     FIREBASE_WEB_API_KEY — Firebase project web API key (used to verify ID tokens)
   ============================================================ */

const GEMINI_MODEL = 'gemini-3.1-pro-preview';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse`;

export default async (request, context) => {
  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    });
  }

  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: corsHeaders() });
  }

  // ── Authenticate caller ──────────────────────────────────────
  const authHeader = request.headers.get('Authorization') || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) {
    return jsonResponse(401, { error: 'Unauthorized: missing token' });
  }
  const firebaseWebApiKey = Deno.env.get('FIREBASE_WEB_API_KEY');
  if (!firebaseWebApiKey) {
    return jsonResponse(500, { error: 'Server misconfiguration: missing Firebase key' });
  }
  try {
    const verifyRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${firebaseWebApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      }
    );
    if (!verifyRes.ok) {
      return jsonResponse(401, { error: 'Unauthorized: invalid or expired token' });
    }
    const verifyData = await verifyRes.json();
    if (!verifyData?.users?.length) {
      return jsonResponse(401, { error: 'Unauthorized: user not found' });
    }
  } catch {
    return jsonResponse(401, { error: 'Unauthorized: token verification failed' });
  }
  // ────────────────────────────────────────────────────────────

  try {
    const { prompt } = await request.json();
    if (!prompt || typeof prompt !== 'string') {
      return jsonResponse(400, { error: 'Missing or invalid prompt' });
    }

    const apiKey = Deno.env.get('GEMINI_API_KEY');
    if (!apiKey) {
      return jsonResponse(500, { error: 'Gemini API key not configured' });
    }

    const geminiRes = await fetch(`${GEMINI_URL}&key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.65, maxOutputTokens: 16384 },
      }),
    });

    if (!geminiRes.ok) {
      const errData = await geminiRes.json().catch(() => ({}));
      const errMsg = errData?.error?.message || `Gemini API returned HTTP ${geminiRes.status}`;
      return jsonResponse(geminiRes.status, { error: errMsg });
    }

    // Stream the SSE response from Gemini back to the client
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    // Process the Gemini SSE stream in the background
    (async () => {
      try {
        const reader = geminiRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

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
              const chunk = JSON.parse(json);
              const text = chunk?.candidates?.[0]?.content?.parts?.[0]?.text;
              if (text) {
                await writer.write(encoder.encode(`data: ${JSON.stringify({ text })}\n\n`));
              }
            } catch {
              // skip malformed chunks
            }
          }
        }

        // Process any remaining buffer
        if (buffer.startsWith('data: ')) {
          const json = buffer.slice(6).trim();
          if (json && json !== '[DONE]') {
            try {
              const chunk = JSON.parse(json);
              const text = chunk?.candidates?.[0]?.content?.parts?.[0]?.text;
              if (text) {
                await writer.write(encoder.encode(`data: ${JSON.stringify({ text })}\n\n`));
              }
            } catch { /* skip */ }
          }
        }

        await writer.write(encoder.encode('data: [DONE]\n\n'));
      } catch (err) {
        try {
          await writer.write(encoder.encode(`data: ${JSON.stringify({ error: err.message })}\n\n`));
        } catch { /* writer may be closed */ }
      } finally {
        try { await writer.close(); } catch { /* already closed */ }
      }
    })();

    return new Response(readable, {
      status: 200,
      headers: {
        ...corsHeaders(),
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });

  } catch (err) {
    return jsonResponse(500, { error: err.message || 'Server error' });
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  });
}

export const config = {
  path: '/api/generate-question',
};
