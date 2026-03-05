/* ============================================================
   EXAM BANK  —  admin.js  (Firebase + Claude API edition)
   Requires: firebase-config.js loaded first (via script tag)
   ============================================================ */

/* ── UTILS ─────────────────────────────────────────────────── */
function esc(s) {
  if (!s && s !== 0) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function toast(msg, type = '') {
  const c = document.getElementById('toast-wrap');
  if (!c) return;
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.remove(), 2800);
}

const ICONS = ['📐','📊','⚛️','🧮','🔬','🧬','💻','🌍','🏛️','📖',
               '🎓','🔭','📈','🧪','🔢','📜','🗓️','🖥️','🎯','⚙️'];
function randIcon() { return ICONS[Math.floor(Math.random() * ICONS.length)]; }

/* ── FIREBASE AUTH (Admin login) ───────────────────────────── */
let adminUser = null; // Firebase user object

function showLoginScreen() {
  document.getElementById('adm-login').style.display = '';
  document.getElementById('adm-app').style.display   = 'none';
}

function showAdminApp() {
  document.getElementById('adm-login').style.display = 'none';
  document.getElementById('adm-app').style.display   = 'flex';
  initAdmin();
}

async function adminLogin() {
  const email = document.getElementById('adm-email').value.trim();
  const pass  = document.getElementById('adm-pass').value;
  const err   = document.getElementById('adm-err');
  err.classList.remove('show');

  if (!email || !pass) {
    err.textContent = 'נא למלא אימייל וסיסמה';
    err.classList.add('show');
    return;
  }

  const btn = document.querySelector('#adm-login .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = 'מתחבר...'; }

  try {
    const cred = await auth.signInWithEmailAndPassword(email, pass);

    // Check admin whitelist
    if (!ADMIN_EMAILS.includes(cred.user.email)) {
      await auth.signOut();
      err.textContent = 'אין הרשאת גישה לפאנל הניהול';
      err.classList.add('show');
      return;
    }

    adminUser = cred.user;
    showAdminApp();
  } catch (e) {
    const messages = {
      'auth/user-not-found':  'אימייל לא קיים במערכת',
      'auth/wrong-password':  'סיסמה שגויה',
      'auth/invalid-email':   'פורמט אימייל לא תקין',
      'auth/too-many-requests': 'יותר מדי ניסיונות — נסה שוב מאוחר יותר',
    };
    err.textContent = messages[e.code] || 'שגיאת התחברות: ' + e.message;
    err.classList.add('show');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'כניסה ←'; }
  }
}

async function adminLogout() {
  await auth.signOut();
  adminUser = null;
  showLoginScreen();
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('adm-pass')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') adminLogin();
  });
  document.getElementById('adm-email')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') adminLogin();
  });

  // Listen for auth state changes
  auth.onAuthStateChanged(async (user) => {
    if (user && ADMIN_EMAILS.includes(user.email)) {
      adminUser = user;
      showAdminApp();
    } else {
      showLoginScreen();
    }
  });
});

/* ── INIT ─────────────────────────────────────────────────── */
async function initAdmin() {
  try {
    await populateAllSelects();
    await refreshDashboard();
    await renderManageTable();
    await renderCoursesList();
    setupUploadZone();
  } catch (e) {
    console.error('Init error:', e);
    toast('שגיאה בטעינה: ' + e.message, 'error');
  }
}

/* ── NAV ─────────────────────────────────────────────────── */
function showSection(name) {
  document.querySelectorAll('.adm-section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.admin-nav a').forEach(a => a.classList.remove('active'));
  const sec = document.getElementById('sec-' + name);
  if (sec) sec.classList.add('active');
  const nav = document.getElementById('nav-' + name);
  if (nav) nav.classList.add('active');
  if (name === 'manage')    renderManageTable();
  if (name === 'dashboard') refreshDashboard();
  if (name === 'courses')   renderCoursesList();
  if (name === 'add-exam')  populateAllSelects();
}

async function populateAllSelects() {
  try {
    const courses = await fetchCourses();
    const opts = courses.map(c =>
      `<option value="${c.id}">${esc(c.name)} (${esc(c.code)})</option>`
    ).join('');
    ['ae-course', 'manage-filter'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML =
        (id === 'manage-filter' ? '<option value="">כל הקורסים</option>' :
          '<option value="">-- בחר קורס --</option>') + opts;
    });
  } catch (e) {
    console.error(e);
  }
}

/* ══════════════════════════════════════════════════════════
   PARSER ENGINE  (unchanged from original — local parsing)
══════════════════════════════════════════════════════════ */

