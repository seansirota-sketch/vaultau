/* ============================================================
   netlify/functions/parse-exam.js
   Proxy מאובטח ל-Claude API — בנק מבחנים
   ============================================================

   ⚠️  אל תכניס את ה-API Key לקוד זה!
   הוא נקרא אוטומטית מ-Environment Variables של Netlify.
   ============================================================ */

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const MODEL      = 'claude-opus-4-5';
const MAX_TOKENS = 8192; // math exams with LaTeX can be verbose

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

/* ── Prompt builders ── */

/**
 * Original text/PDF-document prompt — questions only.
 */
function buildPrompt(text, titleHint) {
  const hint = titleHint ? `שם/קוד המבחן: "${titleHint}".\n` : '';
  const textSection = text
    ? `\n\nטקסט המבחן (עברית RTL — שים לב: הטקסט עלול להיות הפוך/מקולקל בשל בעיות חילוץ PDF; קרא אותו על-פי הקשר):\n${text}`
    : '';

  return `${hint}אתה מנתח מבחן אקדמי בעברית. משימתך: לשלוף את כל השאלות והסעיפים ולהחזיר JSON תקני בלבד.

═══ פורמט הפלט ═══
החזר JSON בלבד — ללא markdown, ללא \`\`\`, ללא טקסט לפני או אחרי.
פורמט מדויק:
{"questions":[{"number":1,"text":"טקסט גוף השאלה (ריק אם כל התוכן בסעיפים)","parts":[{"letter":"1","text":"טקסט סעיף"}]}]}

═══ חוקי זיהוי שאלות ═══
• זהה שאלות לפי: "שאלה N", "Question N", או מספר גדול N עצמאי בתחילת פסקה.
• ספור כל שאלה שמופיעה — אל תדלג על אף שאלה.

═══ חוקי זיהוי סעיפים ═══
סעיף הוא כל אחד מאלה (גם בסדר הפוך בגלל RTL):
• .1 / .2 / .3 (נקודה-מספר, נפוץ בעברית RTL)
• (1) (2) (3)
• א. ב. ג. / .א .ב .ג
• (א) (ב) (ג)
• a. b. c. / (a) (b) (c)
• i. ii. iii.
letter יהיה: "1","2","3" או "א","ב","ג" — בהתאם לפורמט המקורי.

═══ נוסחאות מתמטיות ═══
• שמור LaTeX מקורי ב-$...$ (inline) או $$...$$ (display).
• אם אין LaTeX מפורש — כתוב נוסחה בטקסט ב-$...$, למשל: $f(x) = x^2$.
• אל תמחק נוסחאות — הן חלק מהותי מהשאלה.

═══ כללים נוספים ═══
• שפה: שמור עברית מקורית — אל תתרגם, אל תפרפרז.
• אם הטקסט מקולקל/הפוך (בשל RTL) — קרא אותו לפי הקשר ובנה שאלה קוהרנטית.
• "parts" ריק ([]) אם לשאלה אין סעיפים.
• "text" ריק ("") אם כל תוכן השאלה נמצא בסעיפים בלבד.
• אל תכלול הוראות בחינה, כותרת עמוד, שם מרצה, שאלות בונוס שאינן שאלות — רק שאלות תוכן.${textSection}`;
}

/**
 * Parse exam metadata from the PDF filename.
 * Patterns: "2025AB.pdf" → year=2025, semester=א(A), moed=ב(B)
 */
function parseFilename(filename) {
  if (!filename) return {};
  const f = filename.replace(/\.[^/.]+$/, ''); // strip extension
  const result = {};

  // Year: 4-digit number starting with 20
  const yearMatch = f.match(/20\d{2}/);
  if (yearMatch) result.year = parseInt(yearMatch[0]);

  // Semester + Moed: YYYY followed immediately by two letters  e.g. 2025AB
  const shortCode = f.match(/20\d{2}([A-Za-z])([A-Za-z])/);
  if (shortCode) {
    const semLetter  = shortCode[1].toUpperCase();
    const moedLetter = shortCode[2].toUpperCase();
    const semMap  = { A: 'א', B: 'ב', S: 'קיץ', C: 'קיץ' };
    const moedMap = { A: 'א', B: 'ב', C: 'ג' };
    if (semMap[semLetter])   result.semester = semMap[semLetter];
    if (moedMap[moedLetter]) result.moed     = moedMap[moedLetter];
  }

  // Fallback: explicit keywords
  if (!result.semester) {
    if      (/sem[_-]?[a1]|semester[_-]?a|סמסטר[_-]?א/i.test(f)) result.semester = 'א';
    else if (/sem[_-]?[b2]|semester[_-]?b|סמסטר[_-]?ב/i.test(f)) result.semester = 'ב';
    else if (/summer|קיץ/i.test(f)) result.semester = 'קיץ';
  }
  if (!result.moed) {
    if      (/moed[_-]?[a1]|מועד[_-]?א/i.test(f)) result.moed = 'א';
    else if (/moed[_-]?[b2]|מועד[_-]?ב/i.test(f)) result.moed = 'ב';
    else if (/moed[_-]?[c3]|מועד[_-]?ג/i.test(f)) result.moed = 'ג';
  }

  return result;
}

/**
 * Vision prompt — sent with page images.
 * Year/semester/moed are resolved from filename; only lecturers+courseName from image.
 */
