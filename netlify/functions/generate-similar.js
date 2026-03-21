/* ============================================================
   netlify/functions/generate-similar.js
   מייצר שאלה דומה דרך Gemini API
   ============================================================

   הגדר ב-Netlify → Site Settings → Environment Variables:
     GEMINI_API_KEY  — מפתח מ-Google AI Studio (aistudio.google.com)
   ============================================================ */

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/* ── Rate limiting (in-memory) ── */
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX       = 20;

function isRateLimited(ip) {
  const now    = Date.now();
  const record = rateLimitMap.get(ip) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  if (now > record.resetAt) { record.count = 0; record.resetAt = now + RATE_LIMIT_WINDOW_MS; }
  record.count++;
  rateLimitMap.set(ip, record);
  return record.count > RATE_LIMIT_MAX;
}

/* ── Prompt builder ── */
function buildPrompt(questionText, partText) {
  const sourceText = partText
    ? `${questionText ? 'גוף השאלה:\n' + questionText + '\n\n' : ''}סעיף ספציפי:\n${partText}`
    : `שאלה מלאה:\n${questionText}`;

  return `אתה מומחה לכתיבת שאלות אקדמיות בעברית ברמה אוניברסיטאית.
בהינתן שאלה ממבחן — צור שאלה חדשה ומקורית שבודקת אותו ידע/מיומנות אך בנתונים ובהקשר שונים לחלוטין.

${sourceText}

══ חוקים ══
• שמור על אותה רמת קושי ואותו סוג חשיבה.
• שנה את הנתונים, הפרמטרים, ותרחיש השאלה — אל תעתיק.
• כתוב בעברית, שפה אקדמית תקנית.
• נוסחאות: $...$ לאינליין, $$...$$ להצגה מרכזית (LaTeX תקני).
• החזר JSON בלבד — ללא \`\`\`, ללא מלל לפני/אחרי.

פורמט מדויק:
{"question":"טקסט גוף השאלה (ריק אם כל התוכן בסעיפים)","parts":[{"letter":"א","text":"טקסט סעיף"}]}

אם אין סעיפים — "parts": []
אם הבקשה היא לסעיף בלבד — "question": "" ו-"parts" עם סעיף אחד.`;
}

/* ── Main handler ── */
exports.handler = async (event) => {

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  if (event.httpMethod !== 'POST') return {
    statusCode: 405, headers: CORS,
    body: JSON.stringify({ error: 'Method Not Allowed' }),
  };

  //const apiKey = process.env.GEMINI_API_KEY;
  const apiKey = "AIzaSyB9gHZO3jipyAdZeDVAMf6XGwJfyvI2Ncc";
  if (!apiKey) {
    console.error('GEMINI_API_KEY is not set!');
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server misconfiguration — API key missing' }) };
  }

  const ip = event.headers['x-forwarded-for']?.split(',')[0].trim() || 'unknown';
  if (isRateLimited(ip)) return {
    statusCode: 429,
    headers: { ...CORS, 'Retry-After': '60' },
    body: JSON.stringify({ error: 'יותר מדי בקשות — נסה שוב בעוד דקה' }),
  };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

  const { questionText, partText } = body;

  if (!questionText && !partText) return {
    statusCode: 400, headers: CORS,
    body: JSON.stringify({ error: 'Missing field: questionText or partText' }),
  };

  /* ── Call Gemini ── */
  try {
    const response = await fetch(`${GEMINI_API}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildPrompt(questionText, partText) }] }],
        generationConfig: {
          temperature:      0.5,
          maxOutputTokens: 8192,
          topP:             0.95,
          responseMimeType: 'application/json',
        },
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
        ],
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      console.error('Gemini API error:', response.status, err);
      return {
        statusCode: response.status, headers: CORS,
        body: JSON.stringify({ error: err.error?.message || 'Gemini API error' }),
      };
    }

    const data = await response.json();
    console.log('Gemini raw response:', JSON.stringify(data).slice(0, 500));

    // Check for blocked response
    if (data.promptFeedback?.blockReason) {
      console.error('Gemini blocked:', data.promptFeedback.blockReason);
      return {
        statusCode: 502, headers: CORS,
        body: JSON.stringify({ error: 'ה-AI חסם את הבקשה — נסה שוב' }),
      };
    }

    // Check for empty candidates
    const candidate = data.candidates?.[0];
    if (!candidate || candidate.finishReason === 'SAFETY') {
      console.error('Gemini returned no candidate or was blocked by safety');
      return {
        statusCode: 502, headers: CORS,
        body: JSON.stringify({ error: 'ה-AI לא הצליח לייצר תשובה — נסה שוב' }),
      };
    }

    let text = (candidate.content?.parts?.[0]?.text || '').trim();
    console.log('Gemini text extracted:', text.slice(0, 300));

    if (!text) {
      console.error('Gemini returned empty text');
      return {
        statusCode: 502, headers: CORS,
        body: JSON.stringify({ error: 'ה-AI החזיר תשובה ריקה — נסה שוב' }),
      };
    }

    // Strip markdown fences if model added them
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) text = fence[1].trim();

    // Parse JSON
    let parsed;
    try { parsed = JSON.parse(text); }
    catch {
      const objMatch = text.match(/\{[\s\S]*\}/);
      if (objMatch) try { parsed = JSON.parse(objMatch[0]); } catch {}
    }

    if (!parsed || !('question' in parsed)) {
      console.error('Gemini returned non-JSON:', text.slice(0, 500));
      return {
        statusCode: 502, headers: CORS,
        body: JSON.stringify({ error: 'תשובה לא תקינה מה-AI', raw: text.slice(0, 500) }),
      };
    }

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: parsed.question || '',
        parts:    Array.isArray(parsed.parts) ? parsed.parts : [],
      }),
    };

  } catch (err) {
    console.error('generate-similar internal error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