function parseExamText(raw) {
  if (!raw || !raw.trim()) return [];
  let text = cleanLyX(raw);
  const blocks = splitIntoQuestions(text);
  return blocks.map(({ index, body }) => {
    const { mainText, subs } = parseSubQuestions(body.trim());
    return {
      id:    genId(),
      index,
      text:  mainText.trim(),
      subs:  subs.map(s => ({ id: genId(), label: s.label, text: s.text }))
    };
  }).filter(q => q.text.length > 1 || q.subs.length > 0);
}

function cleanLyX(text) {
  return text
    .replace(/\\begin_layout\s+\w+/g, '')
    .replace(/\\end_layout/g, '\n')
    .replace(/\\begin_inset\s+\w+[^\n]*/g, '')
    .replace(/\\end_inset/g, '')
    .replace(/\\begin_body/g, '')
    .replace(/\\end_body/g, '')
    .replace(/\\begin_document/g, '')
    .replace(/\\end_document/g, '')
    .replace(/\\lyxformat\s+\d+/g, '')
    .replace(/\\textclass\s+\w+/g, '')
    .replace(/\\use_\w+[^\n]*/g, '')
    .replace(/\\language\s+\w+/g, '')
    .replace(/\\inputencoding[^\n]*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitIntoQuestions(text) {
  const hePattern = /(?:^|\n)\s*(שאלה\s*\d+)/mu;
  if (hePattern.test(text)) {
    const parts = text.split(/(?=(?:^|\n)\s*שאלה\s*\d+)/mu);
    const result = [];
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const numMatch = trimmed.match(/^שאלה\s*(\d+)/u);
      const index = numMatch ? parseInt(numMatch[1]) : result.length + 1;
      const body = trimmed.replace(/^שאלה\s*\d+\s*[:\.\-–]?\s*/u, '').trim();
      if (body.length > 1) result.push({ index, body });
    }
    if (result.length > 1) return result;
  }

  const enPattern = /(?:^|\n)\s*(?:question|problem|ex\.?|exercise)\s*\d+/mi;
  if (enPattern.test(text)) {
    const parts = text.split(/(?=(?:^|\n)\s*(?:question|problem|ex\.?|exercise)\s*\d+)/mi);
    const result = [];
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const numMatch = trimmed.match(/^(?:question|problem|ex\.?|exercise)\s*(\d+)/i);
      const index = numMatch ? parseInt(numMatch[1]) : result.length + 1;
      const body = trimmed.replace(/^(?:question|problem|ex\.?|exercise)\s*\d+\s*[:\.\-–]?\s*/i, '').trim();
      if (body.length > 1) result.push({ index, body });
    }
    if (result.length > 1) return result;
  }

  const numPattern = /(?:^|\n)\s*\d+\s*[\.)\]]\s+/m;
  if (numPattern.test(text)) {
    const parts = text.split(/(?=(?:^|\n)\s*\d+\s*[\.)\]]\s)/m);
    const result = [];
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const numMatch = trimmed.match(/^(\d+)\s*[\.)\]]\s+/);
      const index = numMatch ? parseInt(numMatch[1]) : result.length + 1;
      const body = trimmed.replace(/^\d+\s*[\.)\]]\s+/, '').trim();
      if (body.length > 1) result.push({ index, body });
    }
    if (result.length > 1) return result;
  }

  const paragraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(p => p.length > 3);
  return paragraphs.map((body, i) => ({ index: i + 1, body }));
}

function parseSubQuestions(block) {
  let fixed = block
    .replace(/\)\s*([א-תa-zA-Z])\s*\(\s*$/gmu, '\n($1) ')
    .replace(/\)\s*([א-תa-zA-Z])\s*\(\s*/g, '\n($1) ');
  fixed = fixed.replace(/\(([א-תa-zA-Z])\)(?!\s*\))/g, '($1) ');
  const SUB = /(?:^|\n)\s*\(([א-תa-zA-Z])\)\s+/gmu;
  const matches = [...fixed.matchAll(SUB)];
  if (!matches.length) return { mainText: block.trim(), subs: [] };
  const firstPos = matches[0].index;
  const mainText = fixed.slice(0, firstPos).trim();
  const subs = [];
  for (let i = 0; i < matches.length; i++) {
    const m     = matches[i];
    const label = '(' + m[1] + ')';
    const start = m.index + m[0].length;
    const end   = (i + 1 < matches.length) ? matches[i + 1].index : fixed.length;
    const text  = fixed.slice(start, end).trim();
    if (label && text) subs.push({ label, text });
  }
  return { mainText, subs };
}