function buildVisionPrompt(filenameHint) {
  const known = parseFilename(filenameHint);

  const knownLines = [];
  if (known.year)     knownLines.push(`year: ${known.year}`);
  if (known.semester) knownLines.push(`semester: "${known.semester}"`);
  if (known.moed)     knownLines.push(`moed: "${known.moed}"`);

  const knownBlock = knownLines.length
    ? `\n⚠️ פרטים ידועים משם הקובץ ("${filenameHint}") — העתק אותם ישירות ל-JSON: ${knownLines.join(', ')}\n`
    : (filenameHint ? `\nשם הקובץ: "${filenameHint}"\n` : '');

  const yearEx  = known.year     || 2024;
  const semEx   = known.semester || 'א';
  const moedEx  = known.moed     || 'ב';
  const yearNote  = known.year     ? ` (${known.year} — אל תשנה)` : ' — 4 ספרות';
  const semNote   = known.semester ? ` ("${known.semester}" — אל תשנה)` : ' — "א"/"ב"/"קיץ"/null';
  const moedNote  = known.moed     ? ` ("${known.moed}" — אל תשנה)` : ' — "א"/"ב"/"ג"/null';

  return `אתה מומחה לחילוץ מידע ממבחנים אקדמיים בעברית.
קיבלת תמונות של עמודי מבחן.${knownBlock}

════ חלק א — מטאדאטה ════

▸ courseName — שם הקורס המלא כפי שמופיע בכותרת המבחן.

▸ lecturers — הוראות מדויקות:
  1. מצא בעמוד הראשון את השורה שמכילה "מרצים:" או "מרצה:" (עם נקודותיים).
  2. קח את כל הטקסט שמופיע אחרי הנקודותיים באותה שורה.
  3. פצל את הטקסט לפי פסיקים (,) — כל חתיכה בין פסיק לפסיק היא שם מרצה אחד.
  4. לכל שם: הסר תואר שמופיע לפניו בלבד — ד"ר / פרופ' / פרופסור / Prof. / Dr. / Assoc.
     השאר שם פרטי + שם משפחה.
  5. כל שם → פריט נפרד במערך.
  ⚠️ חשוב: אם יש 3 שמות מופרדים בפסיקים — המערך צריך להכיל 3 פריטים. אל תשמיט אף שם!
  דוגמה מדויקת: "מרצים: פרופ' יעקב יעקובוב, פרופ' אסף נחמיאס, פרופ' ארז פייטן"
  → ["יעקב יעקובוב", "אסף נחמיאס", "ארז פייטן"]   (3 פריטים, לא פחות!)

▸ year${yearNote}
▸ semester${semNote}
▸ moed${moedNote}

════ חלק ב — שאלות ════
⚠️ אל תוסיף ניקוד לאף מילה — כתוב בדיוק כפי שמופיע בדף.
⚠️ אל תכלול ניקוד נקודות כגון "(12 נק')" או "(10 points)" בתוך שדה text של שאלה או סעיף.

• $...$ בשורה, $$...$$ בשורה נפרדת
• \\begin{pmatrix}...\\end{pmatrix} למטריצות
• \\begin{cases}...\\end{cases} למערכות
• \\frac{}{}, \\sqrt{}, ^ ו-_
• סעיפים (א)(ב)(ג) / (1)(2)(3) / .א .ב .ג → שדה letter
• שאלת בונוס → isBonus: true
• אל תכלול הוראות בחינה, לוגו, מספרי עמוד

════ פלט JSON בלבד ════
ללא markdown, ללא \`\`\`, ללא טקסט לפני/אחרי.
{
  "metadata": {
    "courseName": "שם הקורס",
    "lecturers": ["שם פרטי שם משפחה"],
    "year": ${yearEx},
    "semester": "${semEx}",
    "moed": "${moedEx}"
  },
  "questions": [
    {
      "number": 1,
      "text": "טקסט ראשי ללא ניקוד",
      "isBonus": false,
      "parts": [{ "letter": "א", "text": "טקסט סעיף ללא ניקוד" }]
    }
  ]
}`;
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

  const { text, titleHint, isPDF, base64, images, filenameHint } = body;

  if (!text && !base64 && !images) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ error: 'Missing required field: text, base64, or images' }),
    };
  }

  // Guard: base64 PDF > ~4.5 MB decoded → Netlify body limit is 6 MB
  if (base64 && base64.length > 6_000_000) {
    return {
      statusCode: 413,
      headers: CORS,
      body: JSON.stringify({ error: 'PDF גדול מדי — נסה לפצל לפי עמודים (מקסימום ~4 MB)' }),
    };
  }

  /* ── Build Claude messages ── */
  let messages;

  if (images && Array.isArray(images) && images.length > 0) {
    /* Vision mode — send each page as a separate image block */
    const content = [
      { type: 'text', text: buildVisionPrompt(filenameHint || '') },
    ];
    images.forEach((imgBase64, i) => {
      content.push({
        type: 'text',
        text: `\n=== עמוד ${i + 1} ===`,
      });
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: imgBase64 },
      });
    });
    messages = [{ role: 'user', content }];

  } else if (isPDF && base64) {
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
        metadata:  parsed.metadata || null,  // included in vision mode, null otherwise
        usage:     data.usage,
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
