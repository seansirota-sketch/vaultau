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

/* ── Multi-lecturer widget ─────────────────────────────── */
let _lecturers = [];

function addLecturer() {
  const inp = document.getElementById('ae-lecturer-input');
  if (!inp) return;
  const name = inp.value.trim();
  if (!name) return;
  if (_lecturers.includes(name)) { toast('מרצה זה כבר נוסף', 'error'); inp.value = ''; return; }
  _lecturers.push(name);
  inp.value = '';
  _renderLecturersWidget();
}

function removeLecturer(idx) {
  _lecturers.splice(idx, 1);
  _renderLecturersWidget();
}

function _renderLecturersWidget() {
  const el = document.getElementById('lecturers-list');
  if (!el) return;
  el.innerHTML = _lecturers.length
    ? _lecturers.map((n, i) => `<span class="lecturer-tag">
        <span class="lecturer-tag-name">${esc(n)}</span>
        <button class="lecturer-tag-rm" onclick="removeLecturer(${i})" title="הסר">✕</button>
      </span>`).join('')
    : '<span class="lecturer-empty">לא נוספו מרצים</span>';
}

function _setLecturers(val) {
  _lecturers = Array.isArray(val) ? val.filter(Boolean)
             : (val ? [val] : []);
  _renderLecturersWidget();
}

function _fmtLecturers(val) {
  if (!val) return '-';
  return Array.isArray(val) ? val.map(esc).join(', ') : esc(val);
}

function _clearLecturers() {
  _lecturers = [];
  const inp = document.getElementById('ae-lecturer-input');
  if (inp) inp.value = '';
  _renderLecturersWidget();
}

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
  const email = document.getElementById('adm-email').value.trim().toLowerCase();
  const pass  = document.getElementById('adm-pass').value;
  const err   = document.getElementById('adm-err');
  err.classList.remove('show');

  if (!email || !pass) {
    err.textContent = 'נא למלא אימייל וסיסמה';
    err.classList.add('show');
    return;
  }

  // Pre-check: is this email an admin? (quick check before Auth round-trip)
  // Full role verification happens after sign-in via Firestore
  const btn = document.querySelector('#adm-login .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = 'מתחבר...'; }

  try {
    const cred = await auth.signInWithEmailAndPassword(email, pass);

    // Verify role from Firestore after sign-in
    const userDoc = await db.collection('users').doc(cred.user.uid).get();
    if (!userDoc.exists || userDoc.data()?.role !== 'admin') {
      await auth.signOut();
      err.textContent = 'אין הרשאת גישה לפאנל הניהול';
      err.classList.add('show');
      return;
    }

    adminUser = { ...cred.user, role: 'admin' };
    showAdminApp();
  } catch (e) {
    console.error('adminLogin error:', e.code, e.message);
    const messages = {
      'auth/user-not-found':       'אימייל לא קיים במערכת',
      'auth/wrong-password':       'סיסמה שגויה',
      'auth/invalid-credential':   'אימייל או סיסמה שגויים',
      'auth/invalid-email':        'פורמט אימייל לא תקין',
      'auth/too-many-requests':    'יותר מדי ניסיונות — נסה שוב מאוחר יותר',
      'auth/network-request-failed': 'שגיאת רשת — בדוק חיבור לאינטרנט',
    };
    err.textContent = messages[e.code] || `שגיאת התחברות (${e.code}): ${e.message}`;
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
  // Show dev-mode banner when running on localhost (emulator)
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    const banner = document.getElementById('dev-banner');
    if (banner) banner.style.display = 'block';
  }

  document.getElementById('adm-pass')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') adminLogin();
  });
  document.getElementById('adm-email')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') adminLogin();
  });

  // Listen for auth state changes
  auth.onAuthStateChanged(async (user) => {
    if (user) {
      const userDoc = await db.collection('users').doc(user.uid).get();
      if (userDoc.exists && userDoc.data()?.role === 'admin') {
        adminUser = { ...user, role: 'admin' };
        // Stamp initial history state so Back works from first section
        if (!history.state?.section) {
          history.replaceState({ section: 'dashboard' }, '');
        }
        showAdminApp();
      } else {
        showLoginScreen();
      }
    } else {
      showLoginScreen();
    }
  });

  // Browser Back / Forward — restore admin section
  window.addEventListener('popstate', (e) => {
    if (!adminUser) return; // not logged in — ignore
    const section = e.state?.section || 'dashboard';
    // Call internal _showSection without pushing another history entry
    _applySectionUI(section);
  });
});

/* ── INIT ─────────────────────────────────────────────────── */
async function initAdmin() {
  try {
    await populateAllSelects();
    await refreshDashboard();
    await renderManageTable();
    // טעינת בדאג' בקשות גישה ברקע
    _loadRequestsBadge();
    await renderCoursesList();
    setupUploadZone();
    _renderLecturersWidget();
    // ── Auto-add lecturer when user leaves the input field ───────
    const lecInp = document.getElementById('ae-lecturer-input');
    if (lecInp) {
      lecInp.addEventListener('blur', () => {
        if (lecInp.value.trim()) addLecturer();
      });
    }
  } catch (e) {
    console.error('Init error:', e);
    toast('שגיאה בטעינה: ' + e.message, 'error');
  }
}

/* ── NAV ─────────────────────────────────────────────────── */
// Internal — only updates UI, no history push (used by popstate)
function _applySectionUI(name) {
  document.querySelectorAll('.adm-section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.admin-nav a').forEach(a => a.classList.remove('active'));
  const sec = document.getElementById('sec-' + name);
  if (sec) sec.classList.add('active');
  const nav = document.getElementById('nav-' + name);
  if (nav) nav.classList.add('active');
  if (name === 'manage')      renderManageTable();
  if (name === 'dashboard')   refreshDashboard();
  if (name === 'courses')     renderCoursesList();
  if (name === 'add-exam')    populateAllSelects();
  if (name === 'analytics')   renderAnalytics();
  if (name === 'users')       renderUserStats();
  if (name === 'survey')      renderSurveyManager();
  if (name === 'permissions') renderPermissionsSection();
  if (name === 'requests')    renderRequestsSection();
}

// Public — called from nav clicks; pushes history entry
function showSection(name) {
  _applySectionUI(name);
  history.pushState({ section: name }, '');
}