function inferExamMeta(title) {
  const meta = { year: '', semester: '', moed: '' };
  if (!title) return meta;
  const yearMatch = title.match(/\b(20\d{2}|19\d{2})\b/);
  if (yearMatch) meta.year = yearMatch[1];
  const shortPattern = title.match(/(?:20|19)\d{2}([א-ב]|[AB])?([א-ג]|[ABC])?/i);
  if (shortPattern) {
    if (shortPattern[1]) {
      const s = shortPattern[1].toUpperCase();
      meta.semester = s === 'A' ? 'א' : s === 'B' ? 'ב' : shortPattern[1];
    }
    if (shortPattern[2]) {
      const m = shortPattern[2].toUpperCase();
      meta.moed = m === 'A' ? 'א' : m === 'B' ? 'ב' : m === 'C' ? 'ג' : shortPattern[2];
    }
  }
  if (!meta.semester) {
    if (/סמסטר\s*א|semester\s*a/i.test(title))    meta.semester = 'א';
    else if (/סמסטר\s*ב|semester\s*b/i.test(title)) meta.semester = 'ב';
    else if (/קיץ|summer/i.test(title))              meta.semester = 'קיץ';
  }
  if (!meta.moed) {
    if (/מועד\s*א|moed\s*a/i.test(title))    meta.moed = 'א';
    else if (/מועד\s*ב|moed\s*b/i.test(title)) meta.moed = 'ב';
    else if (/מועד\s*ג|moed\s*c/i.test(title)) meta.moed = 'ג';
  }
  return meta;
}

/* ══════════════════════════════════════════════════════════
   CLAUDE API  (via your backend endpoint)
══════════════════════════════════════════════════════════ */

/**
 * Send exam text to your Claude backend and receive parsed questions JSON.
 * @param {string} text  - Raw exam text (LaTeX / plain)
 * @param {Object} [opts] - Optional: { isPDF, base64, titleHint }
 * @returns {Promise<Array>} - Array of question objects
 */
async function processWithClaude(text, opts = {}) {
  const titleHint = opts.titleHint ? `שם/קוד המבחן: "${opts.titleHint}". ` : '';

  const prompt = `${titleHint}אתה מנתח מבחן אקדמי. שלוף את כל השאלות והסעיפים.

החזר JSON בלבד (ללא markdown, ללא טקסט נוסף) בפורמט הזה בדיוק:
{"questions":[{"number":1,"text":"טקסט שאלה ראשית (ריק אם אין)","parts":[{"letter":"א","text":"טקסט סעיף"}]}]}

הוראות:
- שלוף את כל השאלות
- אם לשאלה יש סעיפים (א)(ב)(ג) — כלול ב-parts
- אם אין סעיפים — parts יהיה []
- נוסחאות מתמטיות: LaTeX עם $...$ או $$...$$
- שמור על הטקסט העברי המקורי
- החזר JSON תקני בלבד

טקסט המבחן:
${text}`;

  const body = {
    text: prompt,
    ...(opts.isPDF  && { isPDF:  true }),
    ...(opts.base64 && { base64: opts.base64 }),
  };

  const response = await fetch(CLAUDE_ENDPOINT, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData.error || errData.message || `שגיאת שרת (${response.status})`);
  }

  const data = await response.json();

  // Support multiple response shapes from different backends
  let jsonStr = '';
  if (typeof data === 'string') {
    jsonStr = data;
  } else if (data.result) {
    jsonStr = typeof data.result === 'string' ? data.result : JSON.stringify(data.result);
  } else if (data.content) {
    // Anthropic-style passthrough
    jsonStr = (data.content.find(c => c.type === 'text')?.text || '').trim();
  } else if (data.questions) {
    return _normalizeQuestions(data);
  }

  // Strip markdown fences if present
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    const m = jsonStr.match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]);
    else throw new Error('תגובת AI לא תקנית — לא ניתן לפרסר JSON');
  }

  return _normalizeQuestions(parsed);
}

function _normalizeQuestions(parsed) {
  return (parsed.questions || []).map((q, i) => ({
    id:    genId(),
    index: q.number || i + 1,
    text:  q.text || '',
    subs:  (q.parts || []).map(p => ({
      id:    genId(),
      label: '(' + (p.letter || '') + ')',
      text:  p.text || ''
    }))
  }));
}

/* ══════════════════════════════════════════════════════════
   PDF EXTRACTION  (pdf.js — unchanged)
══════════════════════════════════════════════════════════ */

let pdfjsLib = null;

function initPdfJs() {
  if (typeof window.pdfjsLib !== 'undefined') {
    pdfjsLib = window.pdfjsLib;
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }
}

async function extractTextFromPDF(file) {
  if (!pdfjsLib) initPdfJs();
  if (!pdfjsLib) throw new Error('pdf.js לא נטען');
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let fullText = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page   = await pdf.getPage(i);
    const tc     = await page.getTextContent();
    const pageText = tc.items.map(item => item.str).join(' ');
    fullText += pageText + '\n\n';
  }
  return fullText;
}

/* ── Progress bar helper ───────────────────────────────── */
function setProgress(pct) {
  const bar  = document.getElementById('parse-progress');
  const wrap = document.getElementById('progress-wrap');
  if (bar)  bar.style.width = pct + '%';
  if (wrap) wrap.style.display = (pct > 0 && pct < 100) ? 'block' : 'none';
}

/* ── AI Spinner overlay helper ──────────────────────────── */
function showSpinner(msg = '🤖 Claude מנתח...') {
  let overlay = document.getElementById('ai-spinner-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'ai-spinner-overlay';
    overlay.className = 'ai-spinner-overlay';
    overlay.innerHTML = `
      <div class="ai-spinner-card">
        <div class="ai-spinner-ring"></div>
        <div class="ai-spinner-msg" id="ai-spinner-msg">${msg}</div>
      </div>`;
    document.body.appendChild(overlay);
  } else {
    document.getElementById('ai-spinner-msg').textContent = msg;
  }
  overlay.classList.add('visible');
}

function hideSpinner() {
  document.getElementById('ai-spinner-overlay')?.classList.remove('visible');
}

/* ── Upload Zone ─────────────────────────────────────────── */
function setupUploadZone() {
  const zone = document.getElementById('upload-zone');
  if (!zone) return;
  zone.addEventListener('click', () => document.getElementById('pdf-input')?.click());
  zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
  zone.addEventListener('dragenter', e => { e.preventDefault(); zone.classList.add('drag'); });
  zone.addEventListener('drop', e => {
    e.preventDefault(); zone.classList.remove('drag');
    const file = e.dataTransfer.files[0];
    if (file) handleFileInput(file);
  });
  const inp = document.getElementById('pdf-input');
  if (inp) inp.addEventListener('change', e => {
    if (e.target.files[0]) handleFileInput(e.target.files[0]);
  });
}

async function handleFileInput(file) {
  const statusEl = document.getElementById('upload-status');
  const zone     = document.getElementById('upload-zone');
  const setStatus = (msg, color = 'var(--primary)') => {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.style.color = color;
    statusEl.style.display = 'block';
  };

  if (zone) {
    const t = zone.querySelector('.uz-text');
    const s = zone.querySelector('.uz-sub');
    if (t) t.textContent = `📎 ${file.name}`;
    if (s) s.textContent = `${(file.size / 1024).toFixed(0)} KB — ממתין לניתוח AI...`;
  }

  setStatus('📤 ממיר קובץ...');
  setProgress(15);
  showSpinner('📤 קורא קובץ...');

  try {
    const base64 = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload  = () => res(r.result.split(',')[1]);
      r.onerror = () => rej(new Error('קריאת קובץ נכשלה'));
      r.readAsDataURL(file);
    });

    setProgress(30);
    showSpinner('🤖 Claude מנתח את המבחן...');
    setStatus('🤖 Claude מנתח את המבחן...');

    const isPDF = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    const titleHint = document.getElementById('ae-title')?.value?.trim() || '';

    // Extract text from PDF first (for text PDFs), then send to Claude
    let rawText = '';
    if (isPDF) {
      try {
        rawText = await extractTextFromPDF(file);
        if (rawText.trim().length < 80) rawText = ''; // likely scanned
      } catch { rawText = ''; }
    }

    setProgress(50);

    let questions;
    if (rawText.trim().length > 80) {
      // Text-based PDF — send extracted text to Claude
      questions = await processWithClaude(rawText, { titleHint });
    } else {
      // Binary PDF or very short — send base64
      questions = await processWithClaude('', { isPDF: true, base64, titleHint });
    }

    setProgress(90);
    parsedQuestions = questions;

    if (titleHint) {
      const meta = inferExamMeta(titleHint);
      if (meta.year     && !document.getElementById('ae-year').value)  document.getElementById('ae-year').value     = meta.year;
      if (meta.semester && !document.getElementById('ae-sem').value)   document.getElementById('ae-sem').value      = meta.semester;
      if (meta.moed     && !document.getElementById('ae-moed').value)  document.getElementById('ae-moed').value     = meta.moed;
    }

    setProgress(100);
    setStatus(`✅ זוהו ${parsedQuestions.length} שאלות`, 'var(--success)');
    renderPreview();
    toast(`✅ AI זיהה ${parsedQuestions.length} שאלות`, 'success');
    setTimeout(() => { if (statusEl) statusEl.style.display = 'none'; }, 3500);

  } catch (err) {
    console.error(err);
    setStatus('❌ ' + err.message, 'var(--danger)');
    setProgress(0);
    toast('שגיאה: ' + err.message, 'error');
  } finally {
    hideSpinner();
  }
}