async function populateAllSelects() {
  try {
    const courses = await fetchCourses();
    const opts = courses.map(c =>
      `<option value="${c.id}">${esc(c.name)} (${esc(c.code)})</option>`
    ).join('');
    ['ae-course', 'manage-filter', 'an-filter'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML =
        (id === 'manage-filter' || id === 'an-filter' ? '<option value="">כל הקורסים</option>' :
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
  return blocks.map(({ index, body, isBonus }) => {
    const { mainText, subs } = parseSubQuestions(body.trim());
    return {
      id:      genId(),
      index,
      text:    mainText.trim(),
      subs:    subs.map(s => ({ id: genId(), label: s.label, text: s.text })),
      isBonus: isBonus || BONUS_REGEX.test(mainText),
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

const BONUS_TITLE  = 'שאלת בונוס לקבוצות B ו-C';
const BONUS_REGEX  = /שאלת\s*בונוס(?:\s+לקבוצות\s+[A-Cא-ג]\s+ו[-–]\s*[A-Cא-ג])?/u;

function splitIntoQuestions(text) {
  // ── Pre-pass: extract bonus question block before normal splitting ──
  const bonusSplit = text.split(/(?=(?:^|\n)\s*שאלת\s*בונוס)/mu);
  let bonusBlock   = null;
  if (bonusSplit.length > 1) {
    bonusBlock = bonusSplit.pop().trim();   // everything from "שאלת בונוס" onwards
    text       = bonusSplit.join('').trim(); // rest without the bonus block
  }

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
    // Re-attach bonus block at end
    if (bonusBlock) {
      const bonusBody = bonusBlock.replace(/^שאלת\s*בונוס[^\n]*/mu, '').trim();
      result.push({ index: result.length + 1, body: bonusBody || bonusBlock, isBonus: true });
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
{"questions":[{"number":1,"text":"טקסט שאלה ראשית (ריק אם אין)","isBonus":false,"parts":[{"letter":"א","text":"טקסט סעיף"}]}]}

הוראות:
- שלוף את כל השאלות
- אם לשאלה יש סעיפים (א)(ב)(ג) — כלול ב-parts
- אם אין סעיפים — parts יהיה []
- נוסחאות מתמטיות: LaTeX עם $...$ או $$...$$
- שמור על הטקסט העברי המקורי
- אם השאלה מכילה "שאלת בונוס" בכותרתה — הגדר isBonus:true
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
  return (parsed.questions || []).map((q, i) => {
    const textLower = (q.text || '').toLowerCase();
    const bonus = q.isBonus === true || BONUS_REGEX.test(q.text || '');
    return {
      id:      genId(),
      index:   q.number || i + 1,
      text:    q.text || '',
      isBonus: bonus,
      subs:    (q.parts || []).map(p => ({
        id:    genId(),
        label: '(' + (p.letter || '') + ')',
        text:  p.text || ''
      }))
    };
  });
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
let _editingExamId  = null;  // tracks the exam being edited (for safe update, not delete-first)
let _examPdfFile    = null;  // File object selected for PDF download upload

function onExamPdfSelected(input) {
  const file = input.files[0];
  if (!file) return;
  _examPdfFile = file;
  const nameEl  = document.getElementById('ae-pdf-name');
  const clearEl = document.getElementById('ae-pdf-clear');
  if (nameEl)  nameEl.textContent = file.name;
  if (clearEl) clearEl.style.display = '';
}

function clearExamPdf() {
  _examPdfFile = null;
  const fileEl    = document.getElementById('ae-pdf-file');
  const nameEl    = document.getElementById('ae-pdf-name');
  const clearEl   = document.getElementById('ae-pdf-clear');
  const urlEl     = document.getElementById('ae-pdf-url');
  const currentEl = document.getElementById('ae-pdf-current');
  if (fileEl)    fileEl.value = '';
  if (nameEl)    nameEl.textContent = 'לא נבחר קובץ';
  if (clearEl)   clearEl.style.display = 'none';
  if (urlEl)     urlEl.value = '';
  if (currentEl) currentEl.style.display = 'none';
}

async function uploadExamPdf(examId) {
  if (!_examPdfFile) return null;

  // Use the shared storage instance from firebase-config.js
  const stor = typeof storage !== 'undefined' && storage
    ? storage
    : firebase.storage();

  if (!stor) throw new Error('Firebase Storage לא זמין — וודא שה-SDK נטען');

  const ref = stor.ref(`exam-pdfs/${examId}.pdf`);

  return await new Promise((resolve, reject) => {
    const uploadTask = ref.put(_examPdfFile);

    // Timeout — reject after 60 seconds
    const timeout = setTimeout(() => {
      uploadTask.cancel();
      reject(new Error('העלאה נכשלה: חרגה מ-60 שניות (בדוק חיבור אינטרנט והרשאות Storage)'));
    }, 60000);

    uploadTask.on('state_changed',
      (snapshot) => {
        const pct = Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100);
        showSpinner(`📤 מעלה PDF... ${pct}%`);
      },
      (error) => {
        clearTimeout(timeout);
        // Give a human-readable error based on Firebase error codes
        const messages = {
          'storage/unauthorized':     'אין הרשאה להעלות — בדוק Firebase Storage Rules',
          'storage/canceled':         'ההעלאה בוטלה',
          'storage/unknown':          'שגיאת רשת לא ידועה',
          'storage/quota-exceeded':   'חרגת ממכסת האחסון',
          'storage/unauthenticated':  'לא מחובר — יש להתחבר מחדש',
        };
        reject(new Error(messages[error.code] || `שגיאת Storage: ${error.code} — ${error.message}`));
      },
      async () => {
        clearTimeout(timeout);
        try {
          const url = await uploadTask.snapshot.ref.getDownloadURL();
          resolve(url);
        } catch (e) {
          reject(new Error('ההעלאה הצליחה אך לא ניתן לקבל URL: ' + e.message));
        }
      }
    );
  });
}

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
    <div class="pq-card${q.isBonus ? ' pq-bonus' : ''}" id="pqc-${i}">
      <div class="pq-header">
        <div class="pq-num">
          ${q.isBonus
            ? `<span class="bonus-badge">⭐ שאלת בונוס</span>`
            : `שאלה ${q.index || (i + 1)}`}
        </div>
        <div class="pq-actions" style="display:flex;align-items:center;gap:.5rem">
          <label class="bonus-chk-label" title="סמן כשאלת בונוס">
            <input type="checkbox" ${q.isBonus ? 'checked' : ''}
              onchange="toggleBonus(${i}, this.checked)"> בונוס
          </label>
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

function toggleBonus(i, checked) {
  parsedQuestions[i].isBonus = checked;
  // Re-render just this card header (lightweight)
  const card = document.getElementById('pqc-' + i);
  if (card) {
    card.classList.toggle('pq-bonus', checked);
    const numEl = card.querySelector('.pq-num');
    if (numEl) numEl.innerHTML = checked
      ? `<span class="bonus-badge">⭐ שאלת בונוס</span>`
      : `שאלה ${parsedQuestions[i].index || (i + 1)}`;
  }
}

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
  const lecturers = _lecturers.slice(); // snapshot of widget state
  // ── Auto-add any text still sitting in the lecturer input ──────
  const _lecInput = document.getElementById('ae-lecturer-input');
  if (_lecInput) {
    const pending = _lecInput.value.trim();
    if (pending && !lecturers.includes(pending)) {
      lecturers.push(pending);
      _lecInput.value = '';
      _lecturers.push(pending);
      _renderLecturersWidget();
    }
  }
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
    // ── Duplicate detection: exact title match only ─────────────
    try {
      const dupSnap = await db.collection('exams')
        .where('courseId', '==', courseId)
        .where('title', '==', title)
        .get();
      const conflicts = dupSnap.docs.filter(d => d.id !== (_editingExamId || ''));
      if (conflicts.length) {
        const ok = confirm(
          `שים לב: כבר קיים מבחן בשם "${title}" בקורס זה.\n` +
          `האם להמשיך ולשמור כמבחן נפרד?`
        );
        if (!ok) return;
      }
    } catch (dupErr) {
      // dup check failed — log and continue with save
      console.warn('Duplicate check skipped:', dupErr.message);
    }

    // ── Build exam object ───────────────────────────────────────────
    const examId = _editingExamId || genId();   // reuse ID when editing, new ID for new exam

    // ── Upload PDF to Storage if one was selected ────────────────
    let pdfUrl = document.getElementById('ae-pdf-url')?.value || null;
    if (_examPdfFile) {
      showSpinner('📤 מעלה PDF...');
      try {
        pdfUrl = await uploadExamPdf(examId);
        toast('✅ PDF הועלה בהצלחה', 'success');
      } catch (pdfErr) {
        console.error('PDF upload failed:', pdfErr);
        const goAhead = confirm(`העלאת ה-PDF נכשלה:\n${pdfErr.message}\n\nהאם לשמור את המבחן ללא PDF?`);
        if (!goAhead) {
          if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '💾 שמור מבחן'; }
          hideSpinner();
          return;
        }
        pdfUrl = null;
      }
    }

    const exam   = {
      id:        examId,
      courseId,
      title,
      year:      year ? parseInt(year) : null,
      semester:  sem  || null,
      moed:      moed || null,
      lecturers: lecturers.length ? lecturers : null,
      pdfUrl:    pdfUrl || null,
      questions: questions.map(q => ({
        id:      q.id || genId(),
        text:    q.text,
        isBonus: q.isBonus === true,
        subs:    (q.subs || []).map(s => ({
          id:    s.id || genId(),
          label: s.label,
          text:  s.text
        }))
      })),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      createdBy: adminUser?.email || 'admin',
    };
    // Always include createdAt so Firestore queries never exclude this doc
    if (!_editingExamId) {
      exam.createdAt = firebase.firestore.FieldValue.serverTimestamp();
    }
    // Always set createdAt for new exams; editing preserves it via the exam object
    await db.collection('exams').doc(examId).set(exam);
    // (write complete)

    const action = _editingExamId ? 'עודכן' : 'נשמר';
    toast(`מבחן ${action} — ${exam.questions.length} שאלות`, 'success');
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
  ['ae-title','ae-year'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  _clearLecturers();
  clearExamPdf();
  parsedQuestions = [];
  _editingExamId  = null;
  clearImport();
  document.getElementById('ae-error')?.classList.remove('show');
  // Hide edit banner
  const banner = document.getElementById('edit-mode-banner');
  if (banner) banner.style.display = 'none';
}

/* ══════════════════════════════════════════════════════════
   USER STATS
══════════════════════════════════════════════════════════ */

async function renderUserStats() {
  const wrap = document.getElementById('users-table-wrap');
  if (!wrap) return;
  wrap.innerHTML = `<div style="text-align:center;padding:2rem"><div class="spinner" style="margin:0 auto"></div><p style="color:var(--muted);margin-top:.8rem;font-size:.85rem">טוען נתוני משתמשים...</p></div>`;

  try {
    // Fetch all user docs
    const snap = await db.collection('users').get();
    if (snap.empty) {
      wrap.innerHTML = `<div style="text-align:center;padding:2rem;color:var(--light)">אין משתמשים במערכת</div>`;
      return;
    }

    const allDocs = snap.docs.map(d => ({ _docId: d.id, ...d.data() }));

    // ── Deduplicate by email — keep richest doc ───────────────
    const scoreDoc = d =>
      (d.starredQuestions || []).length +
      (d.completedExams || d.doneExams || []).length * 2 +
      (d.inProgressExams || []).length +
      (d.copyCount || 0) / 10 +
      (d.acceptedTerms ? 5 : 0) +
      (d.displayName   ? 3 : 0);

    const byEmail = new Map();
    const noEmail = [];

    for (const doc of allDocs) {
      const email = (doc.email || '').toLowerCase().trim();
      if (!email) {
        // Always keep docs that have ANY real user data, OR a known UID
        const hasData = (doc.starredQuestions || []).length > 0 ||
                        (doc.completedExams || doc.doneExams || []).length > 0 ||
                        (doc.inProgressExams || []).length > 0 ||
                        (doc.copyCount || 0) > 0 ||
                        doc.acceptedTerms === true ||
                        doc.displayName ||
                        doc.uid;
        if (hasData) noEmail.push(doc);
        continue;
      }
      if (!byEmail.has(email)) {
        byEmail.set(email, doc);
      } else {
        const existing = byEmail.get(email);
        if (scoreDoc(doc) > scoreDoc(existing)) byEmail.set(email, doc);
      }
    }

    const rows = [
      ...[...byEmail.values()].sort((a, b) => (a.email || '').localeCompare(b.email || '')),
      ...noEmail.sort((a, b) => (a.uid || a._docId || '').localeCompare(b.uid || b._docId || '')),
    ];

    const ghostCount = allDocs.length - rows.length;

    // ── Sort options ──────────────────────────────────────────
    // Default: email alphabetical (already sorted above)
    // Build table HTML
    const tableRows = rows.map((u, idx) => {
      const starred    = (u.starredQuestions || []).length;
      const done       = (u.completedExams || u.doneExams || []).length;
      const inProgress = (u.inProgressExams || []).length;
      const copies     = u.copyCount || 0;
      const accepted   = u.acceptedTerms === true;

      // Email cell — show email if available, else UID
      const identifier = u.email || u.uid || u._docId || '—';
      const isUid = !u.email;
      const emailCell = isUid
        ? `<span style="font-family:monospace;font-size:.72rem;color:var(--muted);
            background:#f1f5f9;padding:2px 5px;border-radius:4px;
            border:1px solid #e2e8f0" title="אין אימייל — מוצג UID">
            ${esc(identifier)}
           </span>`
        : `<span style="font-weight:500">${esc(identifier)}</span>`;

      // Activity bar — visual summary
      const totalActivity = copies + done * 3 + inProgress * 2 + starred;
      const activityColor = totalActivity > 20 ? '#16a34a' : totalActivity > 5 ? '#d97706' : '#94a3b8';

      return `<tr style="transition:background .15s" onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background=''">
        <td style="font-size:.82rem;min-width:200px">
          ${emailCell}
        </td>
        <td style="font-size:.85rem;color:var(--text)">${esc(u.displayName || '—')}</td>
        <td style="text-align:center">
          ${copies > 0
            ? `<span class="badge" style="background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;font-weight:600">${copies}</span>`
            : `<span style="color:var(--light);font-size:.8rem">0</span>`}
        </td>
        <td style="text-align:center">
          ${done > 0
            ? `<span class="badge b-done" style="font-weight:600">✓ ${done}</span>`
            : `<span style="color:var(--light);font-size:.8rem">0</span>`}
        </td>
        <td style="text-align:center">
          ${inProgress > 0
            ? `<span class="badge" style="background:#fefce8;color:#854d0e;border:1px solid #fde047;font-weight:600">⏳ ${inProgress}</span>`
            : `<span style="color:var(--light);font-size:.8rem">0</span>`}
        </td>
        <td style="text-align:center">
          ${starred > 0
            ? `<span class="badge b-orange" style="font-weight:600">⭐ ${starred}</span>`
            : `<span style="color:var(--light);font-size:.8rem">0</span>`}
        </td>
        <td style="text-align:center">
          ${accepted
            ? `<span class="badge" style="background:#dcfce7;color:#166534;border:1px solid #86efac">✓ אישר</span>`
            : `<span class="badge" style="background:#fef2f2;color:#991b1b;border:1px solid #fca5a5">✗ טרם</span>`}
        </td>
      </tr>`;
    }).join('');

    // ── Summary stats bar ─────────────────────────────────────
    const totalCopies     = rows.reduce((s, u) => s + (u.copyCount || 0), 0);
    const totalDone       = rows.reduce((s, u) => s + (u.completedExams || u.doneExams || []).length, 0);
    const totalInProgress = rows.reduce((s, u) => s + (u.inProgressExams || []).length, 0);
    const totalStarred    = rows.reduce((s, u) => s + (u.starredQuestions || []).length, 0);
    const totalAccepted   = rows.filter(u => u.acceptedTerms === true).length;

    wrap.innerHTML = `
      <!-- Summary stats -->
      <div style="display:flex;gap:.75rem;flex-wrap:wrap;margin-bottom:1.2rem">
        ${[
          ['📋', 'העתקות סה"כ',    totalCopies,     '#eff6ff','#1d4ed8','#bfdbfe'],
          ['✅', 'מבחנים שהושלמו', totalDone,        '#f0fdf4','#166534','#86efac'],
          ['⏳', 'בתהליך סה"כ',    totalInProgress,  '#fefce8','#854d0e','#fde047'],
          ['⭐', 'כוכביות סה"כ',   totalStarred,     '#fff7ed','#9a3412','#fdba74'],
          ['📜', 'אישרו תנאים',    `${totalAccepted}/${rows.length}`, '#f5f3ff','#5b21b6','#c4b5fd'],
        ].map(([icon, lbl, val, bg, fg, border]) => `
          <div style="flex:1;min-width:110px;background:${bg};border:1px solid ${border};
                      border-radius:10px;padding:.65rem .9rem;text-align:center">
            <div style="font-size:1.1rem;font-weight:700;color:${fg}">${icon} ${val}</div>
            <div style="font-size:.72rem;color:${fg};opacity:.8;margin-top:.15rem">${lbl}</div>
          </div>`).join('')}
      </div>

      <!-- Table -->
      <div style="overflow-x:auto">
        <table class="tbl" style="min-width:680px">
          <thead>
            <tr>
              <th>אימייל / UID</th>
              <th>שם</th>
              <th style="text-align:center" title="מספר פעמים שלחץ על העתק">📋 העתקות</th>
              <th style="text-align:center" title="מבחנים שסומנו כבוצע">✅ הושלמו</th>
              <th style="text-align:center" title="מבחנים שסומנו בתהליך">⏳ בתהליך</th>
              <th style="text-align:center" title="שאלות מסומנות בכוכבית">⭐ כוכביות</th>
              <th style="text-align:center">📜 הצהרה</th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>

        <p style="font-size:.75rem;color:var(--light);margin-top:.6rem;display:flex;justify-content:space-between;align-items:center">
          <span>
            ${rows.length} משתמשים ייחודיים
            ${ghostCount > 0 ? ` · ${ghostCount} docs כפולים/ישנים הוסתרו` : ''}
          </span>
          <span>עודכן ${new Date().toLocaleTimeString('he-IL')}
            &nbsp;·&nbsp;
            <button class="btn btn-sm btn-secondary" onclick="renderUserStats()" style="padding:.2rem .6rem;font-size:.75rem">🔄 רענן</button>
          </span>
        </p>
      </div>`;
  } catch (e) {
    wrap.innerHTML = `<div class="form-error show">שגיאה בטעינת משתמשים: ${esc(e.message)}</div>`;
    console.error('renderUserStats error:', e);
  }
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
    // Count unique users by email — same deduplication logic as renderUserStats
    const _uniqueEmails = new Set();
    let _noEmailCount = 0;
    usersSnap.docs.forEach(d => {
      const _e = (d.data().email || "").toLowerCase().trim();
      if (_e) _uniqueEmails.add(_e); else _noEmailCount++;
    });
    const totalUsers = _uniqueEmails.size + _noEmailCount;

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

    let q = db.collection('exams');
    if (filter) q = q.where('courseId', '==', filter);
    const snap = await q.get();

    if (snap.empty) {
      container.innerHTML = '<div class="empty"><span class="ei">📭</span><h3>אין מבחנים</h3></div>';
      return;
    }

    // Sort client-side: newest first, fallback to title for exams without createdAt
    const sortedDocs = snap.docs.slice().sort((a, b) => {
      const ta = a.data().createdAt?.toMillis?.() || a.data().updatedAt?.toMillis?.() || 0;
      const tb = b.data().createdAt?.toMillis?.() || b.data().updatedAt?.toMillis?.() || 0;
      return tb - ta;
    });

    const rows = sortedDocs.map(d => {
      const e = { ...d.data(), id: d.id };
      const qIds = (e.questions || []).map(q => q.id).filter(Boolean).join(',');
      return `<tr>
        <td><strong>${esc(e.title)}</strong></td>
        <td>${esc(courseMap[e.courseId] || e.courseId)}</td>
        <td>${e.year || '-'}</td>
        <td>${esc(e.semester) || '-'}</td>
        <td>${esc(e.moed) || '-'}</td>
        <td>${_fmtLecturers(e.lecturers || e.lecturer)}</td>
        <td><span class="badge b-gray">${(e.questions || []).length}</span></td>
        <td id="votes-${e.id}" class="votes-cell">
          <button class="btn btn-sm btn-secondary" onclick="loadExamVoteStats('${e.id}','${qIds}',this)">הצג</button>
        </td>
        <td>
          <button class="btn btn-sm btn-secondary" onclick="editExam('${e.courseId}','${e.id}')">✏️</button>
          <button class="btn btn-sm btn-danger" onclick="deleteExam('${e.id}')">🗑️</button>
        </td>
      </tr>`;
    }).join('');


    container.innerHTML = `<table class="tbl">
      <thead><tr><th>כותרת</th><th>קורס</th><th>שנה</th><th>סמסטר</th><th>מועד</th><th>מרצה</th><th>שאלות</th><th>קושי</th><th></th></tr></thead>
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

    _editingExamId = examId;

    showSection('add-exam');

    // ── Show edit-mode banner ───────────────────────────────────
    let banner = document.getElementById('edit-mode-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'edit-mode-banner';
      banner.style.cssText = [
        'background:#fffbeb','border:2px solid #f59e0b','border-radius:10px',
        'padding:.8rem 1.25rem','margin-bottom:1rem',
        'display:flex','align-items:center','justify-content:space-between','gap:.75rem',
        'font-size:.88rem','color:#92400e','flex-wrap:wrap'
      ].join(';');
      const titleSection = document.getElementById('sec-add-exam');
      if (titleSection) titleSection.insertBefore(banner, titleSection.firstChild.nextSibling);
    }
    banner.innerHTML = `
      <span>✏️ <strong>מצב עריכה</strong> — עורך את המבחן: <strong>${esc(exam.title || examId)}</strong></span>
      <button class="btn btn-secondary btn-sm" onclick="cancelEdit()">✕ בטל עריכה</button>`;
    banner.style.display = 'flex';

    // ── Scroll to top of form ───────────────────────────────────
    banner.scrollIntoView({ behavior: 'smooth', block: 'start' });

    // ── Fill form fields (with null guards) ────────────────────
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val ?? ''; };
    set('ae-course', courseId);
    set('ae-title',  exam.title    || '');
    set('ae-year',   exam.year     || '');
    set('ae-sem',    exam.semester || '');
    set('ae-moed',   exam.moed     || '');
    _setLecturers(exam.lecturers || exam.lecturer || []);

    // ── PDF ────────────────────────────────────────────────────
    const pdfUrlEl     = document.getElementById('ae-pdf-url');
    const pdfNameEl    = document.getElementById('ae-pdf-name');
    const pdfClearEl   = document.getElementById('ae-pdf-clear');
    const pdfCurrentEl = document.getElementById('ae-pdf-current');
    if (exam.pdfUrl) {
      if (pdfUrlEl)     pdfUrlEl.value = exam.pdfUrl;
      if (pdfNameEl)    pdfNameEl.textContent = 'PDF קיים (ניתן להחליף)';
      if (pdfClearEl)   pdfClearEl.style.display = '';
      if (pdfCurrentEl) {
        pdfCurrentEl.style.display = '';
        pdfCurrentEl.innerHTML = `קובץ נוכחי: <a href="${exam.pdfUrl}" target="_blank" rel="noopener" style="color:var(--blue)">פתח PDF ↗</a>`;
      }
    } else {
      clearExamPdf();
    }

    // ── Questions ──────────────────────────────────────────────
    parsedQuestions = (exam.questions || []).map(q => ({
      ...q,
      subs: (q.subs || q.parts || []).map(s => ({ ...s }))
    }));

    if (parsedQuestions.length) {
      renderPreview();
    } else {
      const pc = document.getElementById('preview-container');
      if (pc) pc.style.display = 'none';
    }

    toast(`✏️ "${exam.title}" נטען לעריכה`, 'info');
  } catch (e) {
    console.error('editExam error:', e);
    toast('שגיאה בטעינת המבחן: ' + e.message, 'error');
  } finally {
    hideSpinner();
  }
}

function cancelEdit() {
  _editingExamId = null;
  const banner = document.getElementById('edit-mode-banner');
  if (banner) banner.style.display = 'none';
  resetForm();
  toast('העריכה בוטלה', 'info');
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
      status: 'draft',  // Default to draft - admin must publish manually
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    document.getElementById('c-name').value = '';
    document.getElementById('c-code').value = '';
    toast('✅ קורס נוסף (בסטטוס טיוטה)', 'success');
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
    // Admin always sees all courses (direct query, no filter)
    const snap = await db.collection('courses').orderBy('name').get();
    const courses = snap.docs.map(d => ({ ...d.data(), id: d.id }));
    
    if (!courses.length) {
      el.innerHTML = '<div class="empty"><span class="ei">📭</span><h3>אין קורסים</h3></div>';
      return;
    }

    // Count exams per course
    const examSnap = await db.collection('exams').get();
    const examCount = {};
    examSnap.docs.forEach(d => {
      const cid = d.data().courseId;
      examCount[cid] = (examCount[cid] || 0) + 1;
    });

    const rows = courses.map(c => {
      const status = c.status || 'draft';
      return `<tr>
      <td style="font-size:1.3rem">${esc(c.icon)}</td>
      <td><strong>${esc(c.name)}</strong></td>
      <td><code>${esc(c.code)}</code></td>
      <td>${examCount[c.id] || 0}</td>
      <td>
        <div class="status-btn-group" data-course-id="${c.id}">
          <button class="status-btn ${status === 'published' ? 'active' : ''}" 
                  onclick="updateCourseStatus('${c.id}', 'published')" 
                  title="פורסם — גלוי לכולם">
            🟢 פורסם
          </button>
          <button class="status-btn ${status === 'admin' ? 'active' : ''}" 
                  onclick="updateCourseStatus('${c.id}', 'admin')" 
                  title="מנהלים — גלוי למנהלים בלבד">
            🔒 מנהלים
          </button>
          <button class="status-btn ${status === 'draft' ? 'active' : ''}" 
                  onclick="updateCourseStatus('${c.id}', 'draft')" 
                  title="טיוטה — מוסתר מכולם">
            📝 טיוטה
          </button>
        </div>
      </td>
      <td><button class="btn btn-danger btn-sm" onclick="deleteCourse('${c.id}')">🗑️</button></td>
    </tr>`;
    }).join('');

    el.innerHTML = `<table class="tbl">
      <thead><tr><th>אייקון</th><th>שם</th><th>קוד</th><th>מבחנים</th><th>סטטוס</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table>`;
  } catch (e) {
    el.innerHTML = `<p style="color:var(--danger)">שגיאה: ${e.message}</p>`;
  }
}

/**
 * Update course visibility status.
 */
async function updateCourseStatus(courseId, status) {
  const validStatuses = ['published', 'admin', 'draft'];
  if (!validStatuses.includes(status)) {
    toast('סטטוס לא חוקי', 'error');
    return;
  }

  // Optimistic UI update
  const btnGroup = document.querySelector(`.status-btn-group[data-course-id="${courseId}"]`);
  if (btnGroup) {
    btnGroup.querySelectorAll('.status-btn').forEach(btn => btn.classList.remove('active'));
    const btnIndex = status === 'published' ? 0 : status === 'admin' ? 1 : 2;
    btnGroup.querySelectorAll('.status-btn')[btnIndex]?.classList.add('active');
  }

  try {
    await db.collection('courses').doc(courseId).update({
      status,
      statusUpdatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      statusUpdatedBy: adminUser?.email || 'unknown',
    });

    const statusLabels = { published: '🟢 פורסם', admin: '🔒 מנהלים', draft: '📝 טיוטה' };
    toast(`סטטוס עודכן ל: ${statusLabels[status]}`, 'success');
  } catch (e) {
    console.error('updateCourseStatus error:', e);
    toast('שגיאה בעדכון סטטוס: ' + e.message, 'error');
    await renderCoursesList();
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

/* ══════════════════════════════════════════════════════════
   DIFFICULTY VOTE STATS  (admin)
══════════════════════════════════════════════════════════ */

const DIFF_LABELS = { easy: 'קל', medium: 'בינוני', hard: 'קשה', unsolved: 'לא פתרתי' };

async function loadExamVoteStats(examId, qIdsStr, btn) {
  const cell = document.getElementById('votes-' + examId);
  if (!cell) return;
  cell.innerHTML = '<span style="color:var(--muted);font-size:.8rem">טוען...</span>';

  try {
    const qIds = qIdsStr ? qIdsStr.split(',').filter(Boolean) : [];
    if (!qIds.length) { cell.innerHTML = '<span style="color:var(--muted);font-size:.8rem">אין שאלות</span>'; return; }

    // Batch fetch in chunks of 30
    const totals = { easy: 0, medium: 0, hard: 0, unsolved: 0 };
    for (let i = 0; i < qIds.length; i += 30) {
      const chunk = qIds.slice(i, i + 30);
      const snap  = await db.collection('questionVotes')
        .where(firebase.firestore.FieldPath.documentId(), 'in', chunk).get();
      snap.docs.forEach(d => {
        const data = d.data();
        Object.keys(totals).forEach(k => { totals[k] += (data[k] || 0); });
      });
    }

    const total = Object.values(totals).reduce((s, n) => s + n, 0);
    if (total === 0) {
      cell.innerHTML = '<span style="color:var(--light);font-size:.8rem">אין נתונים</span>';
      return;
    }

    cell.innerHTML = Object.entries(DIFF_LABELS).map(([key, label]) => {
      const n   = totals[key] || 0;
      const pct = total > 0 ? Math.round(n / total * 100) : 0;
      return n > 0
        ? `<span class="diff-stat-badge">${label}: <strong>${n}</strong> <span style="color:var(--light)">(${pct}%)</span></span>`
        : '';
    }).filter(Boolean).join('');

  } catch(e) {
    cell.innerHTML = `<span style="color:var(--danger);font-size:.8rem">${e.message}</span>`;
  }
}

/* ══════════════════════════════════════════════════════════
   ANALYTICS — difficulty overview
══════════════════════════════════════════════════════════ */

// Difficulty score weights (unsolved excluded from avg)
const DIFF_WEIGHTS = { easy: 1, medium: 2, hard: 3 };
const DIFF_HE      = { easy: 'קל', medium: 'בינוני', hard: 'קשה', unsolved: 'לא פתרתי' };

/**
 * Fetch votes for a list of question IDs (batched).
 * Returns { [qid]: { easy, medium, hard, unsolved } }
 */
async function _batchFetchVotes(qIds) {
  const result = {};
  for (let i = 0; i < qIds.length; i += 30) {
    const chunk = qIds.slice(i, i + 30);
    if (!chunk.length) continue;
    try {
      const snap = await db.collection('questionVotes')
        .where(firebase.firestore.FieldPath.documentId(), 'in', chunk).get();
      snap.docs.forEach(d => { result[d.id] = d.data(); });
    } catch(e) { console.warn('_batchFetchVotes error:', e); }
  }
  return result;
}

/**
 * Compute weighted difficulty average for a set of vote docs.
 * Returns { avg: number|null, total: number, breakdown: {easy,medium,hard,unsolved} }
 */
function _computeAvg(voteDocs) {
  const breakdown = { easy: 0, medium: 0, hard: 0, unsolved: 0 };
  let weightedSum = 0, scoredVotes = 0;
  for (const v of Object.values(voteDocs)) {
    for (const key of Object.keys(breakdown)) {
      breakdown[key] += (v[key] || 0);
    }
  }
  for (const [key, w] of Object.entries(DIFF_WEIGHTS)) {
    weightedSum  += breakdown[key] * w;
    scoredVotes  += breakdown[key];
  }
  const total = Object.values(breakdown).reduce((s, n) => s + n, 0);
  return {
    avg:       scoredVotes > 0 ? weightedSum / scoredVotes : null,
    total,
    breakdown,
  };
}

function _avgLabel(avg) {
  if (avg === null) return '<span style="color:var(--light);font-size:.8rem">אין נתונים</span>';
  const pct = (avg - 1) / 2; // 0‒1
  let color, label;
  if (avg < 1.5)      { color = '#16a34a'; label = 'קל'; }
  else if (avg < 2.3) { color = '#d97706'; label = 'בינוני'; }
  else                { color = '#dc2626'; label = 'קשה'; }
  return `<span style="font-weight:700;color:${color}">${label}</span>
    <span style="color:var(--muted);font-size:.78rem;margin-right:.3rem">(${avg.toFixed(1)})</span>`;
}

function _breakdownHtml(bd) {
  return ['easy','medium','hard','unsolved']
    .filter(k => bd[k] > 0)
    .map(k => `<span class="diff-stat-badge">${DIFF_HE[k]}: <strong>${bd[k]}</strong></span>`)
    .join('') || '<span style="color:var(--light);font-size:.8rem">—</span>';
}

/* ── Main analytics render ── */
async function renderAnalytics() {
  const tableEl = document.getElementById('analytics-table');
  if (!tableEl) return;
  tableEl.innerHTML = '<div class="spinner" style="margin:2rem auto"></div>';
  document.getElementById('exam-detail-panel').style.display = 'none';
  document.getElementById('hard-report').style.display = 'none';

  try {
    await populateAllSelects();
    const courses  = await fetchCourses();
    const courseMap = Object.fromEntries(courses.map(c => [c.id, c]));

    const filter = document.getElementById('an-filter')?.value || '';
    let q = db.collection('exams');
    if (filter) q = q.where('courseId', '==', filter);
    const snap = await q.get();

    if (snap.empty) {
      tableEl.innerHTML = '<div class="empty" style="padding:2rem"><span class="ei">📭</span><h3>אין מבחנים</h3></div>';
      return;
    }

    // Sort newest first
    const exams = snap.docs
      .map(d => ({ ...d.data(), id: d.id }))
      .sort((a, b) => (b.year || 0) - (a.year || 0) || (b.title || '').localeCompare(a.title || ''));

    // Collect all question IDs
    const allQIds = exams.flatMap(e => (e.questions || []).map(q => q.id).filter(Boolean));
    const allVotes = await _batchFetchVotes(allQIds);

    const rows = exams.map(e => {
      const qIds      = (e.questions || []).map(q => q.id).filter(Boolean);
      const examVotes = Object.fromEntries(qIds.filter(id => allVotes[id]).map(id => [id, allVotes[id]]));
      const { avg, total, breakdown } = _computeAvg(examVotes);
      const course    = courseMap[e.courseId];
      const lecturers = Array.isArray(e.lecturers) ? e.lecturers.join(', ') : (e.lecturer || '—');

      return `<tr>
        <td><strong>${esc(e.title || e.id)}</strong></td>
        <td>${esc(course?.name || e.courseId)}</td>
        <td>${e.year || '—'}</td>
        <td>${esc(e.semester || '—')}</td>
        <td>${esc(e.moed || '—')}</td>
        <td>${esc(lecturers)}</td>
        <td><span class="badge b-gray">${qIds.length}</span></td>
        <td>${_avgLabel(avg)}</td>
        <td>${_breakdownHtml(breakdown)}</td>
        <td>
          <button class="btn btn-sm btn-secondary"
            onclick="showExamDetail('${e.id}')">פירוט</button>
        </td>
      </tr>`;
    }).join('');

    tableEl.innerHTML = `<table class="tbl">
      <thead><tr>
        <th>מבחן</th><th>קורס</th><th>שנה</th><th>סמסטר</th><th>מועד</th>
        <th>מרצה</th><th>שאלות</th><th>מדד קושי</th><th>פירוט הצבעות</th><th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  } catch(e) {
    tableEl.innerHTML = `<p style="color:var(--danger);padding:1rem">${e.message}</p>`;
    console.error(e);
  }
}

/* ── Per-exam question detail ── */
async function showExamDetail(examId) {
  const panel   = document.getElementById('exam-detail-panel');
  const titleEl = document.getElementById('exam-detail-title');
  const bodyEl  = document.getElementById('exam-detail-body');
  panel.style.display = 'block';
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  bodyEl.innerHTML = '<div class="spinner" style="margin:1.5rem auto"></div>';

  try {
    const exam  = await fetchExam(examId);
    if (!exam)  { bodyEl.innerHTML = '<p>מבחן לא נמצא</p>'; return; }
    titleEl.textContent = `פירוט שאלות — ${exam.title || examId}`;

    const questions = exam.questions || [];
    if (!questions.length) { bodyEl.innerHTML = '<p style="color:var(--muted)">אין שאלות</p>'; return; }

    const qIds   = questions.map(q => q.id).filter(Boolean);
    const votes  = await _batchFetchVotes(qIds);

    const rows = questions.map((q, qi) => {
      const v  = votes[q.id] || {};
      const { avg, total, breakdown } = _computeAvg({ [q.id]: v });
      const previewText = (q.text || '').replace(/<[^>]+>/g, '').slice(0, 80) + ((q.text || '').length > 80 ? '...' : '');
      return `<tr>
        <td style="color:var(--muted);font-size:.8rem;white-space:nowrap">שאלה ${qi + 1}</td>
        <td style="font-size:.85rem;max-width:300px;overflow:hidden">${esc(previewText) || '<span style="color:var(--light)">ללא טקסט</span>'}</td>
        <td>${_avgLabel(avg)}</td>
        <td>${_breakdownHtml(breakdown)}</td>
        <td style="color:var(--muted);font-size:.8rem">${total > 0 ? total + ' הצבעות' : '—'}</td>
      </tr>`;
    }).join('');

    bodyEl.innerHTML = `<table class="tbl">
      <thead><tr><th>#</th><th>שאלה</th><th>מדד קושי</th><th>הצבעות</th><th>סה"כ</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  } catch(e) {
    bodyEl.innerHTML = `<p style="color:var(--danger)">${e.message}</p>`;
  }
}

/* ── Top 10 hardest questions report ── */
async function showHardQuestionsReport() {
  const panel  = document.getElementById('hard-report');
  const bodyEl = document.getElementById('hard-report-body');
  panel.style.display = 'block';
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  bodyEl.innerHTML = '<div class="spinner" style="margin:1.5rem auto"></div>';

  try {
    const [examsSnap, courses] = await Promise.all([
      db.collection('exams').get(),
      fetchCourses(),
    ]);
    const courseMap = Object.fromEntries(courses.map(c => [c.id, c.name]));

    // Build flat list of { qid, examTitle, courseName, qi, text }
    const allQuestions = [];
    examsSnap.docs.forEach(d => {
      const e = d.data();
      (e.questions || []).forEach((q, qi) => {
        if (q.id) allQuestions.push({
          qid:        q.id,
          text:       (q.text || '').slice(0, 100),
          qi,
          examTitle:  e.title || d.id,
          courseName: courseMap[e.courseId] || e.courseId,
        });
      });
    });

    if (!allQuestions.length) {
      bodyEl.innerHTML = '<p style="color:var(--muted)">אין שאלות במערכת</p>'; return;
    }

    const qIds  = allQuestions.map(q => q.qid);
    const votes = await _batchFetchVotes(qIds);

    // Score each question: hard votes / total scored votes
    const scored = allQuestions
      .map(q => {
        const v    = votes[q.qid] || {};
        const hard = v.hard || 0;
        const scored = (v.easy || 0) + (v.medium || 0) + hard;
        return { ...q, hardVotes: hard, scored, ratio: scored > 0 ? hard / scored : 0 };
      })
      .filter(q => q.hardVotes > 0)
      .sort((a, b) => b.ratio - a.ratio || b.hardVotes - a.hardVotes)
      .slice(0, 10);

    if (!scored.length) {
      bodyEl.innerHTML = '<p style="color:var(--muted)">אין עדיין דירוגי "קשה" במערכת</p>'; return;
    }

    const rows = scored.map((q, i) => `<tr>
      <td style="color:var(--muted);font-weight:700">${i + 1}</td>
      <td style="font-size:.85rem;max-width:280px">${esc(q.text || '—')}${q.text?.length >= 100 ? '…' : ''}</td>
      <td>${esc(q.examTitle)}</td>
      <td>${esc(q.courseName)}</td>
      <td style="color:#dc2626;font-weight:700">${q.hardVotes}</td>
      <td style="color:var(--muted);font-size:.8rem">${q.scored} הצבעות (${Math.round(q.ratio * 100)}% קשה)</td>
    </tr>`).join('');

    bodyEl.innerHTML = `<table class="tbl">
      <thead><tr><th>#</th><th>שאלה</th><th>מבחן</th><th>קורס</th><th>הצבעות "קשה"</th><th>יחס</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  } catch(e) {
    bodyEl.innerHTML = `<p style="color:var(--danger)">${e.message}</p>`;
    console.error(e);
  }
}


/* ══════════════════════════════════════════════════════════
   SURVEY MANAGER  (admin)
══════════════════════════════════════════════════════════ */

async function renderSurveyManager() {
  const statusEl = document.getElementById('survey-status-body');
  const respEl   = document.getElementById('survey-responses-body');
  if (statusEl) statusEl.innerHTML = '<div class="spinner" style="margin:0 auto"></div>';
  if (respEl)   respEl.innerHTML   = '<div class="spinner" style="margin:0 auto"></div>';

  // ── Part 1: settings/global (independent try/catch) ──────────
  try {
    const doc      = await db.collection('settings').doc('global').get();
    const settings = doc.exists ? doc.data() : {};
    const isActive = settings.isSurveyActive === true;
    const url      = settings.surveyUrl || '';

    const urlInput = document.getElementById('survey-url-input');
    if (urlInput && url) urlInput.value = url;

    if (statusEl) {
      statusEl.innerHTML = `
        <div style="display:flex;align-items:center;gap:1rem;flex-wrap:wrap">
          <div style="
            display:inline-flex;align-items:center;gap:.5rem;
            padding:.5rem 1rem;border-radius:99px;font-weight:600;font-size:.9rem;
            ${isActive
              ? 'background:#dcfce7;color:#166534;border:1.5px solid #86efac'
              : 'background:#f1f5f9;color:#64748b;border:1.5px solid #cbd5e1'}">
            <span style="font-size:1rem">${isActive ? '🟢' : '⚫'}</span>
            ${isActive ? 'סקר פעיל' : 'סקר כבוי'}
          </div>
          ${url
            ? `<a href="${esc(url)}" target="_blank" rel="noopener"
                style="font-size:.8rem;color:var(--blue);text-decoration:underline;word-break:break-all">
                ${esc(url.length > 60 ? url.slice(0,60)+'…' : url)}
               </a>`
            : '<span style="color:var(--muted);font-size:.85rem">אין לינק מוגדר</span>'}
        </div>`;
    }
  } catch(e) {
    console.error('renderSurveyManager — settings error:', e);
    if (statusEl) {
      const isPerms = e.code === 'permission-denied';
      statusEl.innerHTML = isPerms
        ? `<div class="form-error show" style="margin:0">
            <strong>שגיאת הרשאות Firestore</strong><br>
            יש להוסיף חוקים ל-<code>settings</code> ב-Firebase Console —
            ראה הוראות למטה.
           </div>`
        : `<p style="color:var(--danger);margin:0">${esc(e.message)}</p>`;
    }
  }

  // ── Part 2: user responses (independent try/catch) ────────────
  try {
    const usersSnap = await db.collection('users').get();
    const allDocs   = usersSnap.docs.map(d => ({ _docId: d.id, ...d.data() }));

    // Deduplicate by email — same logic as renderUserStats.
    // If a user deleted their account and re-registered they get a new UID
    // and a new Firestore doc. Keep only the doc with the most data.
    const scoreDoc = d =>
      (d.acceptedTerms ? 5 : 0) +
      (d.displayName   ? 3 : 0) +
      (d.surveyDone    ? 2 : 0) +
      (d.copyCount || 0) / 10;

    const byEmail = new Map();
    const noEmail = [];
    for (const doc of allDocs) {
      const email = (doc.email || '').toLowerCase().trim();
      if (!email) {
        // Only keep docs that have at least a uid (real user, not a ghost)
        if (doc.uid || doc.displayName || doc.acceptedTerms) noEmail.push(doc);
        continue;
      }
      if (!byEmail.has(email)) {
        byEmail.set(email, doc);
      } else {
        if (scoreDoc(doc) > scoreDoc(byEmail.get(email))) byEmail.set(email, doc);
      }
    }
    const allUsers = [
      ...[...byEmail.values()].sort((a,b) => (a.email||'').localeCompare(b.email||'')),
      ...noEmail,
    ];

    const done    = allUsers.filter(u => u.surveyDone === true);
    const notDone = allUsers.filter(u => u.surveyDone !== true);

    const row = (u, filled) => `<tr${filled ? '' : ' style="opacity:.65"'}>
      <td style="font-size:.82rem">${esc(u.email || u.uid || '—')}</td>
      <td>${esc(u.displayName || '—')}</td>
      <td style="text-align:center">
        ${filled
          ? '<span class="badge" style="background:#dcfce7;color:#166534;border:1px solid #86efac">✓ מילא</span>'
          : '<span class="badge" style="background:#fef2f2;color:#991b1b;border:1px solid #fca5a5">✗ טרם</span>'}
      </td>
    </tr>`;

    if (respEl) {
      respEl.innerHTML = `
        <p style="font-size:.85rem;color:var(--muted);margin:0 0 .8rem">
          ${done.length} מתוך ${allUsers.length} משתמשים מילאו את הסקר
        </p>
        <table class="tbl">
          <thead><tr><th>אימייל</th><th>שם</th><th style="text-align:center">סטטוס</th></tr></thead>
          <tbody>
            ${done.map(u => row(u, true)).join('')}
            ${notDone.map(u => row(u, false)).join('')}
          </tbody>
        </table>`;
    }
  } catch(e) {
    console.error('renderSurveyManager — users error:', e);
    if (respEl) respEl.innerHTML = `<p style="color:var(--danger);margin:0">${esc(e.message)}</p>`;
  }
}

async function activateSurvey() {
  const url = document.getElementById('survey-url-input')?.value.trim();
  if (!url) {
    toast('נא להזין קישור ל-Google Form לפני ההפעלה', 'error');
    document.getElementById('survey-url-input')?.focus();
    return;
  }
  if (!url.startsWith('http')) {
    toast('קישור לא תקין — חייב להתחיל ב-https://', 'error');
    return;
  }
  try {
    await db.collection('settings').doc('global').set(
      { surveyUrl: url, isSurveyActive: true },
      { merge: true }
    );
    toast('✅ הסקר הופעל לכל המשתמשים', 'success');
    renderSurveyManager();
  } catch(e) {
    toast('שגיאה: ' + e.message, 'error');
  }
}

async function deactivateSurvey() {
  try {
    await db.collection('settings').doc('global').set(
      { isSurveyActive: false },
      { merge: true }
    );
    toast('⛔ הסקר כובה', 'info');
    renderSurveyManager();
  } catch(e) {
    toast('שגיאה: ' + e.message, 'error');
  }
}

async function resetSurveyResponses() {
  if (!confirm('איפוס יגרום לכל הסטודנטים לראות את הסקר שוב. להמשיך?')) return;
  try {
    const snap  = await db.collection('users').get();
    const batch = db.batch();
    snap.docs.forEach(d => {
      batch.update(d.ref, { surveyDone: firebase.firestore.FieldValue.delete() });
    });
    await batch.commit();
    toast('🔄 תשובות אופסו — הסקר יוצג לכולם מחדש', 'info');
    renderSurveyManager();
  } catch(e) {
    toast('שגיאה באיפוס: ' + e.message, 'error');
  }
}


/* ══════════════════════════════════════════════════════════
   PERMISSIONS MANAGER  (admin)
   Manages the `authorized_users` Firestore collection.
   Each document ID = normalized email, with field active:true.
══════════════════════════════════════════════════════════ */

async function renderPermissionsSection() {
  const listEl  = document.getElementById('permissions-list-wrap');
  const countEl = document.getElementById('permissions-count');
  if (listEl) listEl.innerHTML = '<div class="spinner" style="margin:1.5rem auto"></div>';

  if (!adminUser || adminUser.role !== 'admin') {
    if (listEl) listEl.innerHTML = '<p style="color:var(--danger)">גישה נדחתה — מנהלים בלבד</p>';
    return;
  }
    const emails = snap.docs
      .filter(d => d.data().active !== false)
      .map(d => d.id)
      .sort((a, b) => a.localeCompare(b));

    if (countEl) countEl.textContent = emails.length + ' מיילים מורשים';

    if (!listEl) return;

    if (!emails.length) {
      listEl.innerHTML = `
        <div class="empty" style="padding:2rem">
          <span class="ei">📭</span>
          <h3>אין מיילים מורשים עדיין</h3>
          <p>הוסף מיילים בעזרת הטופס למעלה</p>
        </div>`;
      return;
    }

    const rows = emails.map(email => `
      <tr>
        <td style="font-size:.85rem;font-family:monospace;direction:ltr;text-align:left">${esc(email)}</td>
        <td style="text-align:center">
          <span class="badge" style="background:#dcfce7;color:#166534;border:1px solid #86efac">✓ פעיל</span>
        </td>
        <td>
          <button class="btn btn-danger btn-sm"
            onclick="deleteAuthorizedEmail('${esc(email)}')">מחק</button>
        </td>
      </tr>`).join('');

    listEl.innerHTML = `
      <table class="tbl">
        <thead>
          <tr>
            <th style="direction:ltr;text-align:left">אימייל</th>
            <th style="text-align:center">סטטוס</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;

  } catch (e) {
    console.error('renderPermissionsSection error:', e);
    if (listEl) listEl.innerHTML = `<p style="color:var(--danger);padding:1rem">${esc(e.message)}</p>`;
  }
}

/* ══════════════════════════════════════════════════════════
   PERMISSIONS MANAGER  —  UPDATED addAuthorizedEmails
   קטע זה מחליף את הפונקציה הקיימת ב-admin.js (שורות 2070–2120)
   ══════════════════════════════════════════════════════════ */

/**
 * שולח מייל ברכה דרך Netlify Function.
 * נקרא בצורה fire-and-forget (לא חוסם את ה-UI).
 *
 * @param {string} email  — כתובת המייל של הסטודנט
 * @param {string} [name] — שם מלא (אופציונלי)
 */
async function sendWelcomeEmail(email, name = '') {
  try {
    const res = await fetch('/.netlify/functions/send-welcome-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, name }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      console.warn(`sendWelcomeEmail failed for ${email}:`, data.error || res.status);
    } else {
      console.log(`✉️ Welcome email queued → ${email}`);
    }
  } catch (err) {
    // שגיאת רשת — לא עוצרים את כל תהליך ההוספה בגללה
    console.warn('sendWelcomeEmail network error:', err.message);
  }
}

/* ── מחליף את addAuthorizedEmails הקיימת ── */
async function addAuthorizedEmails() {
  if (!adminUser || adminUser.role !== 'admin') {
    toast('גישה נדחתה — מנהלים בלבד', 'error');
    return;
  }

  const textarea = document.getElementById('permissions-textarea');
  if (!textarea) return;

  const raw = textarea.value;
  const candidates = raw
    .split(/[\n\r,;]+/)
    .map(s => s.trim().toLowerCase())
    .filter(s => s.includes('@') && s.length > 4);

  const unique = [...new Set(candidates)];

  if (!unique.length) {
    toast('לא נמצאו כתובות מייל תקינות', 'error');
    return;
  }

  const btn = document.getElementById('add-emails-btn');
  if (btn) { btn.disabled = true; btn.textContent = '💾 שומר...'; }

  try {
    /* ── 1. טען את הרשימה הקיימת בקריאה אחת (collection-level read) ── */
    const existingSnap = await db.collection('authorized_users').get();
    const alreadyActive = new Set(
      existingSnap.docs
        .filter(d => d.data().active === true)
        .map(d => d.id)   // document ID = normalized email
    );

    // מיילים שלא היו פעילים עד כה — אלה יקבלו מייל ברכה
    const newEmails = unique.filter(e => !alreadyActive.has(e));

    /* ── 2. כתוב ל-Firestore בצ'אנקים ── */
    const CHUNK = 400;
    for (let i = 0; i < unique.length; i += CHUNK) {
      const batch = db.batch();
      unique.slice(i, i + CHUNK).forEach(email => {
        const ref = db.collection('authorized_users').doc(email);
        batch.set(ref, {
          active: true,
          addedBy: adminUser.email,
          addedAt: firebase.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      });
      await batch.commit();
    }

    toast(`✅ ${unique.length} מיילים נוספו בהצלחה`, 'success');
    textarea.value = '';

    /* ── 3. שלח מיילי ברכה רק למיילים החדשים — fire-and-forget ── */
    if (newEmails.length > 0) {
      toast(`✉️ שולח ${newEmails.length} מיילי ברכה...`, 'info');

      // שולחים במקביל, עם throttle קל (כדי לא לדפוק SendGrid בבת אחת)
      const MAIL_BATCH = 5; // עד 5 מיילים במקביל
      for (let i = 0; i < newEmails.length; i += MAIL_BATCH) {
        const chunk = newEmails.slice(i, i + MAIL_BATCH);
        await Promise.all(chunk.map(email => sendWelcomeEmail(email)));
      }

      console.log(`📧 Welcome emails sent to ${newEmails.length} new users`);
    }

    await renderPermissionsSection();

  } catch (e) {
    console.error('addAuthorizedEmails error:', e);
    toast('שגיאה בשמירה: ' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔓 הוסף מיילים למערכת'; }
  }
}


async function deleteAuthorizedEmail(email) {
  if (!adminUser || adminUser.role !== 'admin') {
    toast('גישה נדחתה — מנהלים בלבד', 'error');
    return;
  }

  if (!confirm(`האם למחוק את הרשאת הגישה של:\n${email}?`)) return;

  try {
    await db.collection('authorized_users').doc(email).set(
      { active: false, revokedBy: adminUser.email,
        revokedAt: firebase.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
    toast(`🗑️ ${email} הוסר מרשימת ההרשאות`, 'info');
    await renderPermissionsSection();
  } catch (e) {
    console.error('deleteAuthorizedEmail error:', e);
    toast('שגיאה במחיקה: ' + e.message, 'error');
  }
}


/* ══════════════════════════════════════════════════════════
   ACCESS REQUESTS PANEL
   Collection: access_requests
   Each doc: { name, email, lecturer, timestamp, status }
══════════════════════════════════════════════════════════ */

/**
 * טוען ומציג את כל בקשות הגישה הממתינות.
 * נקרא ע"י showSection('requests') ועל ידי כפתור הרענון.
 */
async function renderRequestsSection() {
  const listEl  = document.getElementById('requests-list-wrap');
  const countEl = document.getElementById('requests-count');
  const badge   = document.getElementById('requests-badge');

  if (listEl) listEl.innerHTML = '<div class="spinner" style="margin:1.5rem auto"></div>';

  if (!adminUser || adminUser.role !== 'admin') {
    if (listEl) listEl.innerHTML = '<p style="color:var(--danger)">גישה נדחתה — מנהלים בלבד</p>';
    return;
  }

  try {
    const snap = await db.collection('access_requests')
      .where('status', '==', 'pending')
      .get();

    // Sort client-side to avoid requiring a Firestore composite index
    const requests = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.timestamp?.toMillis?.() || 0) - (a.timestamp?.toMillis?.() || 0));

    // Update badge in sidebar
    if (badge) {
      if (requests.length > 0) {
        badge.textContent    = requests.length;
        badge.style.display  = 'inline-block';
      } else {
        badge.style.display  = 'none';
      }
    }
    if (countEl) countEl.textContent = requests.length + ' בקשות ממתינות';
    if (!listEl) return;

    if (!requests.length) {
      listEl.innerHTML = `
        <div class="empty" style="padding:2rem;text-align:center">
          <span style="font-size:2rem;display:block;margin-bottom:.5rem">📭</span>
          <h3 style="font-weight:600;margin-bottom:.3rem">אין בקשות ממתינות</h3>
          <p style="color:var(--muted);font-size:.88rem">כל הבקשות אושרו או שאין בקשות חדשות</p>
        </div>`;
      return;
    }

    const rows = requests.map(req => {
      const ts = req.timestamp?.toDate?.();
      const dateStr = ts
        ? ts.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit' })
        : '—';
      return `
        <tr id="req-row-${esc(req.id)}">
          <td style="font-weight:600">${esc(req.name || '—')}</td>
          <td style="font-size:.84rem;font-family:monospace;direction:ltr;text-align:left">${esc(req.email)}</td>
          <td>${esc(req.lecturer || '—')}</td>
          <td style="font-size:.8rem;color:var(--muted);white-space:nowrap">${dateStr}</td>
          <td>
            <span class="badge" style="background:#fff7ed;color:#9a3412;border:1px solid #fdba74">ממתין</span>
          </td>
          <td>
            <button class="btn btn-success btn-sm" onclick="approveAccessRequest('${esc(req.id)}','${esc(req.email)}','${esc(req.name || '')}')">
              ✅ אשר גישה
            </button>
          </td>
        </tr>`;
    }).join('');

    listEl.innerHTML = `
      <table class="tbl">
        <thead>
          <tr>
            <th>שם</th>
            <th style="direction:ltr;text-align:left">אימייל</th>
            <th>מרצה</th>
            <th>תאריך</th>
            <th>סטטוס</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;

  } catch (e) {
    console.error('renderRequestsSection error:', e);
    if (listEl) listEl.innerHTML = `<p style="color:var(--danger);padding:1rem">${esc(e.message)}</p>`;
  }
}

/**
 * מאשר בקשת גישה:
 *  1. מוסיף את המייל ל-authorized_users (active:true)
 *  2. מעדכן את הבקשה המקורית ל-status:'approved'
 *  3. שולח מייל ברכה
 */
async function approveAccessRequest(requestId, email, name) {
  if (!adminUser || adminUser.role !== 'admin') {
    toast('גישה נדחתה — מנהלים בלבד', 'error');
    return;
  }

  const btn = document.querySelector(`#req-row-${CSS.escape(requestId)} .btn-success`);
  if (btn) { btn.disabled = true; btn.textContent = 'מאשר...'; }

  try {
    const normalizedEmail = email.toLowerCase().trim();

    // 1. הוסף ל-authorized_users
    await db.collection('authorized_users').doc(normalizedEmail).set({
      active:     true,
      email:      normalizedEmail,
      name:       name || '',
      addedBy:    adminUser.email,
      addedAt:    firebase.firestore.FieldValue.serverTimestamp(),
      source:     'access_request',
    }, { merge: true });

    // 2. עדכן סטטוס הבקשה
    await db.collection('access_requests').doc(requestId).set({
      status:     'approved',
      approvedBy: adminUser.email,
      approvedAt: firebase.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    // 3. שלח מייל ברכה (fire-and-forget)
    sendWelcomeEmail(normalizedEmail, name);

    toast(`✅ ${normalizedEmail} אושר בהצלחה — נשלח מייל ברכה`, 'success');

    // הסר את השורה מה-UI ללא רענון מלא
    const row = document.getElementById(`req-row-${requestId}`);
    if (row) {
      row.style.transition = 'opacity .3s';
      row.style.opacity    = '0';
      setTimeout(() => {
        row.remove();
        // עדכן את מונה הבקשות
        const tbody  = document.querySelector('#requests-list-wrap tbody');
        const countEl = document.getElementById('requests-count');
        const badge   = document.getElementById('requests-badge');
        const remaining = tbody ? tbody.querySelectorAll('tr').length : 0;
        if (countEl) countEl.textContent = remaining + ' בקשות ממתינות';
        if (badge) {
          if (remaining > 0) { badge.textContent = remaining; }
          else               { badge.style.display = 'none'; }
        }
        if (!remaining && tbody) {
          document.getElementById('requests-list-wrap').innerHTML = `
            <div class="empty" style="padding:2rem;text-align:center">
              <span style="font-size:2rem;display:block;margin-bottom:.5rem">📭</span>
              <h3 style="font-weight:600;margin-bottom:.3rem">אין בקשות ממתינות</h3>
              <p style="color:var(--muted);font-size:.88rem">כל הבקשות אושרו</p>
            </div>`;
        }
      }, 350);
    }

  } catch (err) {
    console.error('approveAccessRequest error:', err);
    toast('שגיאה באישור הבקשה: ' + err.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = '✅ אשר גישה'; }
  }
}

/**
 * טוען בשקט את מספר הבקשות הממתינות ומעדכן את הבדאג' בסיידבר.
 * נקרא בעת אתחול האדמין.
 */
async function _loadRequestsBadge() {
  try {
    const snap = await db.collection('access_requests')
      .where('status', '==', 'pending')
      .get();
    const badge = document.getElementById('requests-badge');
    if (!badge) return;
    if (snap.size > 0) {
      badge.textContent   = snap.size;
      badge.style.display = 'inline-block';
    } else {
      badge.style.display = 'none';
    }
  } catch (e) {
    // non-critical — ignore silently
    console.warn('_loadRequestsBadge:', e.message);
  }
}