/* ── Live text parser ─────────────────────────────────────── */
let parsedQuestions = [];

async function runParser() {
  const raw = document.getElementById('raw-text')?.value || '';
  if (!raw.trim()) { toast('הטקסט ריק', 'error'); return; }

  const btn      = document.getElementById('parse-btn');
  const statusEl = document.getElementById('upload-status');

  if (btn) { btn.disabled = true; btn.textContent = '⏳ מנתח...'; }
  if (statusEl) { statusEl.textContent = '🤖 AI מנתח טקסט...'; statusEl.style.display = 'block'; }
  setProgress(30);
  showSpinner('🤖 Claude מנתח טקסט...');

  try {
    const titleHint = document.getElementById('ae-title')?.value?.trim() || '';
    parsedQuestions = await processWithClaude(raw, { titleHint });

    setProgress(100);
    if (statusEl) statusEl.textContent = `✅ זוהו ${parsedQuestions.length} שאלות`;

    if (titleHint) {
      const meta = inferExamMeta(titleHint);
      if (meta.year     && !document.getElementById('ae-year').value)  document.getElementById('ae-year').value     = meta.year;
      if (meta.semester && !document.getElementById('ae-sem').value)   document.getElementById('ae-sem').value      = meta.semester;
      if (meta.moed     && !document.getElementById('ae-moed').value)  document.getElementById('ae-moed').value     = meta.moed;
    }

    renderPreview();
    toast(`✅ AI זיהה ${parsedQuestions.length} שאלות`, 'success');
    setTimeout(() => { if (statusEl) statusEl.style.display = 'none'; }, 3000);

  } catch (err) {
    console.error(err);
    if (statusEl) { statusEl.textContent = '❌ ' + err.message; statusEl.style.color = 'var(--danger)'; }
    setProgress(0);
    toast('שגיאה: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🤖 נתח עם AI'; }
    hideSpinner();
  }
}

/* ── Preview rendering ─────────────────────────────────────── */
function renderPreview() {
  const container = document.getElementById('preview-container');
  const countEl   = document.getElementById('preview-count');
  const grid      = document.getElementById('preview-grid');
  if (!container || !grid) return;

  if (!parsedQuestions.length) {
    container.style.display = 'none';
    toast('לא זוהו שאלות — נסה מפריד אחר', 'error');
    return;
  }

  container.style.display = 'block';
  if (countEl) countEl.textContent = `זוהו ${parsedQuestions.length} שאלות`;

  parsedQuestions.forEach((q, i) => { if (!q.index) q.index = i + 1; });

  grid.innerHTML = parsedQuestions.map((q, i) => `
    <div class="pq-card" id="pqc-${i}">
      <div class="pq-header">
        <div class="pq-num">שאלה ${q.index || (i + 1)}</div>
        <div class="pq-actions">
          <button class="btn btn-sm btn-secondary" onclick="addSubToPreview(${i})">+ סעיף</button>
          <button class="btn btn-sm btn-danger" onclick="removeQuestion(${i})">🗑️</button>
        </div>
      </div>
      ${(q.text && q.text.trim())
        ? `<div style="font-size:.78rem;color:var(--muted);margin:.6rem 1.1rem .2rem;font-weight:600">טקסט פתיחה (אופציונלי):</div>
           <textarea class="pq-textarea" id="qt-${i}" rows="2"
             oninput="parsedQuestions[${i}].text=this.value">${esc(q.text)}</textarea>`
        : `<input type="hidden" id="qt-${i}" value="">`}
      ${q.subs.length ? renderSubsPreview(q.subs, i) : `
        <div style="font-size:.78rem;color:var(--muted);margin:.6rem 1.1rem .2rem;font-weight:600">תוכן השאלה:</div>
        <textarea class="pq-textarea" id="qbody-${i}" rows="4"
          oninput="ensureBody(${i},this.value)"
          placeholder="טקסט השאלה כאן...">${esc(q._body || q.text)}</textarea>`}
    </div>`).join('');

  if (window.MathJax) MathJax.typesetPromise([grid]);
}

function ensureBody(qi, val) { parsedQuestions[qi].text = val; }

function renderSubsPreview(subs, qi) {
  const heLetters = ['א','ב','ג','ד','ה','ו','ז','ח','ט','י','כ','ל'];
  return `<div class="sub-preview" id="static-subs-${qi}">
    <div style="font-size:.78rem;color:var(--muted);margin:.55rem 1.1rem .3rem;font-weight:600">סעיפים:</div>
    ${subs.map((s, si) => `
    <div class="sub-preview-item" style="margin:0 1.1rem .5rem">
      <span class="sub-preview-lbl">${esc(s.label || ('(' + (heLetters[si] || si + 1) + ')'))}</span>
      <textarea class="pq-textarea" style="min-height:52px;flex:1" id="st-${qi}-${si}"
        oninput="parsedQuestions[${qi}].subs[${si}].text=this.value">${esc(s.text)}</textarea>
      <button class="btn-icon btn-sm" style="background:var(--danger-l);color:var(--danger);margin-right:.3rem;flex-shrink:0"
        onclick="removeSub(${qi},${si})" title="מחק סעיף">✕</button>
    </div>`).join('')}
  </div>`;
}

function addSubToPreview(qi) {
  const heLetters = ['א','ב','ג','ד','ה','ו','ז','ח','ט','י','כ','ל'];
  const n = parsedQuestions[qi].subs.length;
  parsedQuestions[qi].subs.push({ id: genId(), label: '(' + (heLetters[n] || String(n + 1)) + ')', text: '' });
  renderPreview();
  setTimeout(() => document.getElementById(`pqc-${qi}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
}

function removeSub(qi, si)  { parsedQuestions[qi].subs.splice(si, 1); renderPreview(); }
function removeQuestion(i)  { parsedQuestions.splice(i, 1); renderPreview(); }

function clearImport() {
  const rt = document.getElementById('raw-text');
  if (rt) rt.value = '';
  parsedQuestions = [];
  const c = document.getElementById('preview-container');
  if (c) c.style.display = 'none';
  setProgress(0);
}

function onTitleChange() {
  const title = document.getElementById('ae-title')?.value || '';
  const meta  = inferExamMeta(title);
  if (meta.year)     document.getElementById('ae-year').value     = meta.year;
  if (meta.semester) document.getElementById('ae-sem').value      = meta.semester;
  if (meta.moed)     document.getElementById('ae-moed').value     = meta.moed;
}

/* ══════════════════════════════════════════════════════════
   SAVE EXAM TO FIREBASE  (with Confirm & Save button)
══════════════════════════════════════════════════════════ */

async function submitAddExam() {
  const courseId = document.getElementById('ae-course').value;
  const title    = document.getElementById('ae-title').value.trim();
  const year     = document.getElementById('ae-year').value.trim();
  const sem      = document.getElementById('ae-sem').value;
  const moed     = document.getElementById('ae-moed').value;
  const lecturer = document.getElementById('ae-lecturer').value.trim();
  const err      = document.getElementById('ae-error');
  err.classList.remove('show');

  if (!courseId) { err.textContent = 'נא לבחור קורס'; err.classList.add('show'); return; }
  if (!title)    { err.textContent = 'נא להזין כותרת'; err.classList.add('show'); return; }

  // Sync textarea edits back
  parsedQuestions.forEach((q, i) => {
    const ta = document.getElementById(`qt-${i}`);
    if (ta) q.text = ta.value;
    q.subs.forEach((s, si) => {
      const sta = document.getElementById(`st-${i}-${si}`);
      if (sta) s.text = sta.value;
    });
  });

  if (!parsedQuestions.length) {
    const raw = document.getElementById('raw-text')?.value || '';
    if (raw.trim()) parsedQuestions = parseExamText(raw);
  }

  const questions = parsedQuestions.filter(q => q.text || q.subs.length);
  if (!questions.length && !confirm('לא זוהו שאלות. לשמור מבחן ריק?')) return;

  // ── Confirm before saving ──────────────────────────────
  if (!confirm(`לשמור את המבחן "${title}" עם ${questions.length} שאלות ל-Firebase?`)) return;

  const saveBtn = document.querySelector('[onclick="submitAddExam()"]');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '💾 שומר...'; }
  showSpinner('💾 שומר מבחן ל-Firebase...');

  try {
    const examId = genId();
    const exam   = {
      id:        examId,
      courseId,
      title,
      year:      year ? parseInt(year) : null,
      semester:  sem  || null,
      moed:      moed || null,
      lecturer:  lecturer || null,
      questions: questions.map(q => ({
        id:   q.id || genId(),
        text: q.text,
        subs: (q.subs || []).map(s => ({
          id:    s.id || genId(),
          label: s.label,
          text:  s.text
        }))
      })),
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      createdBy: adminUser?.email || 'admin',
    };

    await db.collection('exams').doc(examId).set(exam);

    toast(`✅ מבחן נשמר — ${exam.questions.length} שאלות`, 'success');
    resetForm();
    await refreshDashboard();
  } catch (e) {
    console.error(e);
    toast('שגיאת שמירה: ' + e.message, 'error');
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '💾 שמור מבחן'; }
    hideSpinner();
  }
}

function resetForm() {
  ['ae-course','ae-sem','ae-moed'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  ['ae-title','ae-year','ae-lecturer'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  clearImport();
  document.getElementById('ae-error')?.classList.remove('show');
}

/* ══════════════════════════════════════════════════════════
   DASHBOARD
══════════════════════════════════════════════════════════ */

async function refreshDashboard() {
  const sg  = document.getElementById('stats-grid');
  const dcl = document.getElementById('dash-courses');
  if (sg)  sg.innerHTML  = '<div class="spinner"></div>';
  if (dcl) dcl.innerHTML = '<div class="spinner"></div>';

  try {
    const [courses, examsSnap, usersSnap] = await Promise.all([
      fetchCourses(),
      db.collection('exams').get(),
      db.collection('users').get(),
    ]);

    const totalExams = examsSnap.size;
    let   totalQs    = 0;
    examsSnap.docs.forEach(d => totalQs += (d.data().questions || []).length);
    const totalUsers = usersSnap.size;

    if (sg) sg.innerHTML = [
      ['📚', courses.length, 'קורסים'],
      ['📄', totalExams,    'מבחנים'],
      ['❓', totalQs,       'שאלות'],
      ['👥', totalUsers,    'משתמשים'],
    ].map(([icon, val, lbl]) =>
      `<div class="stat-card"><div class="stat-val">${icon} ${val}</div><div class="stat-lbl">${lbl}</div></div>`
    ).join('');

    if (!dcl) return;
    if (!courses.length) { dcl.innerHTML = '<div class="empty"><p>אין קורסים</p></div>'; return; }

    // Count exams per course
    const examsPerCourse = {};
    let   qsPerCourse    = {};
    examsSnap.docs.forEach(d => {
      const data = d.data();
      examsPerCourse[data.courseId] = (examsPerCourse[data.courseId] || 0) + 1;
      qsPerCourse[data.courseId]    = (qsPerCourse[data.courseId]    || 0) + (data.questions||[]).length;
    });

    const rows = courses.map(c => `<tr>
      <td>${esc(c.icon)} ${esc(c.name)}</td>
      <td><code>${esc(c.code)}</code></td>
      <td>${examsPerCourse[c.id] || 0}</td>
      <td>${qsPerCourse[c.id] || 0}</td>
      <td><button class="btn btn-danger btn-sm" onclick="deleteCourse('${c.id}')">🗑️</button></td>
    </tr>`).join('');

    dcl.innerHTML = `<table class="tbl">
      <thead><tr><th>קורס</th><th>קוד</th><th>מבחנים</th><th>שאלות</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table>`;
  } catch (e) {
    console.error(e);
    if (sg)  sg.innerHTML  = `<p style="color:var(--danger)">שגיאה: ${e.message}</p>`;
    if (dcl) dcl.innerHTML = `<p style="color:var(--danger)">שגיאה: ${e.message}</p>`;
  }
}

/* ══════════════════════════════════════════════════════════
   MANAGE EXAMS TABLE
══════════════════════════════════════════════════════════ */

async function renderManageTable() {
  const container = document.getElementById('manage-table');
  if (!container) return;
  container.innerHTML = '<div class="spinner"></div>';

  try {
    const filter  = document.getElementById('manage-filter')?.value || '';
    const courses = await fetchCourses();
    const courseMap = Object.fromEntries(courses.map(c => [c.id, c.name]));

    let q = db.collection('exams').orderBy('createdAt', 'desc');
    if (filter) q = q.where('courseId', '==', filter);
    const snap = await q.get();

    if (snap.empty) {
      container.innerHTML = '<div class="empty"><span class="ei">📭</span><h3>אין מבחנים</h3></div>';
      return;
    }

    const rows = snap.docs.map(d => {
      const e = { ...d.data(), id: d.id };
      return `<tr>
        <td><strong>${esc(e.title)}</strong></td>
        <td>${esc(courseMap[e.courseId] || e.courseId)}</td>
        <td>${e.year || '-'}</td>
        <td>${esc(e.semester) || '-'}</td>
        <td>${esc(e.moed) || '-'}</td>
        <td>${esc(e.lecturer) || '-'}</td>
        <td><span class="badge b-gray">${(e.questions || []).length}</span></td>
        <td>
          <button class="btn btn-sm btn-secondary" onclick="editExam('${e.courseId}','${e.id}')">✏️</button>
          <button class="btn btn-sm btn-danger" onclick="deleteExam('${e.id}')">🗑️</button>
        </td>
      </tr>`;
    }).join('');

    container.innerHTML = `<table class="tbl">
      <thead><tr><th>כותרת</th><th>קורס</th><th>שנה</th><th>סמסטר</th><th>מועד</th><th>מרצה</th><th>שאלות</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table>`;
  } catch (e) {
    container.innerHTML = `<p style="color:var(--danger)">שגיאה: ${e.message}</p>`;
    console.error(e);
  }
}

async function deleteExam(examId) {
  if (!confirm('למחוק את המבחן? פעולה זו אינה הפיכה.')) return;
  try {
    await db.collection('exams').doc(examId).delete();
    toast('🗑️ מבחן נמחק', 'error');
    renderManageTable();
    refreshDashboard();
  } catch (e) {
    toast('שגיאת מחיקה: ' + e.message, 'error');
  }
}

async function editExam(courseId, examId) {
  showSpinner('📂 טוען מבחן...');
  try {
    const exam = await fetchExam(examId);
    if (!exam) { toast('מבחן לא נמצא', 'error'); return; }

    showSection('add-exam');
    document.getElementById('ae-course').value   = courseId;
    document.getElementById('ae-title').value    = exam.title  || '';
    document.getElementById('ae-year').value     = exam.year   || '';
    document.getElementById('ae-sem').value      = exam.semester || '';
    document.getElementById('ae-moed').value     = exam.moed   || '';
    document.getElementById('ae-lecturer').value = exam.lecturer || '';

    parsedQuestions = (exam.questions || []).map(q => ({ ...q, subs: q.subs || [] }));

    // Delete original — user will re-save as new
    await db.collection('exams').doc(examId).delete();

    renderPreview();
    toast('ℹ️ המבחן נטען לעריכה — שמור כדי לעדכן', 'info');
  } catch (e) {
    toast('שגיאה: ' + e.message, 'error');
  } finally {
    hideSpinner();
  }
}

/* ══════════════════════════════════════════════════════════
   COURSES ADMIN
══════════════════════════════════════════════════════════ */

async function adminAddCourse() {
  const name = document.getElementById('c-name').value.trim();
  const code = document.getElementById('c-code').value.trim();
  if (!name || !code) { toast('נא למלא שם וקוד', 'error'); return; }

  try {
    const id = genId();
    await db.collection('courses').doc(id).set({
      id,
      name,
      code,
      icon: randIcon(),
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    document.getElementById('c-name').value = '';
    document.getElementById('c-code').value = '';
    toast('✅ קורס נוסף', 'success');
    await renderCoursesList();
    await populateAllSelects();
    await refreshDashboard();
  } catch (e) {
    toast('שגיאה: ' + e.message, 'error');
  }
}

async function renderCoursesList() {
  const el = document.getElementById('courses-list');
  if (!el) return;
  el.innerHTML = '<div class="spinner"></div>';

  try {
    const courses = await fetchCourses();
    if (!courses.length) {
      el.innerHTML = '<div class="empty"><span class="ei">📭</span><h3>אין קורסים</h3></div>';
      return;
    }

    // Count exams per course
    const snap = await db.collection('exams').get();
    const examCount = {};
    snap.docs.forEach(d => {
      const cid = d.data().courseId;
      examCount[cid] = (examCount[cid] || 0) + 1;
    });

    const rows = courses.map(c => `<tr>
      <td style="font-size:1.3rem">${esc(c.icon)}</td>
      <td><strong>${esc(c.name)}</strong></td>
      <td><code>${esc(c.code)}</code></td>
      <td>${examCount[c.id] || 0}</td>
      <td><button class="btn btn-danger btn-sm" onclick="deleteCourse('${c.id}')">🗑️</button></td>
    </tr>`).join('');

    el.innerHTML = `<table class="tbl">
      <thead><tr><th>אייקון</th><th>שם</th><th>קוד</th><th>מבחנים</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table>`;
  } catch (e) {
    el.innerHTML = `<p style="color:var(--danger)">שגיאה: ${e.message}</p>`;
  }
}

async function deleteCourse(id) {
  if (!confirm('מחיקת קורס תמחק גם את כל מבחניו. להמשיך?')) return;
  showSpinner('🗑️ מוחק קורס...');
  try {
    // Delete all exams in this course
    const examSnap = await db.collection('exams').where('courseId', '==', id).get();
    const batch = db.batch();
    examSnap.docs.forEach(d => batch.delete(d.ref));
    batch.delete(db.collection('courses').doc(id));
    await batch.commit();

    toast('🗑️ קורס נמחק', 'error');
    await renderCoursesList();
    await populateAllSelects();
    await refreshDashboard();
  } catch (e) {
    toast('שגיאת מחיקה: ' + e.message, 'error');
  } finally {
    hideSpinner();
  }
}
