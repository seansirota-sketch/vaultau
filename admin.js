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

/* ══════════════════════════════════════════════════════════════
   DIRECT CLAUDE API — calls Anthropic directly from browser.
   No Netlify function, no timeout. Tries Opus → Sonnet → Haiku.
   ═══════════════════════════════════════════════════════════ */
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODELS  = [
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
];
const CLAUDE_MAX_TOK = 8192;
let _anthropicKey    = null;

async function loadAnthropicKey() {
  try {
    const doc = await db.collection('settings').doc('api_keys').get();
    if (doc.exists && doc.data().anthropic) {
      _anthropicKey = doc.data().anthropic;
      console.log('✅ Anthropic API key loaded');
    } else {
      console.warn('⚠️ Anthropic key missing — set settings/api_keys.anthropic in Firestore');
    }
  } catch (e) { console.warn('Could not load Anthropic key:', e.message); }
}

/**
 * Call Claude API directly from browser. Tries models in order until one succeeds.
 * @param {Array} messages — Claude messages array
 * @param {Function} [onAttempt] — optional callback(modelName, attemptIndex)
 * @returns {Promise<{questions, metadata, usage}>}
 */
async function callClaudeDirect(messages, onAttempt) {
  if (!_anthropicKey) throw new Error('מפתח Anthropic לא נטען — הגדר settings/api_keys.anthropic ב-Firestore');

  let lastErr = null;

  for (let i = 0; i < CLAUDE_MODELS.length; i++) {
    const model = CLAUDE_MODELS[i];
    if (onAttempt) onAttempt(model, i);

    try {
      const response = await fetch(CLAUDE_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         _anthropicKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({ model, max_tokens: CLAUDE_MAX_TOK, messages }),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        let errMsg = `${model}: HTTP ${response.status}`;
        try { const d = JSON.parse(errText); errMsg = d.error?.message || errMsg; } catch {}

        // 529 = overloaded, 529/500/503 = retry with next model
        if (response.status === 529 || response.status >= 500) {
          console.warn(`⚠️ ${errMsg} — trying next model...`);
          lastErr = new Error(errMsg);
          continue;
        }
        throw new Error(errMsg);
      }

      const data = await response.json();
      let jsonStr = (data.content?.find(c => c.type === 'text')?.text || '').trim();

      // Strip markdown fences
      const fence = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fence) jsonStr = fence[1].trim();

      let parsed;
      try { parsed = JSON.parse(jsonStr); } catch {
        const m = jsonStr.match(/\{[\s\S]*\}/);
        if (m) try { parsed = JSON.parse(m[0]); } catch {}
      }

      if (!parsed || !Array.isArray(parsed.questions)) {
        console.warn(`⚠️ ${model}: invalid JSON — trying next model...`);
        lastErr = new Error(`${model}: תשובה לא תקנית`);
        continue;
      }

      console.log(`✅ ${model}: ${parsed.questions.length} questions parsed`);
      return { questions: parsed.questions, metadata: parsed.metadata || null, usage: data.usage, model };

    } catch (err) {
      console.warn(`⚠️ ${model}: ${err.message}`);
      lastErr = err;
      // Network error / timeout → try next model
      continue;
    }
  }

  throw lastErr || new Error('כל המודלים נכשלו');
}

/* ── Prompt builder for vision/PDF ────────────────────────── */
function _parseFilenameHint(filename) {
  if (!filename) return {};
  const f = filename.replace(/\.[^/.]+$/, '');
  const result = {};
  const ym = f.match(/20\d{2}/); if (ym) result.year = parseInt(ym[0]);
  const sc = f.match(/20\d{2}([A-Za-z])([A-Za-z])/);
  if (sc) {
    const sm = { A:'א',B:'ב',S:'קיץ',C:'קיץ' }, mm = { A:'א',B:'ב',C:'ג' };
    if (sm[sc[1].toUpperCase()]) result.semester = sm[sc[1].toUpperCase()];
    if (mm[sc[2].toUpperCase()]) result.moed = mm[sc[2].toUpperCase()];
  }
  return result;
}

function _buildDirectPrompt(filenameHint) {
  const k = _parseFilenameHint(filenameHint);
  const kl = [];
  if (k.year) kl.push(`year: ${k.year}`);
  if (k.semester) kl.push(`semester: "${k.semester}"`);
  if (k.moed) kl.push(`moed: "${k.moed}"`);
  const kb = kl.length ? `\n⚠️ פרטים משם הקובץ: ${kl.join(', ')}\n` : '';
  const ye = k.year||2024, se = k.semester||'א', me = k.moed||'ב';

  return `אתה מומחה לחילוץ מידע ממבחנים אקדמיים בעברית.${kb}

════ מטאדאטה ════
▸ courseName — שם הקורס המלא מכותרת המבחן.
▸ lecturers — מצא "מרצים:"/"מרצה:" → פצל לפי פסיקים → הסר תארים → שם פרטי + משפחה בלבד.
▸ year — ${k.year ? k.year+' (אל תשנה)' : '4 ספרות'}
▸ semester — ${k.semester ? '"'+k.semester+'" (אל תשנה)' : '"א"/"ב"/"קיץ"/null'}
▸ moed — ${k.moed ? '"'+k.moed+'" (אל תשנה)' : '"א"/"ב"/"ג"/null'}

════ שאלות ════
⚠️ אל תוסיף ניקוד. אל תכלול "(X נק')".
• LaTeX: $...$ inline, $$...$$ display, \\begin{pmatrix}, \\frac, \\sqrt
• סעיפים (א)(ב)(ג) / (1)(2)(3) → parts[].letter
• שאלת בונוס → isBonus: true
• אל תכלול הוראות בחינה, לוגו, מספרי עמוד

════ JSON בלבד — ללא markdown, ללא \`\`\` ════
{"metadata":{"courseName":"...","lecturers":["..."],"year":${ye},"semester":"${se}","moed":"${me}"},"questions":[{"number":1,"text":"...","isBonus":false,"parts":[{"letter":"א","text":"..."}]}]}`;
}

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
    await loadAnthropicKey();
    await populateAllSelects();
    await refreshDashboard();
    await renderManageTable();
    // טעינת בדאג'ים ברקע
    _loadRequestsBadge();
    _loadReportsBadge();
    await renderCoursesList();
    setupUploadZone();
    setupBulkZone();
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
  if (name === 'reports')     renderReportsSection();
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
    ['ae-course', 'manage-filter', 'an-filter', 'bulk-course'].forEach(id => {
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
   LECTURER NORMALIZATION
   Compares detected names against all existing lecturer
   names in Firestore to reduce OCR errors.
══════════════════════════════════════════════════════════ */

let _knownLecturers = null; // cached flat list of all lecturer names in the system

async function loadKnownLecturers() {
  if (_knownLecturers) return _knownLecturers;
  try {
    const snap = await db.collection('exams').get();
    const names = new Set();
    snap.docs.forEach(d => {
      const lecs = d.data().lecturers;
      if (Array.isArray(lecs)) lecs.forEach(n => { if (n) names.add(n.trim()); });
    });
    _knownLecturers = [...names];
  } catch (e) {
    _knownLecturers = [];
  }
  return _knownLecturers;
}

/**
 * Read the manual lecturer list from the bulk textarea.
 * Returns a cleaned array of names (one per line, no titles).
 */
function getBulkKnownLecturers() {
  const ta = document.getElementById('bulk-known-lecturers');
  if (!ta || !ta.value.trim()) return [];
  return ta.value
    .split('\n')
    .map(line => line
      .trim()
      .replace(/^(ד"ר|פרופ'|פרופסור|Prof\.|Dr\.|Assoc\.)\s*/i, '')
      .trim()
    )
    .filter(Boolean);
}

/**
 * For each detected lecturer name, check if it is similar enough
 * to a known name in the system and replace it if so.
 * manualList (optional) takes priority over Firestore names.
 */
async function normalizeLecturerNames(detectedNames, manualList) {
  if (!detectedNames || !detectedNames.length) return detectedNames;

  const hasManual = manualList && manualList.length > 0;

  if (hasManual) {
    // Manual list: only keep names that match something in the list.
    // Use word-level matching so partial OCR names still match.
    return detectedNames
      .map(detected => {
        let bestName  = null;
        let bestScore = 0;
        manualList.forEach(k => {
          const score = _lecturerMatchScore(detected, k);
          if (score > bestScore) { bestScore = score; bestName = k; }
        });
        return bestScore >= 0.40 ? bestName : null;
      })
      .filter(Boolean);
  }

  // No manual list → Firestore fallback, keep original if no match
  const firestoreNames = await loadKnownLecturers();
  if (!firestoreNames.length) return detectedNames;

  return detectedNames.map(detected => {
    let bestName  = detected;
    let bestScore = 0;
    firestoreNames.forEach(k => {
      const score = _lecturerMatchScore(detected, k);
      if (score > bestScore) { bestScore = score; bestName = k; }
    });
    return bestScore >= 0.40 ? bestName : detected;
  });
}

/* ══════════════════════════════════════════════════════════
   BULK UPLOAD
══════════════════════════════════════════════════════════ */

let _bulkFiles = []; // Array of File objects

function onBulkFilesSelected(input) {
  const files = Array.from(input.files || []);
  if (!files.length) return;
  files.forEach(f => {
    if (!_bulkFiles.find(x => x.name === f.name)) _bulkFiles.push(f);
  });
  renderBulkFileList();
  input.value = ''; // reset so same file can be re-added after clear
}

function renderBulkFileList() {
  const list = document.getElementById('bulk-file-list');
  const btn  = document.getElementById('bulk-start-btn');
  if (!list) return;

  if (!_bulkFiles.length) {
    list.style.display = 'none';
    if (btn) btn.disabled = true;
    return;
  }

  list.style.display = 'flex';
  if (btn) btn.disabled = false;

  list.innerHTML = _bulkFiles.map((f, i) => `
    <div id="bulk-file-row-${i}" style="display:flex;align-items:center;gap:.6rem;padding:.5rem .75rem;
         background:var(--bg,#f9fafb);border:1.5px solid var(--border,#e5e7eb);border-radius:8px">
      <span style="font-size:1.1rem">📄</span>
      <span style="flex:1;font-size:.85rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.name)}</span>
      <span style="font-size:.75rem;color:var(--muted)">${(f.size/1024).toFixed(0)} KB</span>
      <span id="bulk-status-${i}" style="font-size:.8rem;min-width:60px;text-align:center"></span>
      <button class="btn btn-danger btn-sm" onclick="removeBulkFile(${i})" style="flex-shrink:0">✕</button>
    </div>`).join('');

  // Setup drag-and-drop on zone
  const zone = document.getElementById('bulk-zone');
  if (zone) {
    zone.querySelector('.uz-text').textContent = `${_bulkFiles.length} קבצים נבחרו`;
    zone.querySelector('.uz-sub').textContent  = 'לחץ להוספת קבצים נוספים';
  }
}

function removeBulkFile(i) {
  _bulkFiles.splice(i, 1);
  renderBulkFileList();
}

function clearBulkFiles() {
  _bulkFiles = [];
  const zone = document.getElementById('bulk-zone');
  if (zone) {
    zone.querySelector('.uz-text').textContent = 'גרור מספר קבצי PDF לכאן';
    zone.querySelector('.uz-sub').textContent  = 'או לחץ לבחירה — ניתן לבחור מספר קבצים בו-זמנית';
  }
  renderBulkFileList();
  const logCard = document.getElementById('bulk-log-card');
  if (logCard) logCard.style.display = 'none';
}

function bulkLog(msg, type = '') {
  const log = document.getElementById('bulk-log');
  if (!log) return;
  const colors = { success: '#065f46', error: '#991b1b', info: 'var(--text)', warn: '#92400e' };
  const icons  = { success: '✅', error: '❌', warn: '⚠️', info: '·' };
  const el = document.createElement('div');
  el.style.cssText = `color:${colors[type]||colors.info};padding:.15rem 0;border-bottom:1px solid var(--border,#f3f4f6)`;
  el.textContent = `${icons[type]||''} ${msg}`;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

function setBulkFileStatus(i, icon, color) {
  const el = document.getElementById(`bulk-status-${i}`);
  if (el) { el.textContent = icon; el.style.color = color; }
}

async function startBulkUpload() {
  const courseId = document.getElementById('bulk-course').value;
  if (!courseId) { toast('נא לבחור קורס', 'error'); return; }
  if (!_bulkFiles.length) { toast('לא נבחרו קבצים', 'error'); return; }

  const btn = document.getElementById('bulk-start-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ מעלה...'; }

  // Show log
  const logCard = document.getElementById('bulk-log-card');
  const logEl   = document.getElementById('bulk-log');
  if (logCard) logCard.style.display = '';
  if (logEl)   logEl.innerHTML = '';

  // Invalidate lecturer cache so we pick up any newly added names
  _knownLecturers = null;

  // Collect manual lecturer list once before the loop
  const manualLecturers = getBulkKnownLecturers();
  if (manualLecturers.length) {
    bulkLog(`רשימת מרצים ידועים: ${manualLecturers.join(', ')}`, 'info');
  }

  let succeeded = 0;
  let failed    = 0;

  for (let i = 0; i < _bulkFiles.length; i++) {
    const file = _bulkFiles[i];
    const label = document.getElementById(`bulk-progress-label`);
    if (label) label.textContent = `${i + 1} / ${_bulkFiles.length}`;

    setBulkFileStatus(i, '⏳', '#d97706');
    bulkLog(`מתחיל: ${file.name}`, 'info');

    try {
      // 1. Read PDF as base64 (send directly — no image rendering needed)
      showSpinner(`📄 ${file.name} — קורא PDF...`);
      const base64 = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload  = () => res(r.result.split(',')[1]);
        r.onerror = () => rej(new Error('קריאת קובץ נכשלה'));
        r.readAsDataURL(file);
      });

      // 2. Parse with Claude (Opus → Sonnet → Haiku)
      showSpinner(`🤖 ${file.name} — Claude מנתח...`);
      let result = await processWithClaude('', { isPDF: true, base64, filenameHint: file.name });
      if (!result.questions) result = { questions: result, metadata: null };

      const meta      = result.metadata || {};
      const questions = (result.questions || []).filter(q => q.text || q.subs?.length);

      // 3. Normalize lecturer names against manual list + Firestore
      let lecturers = meta.lecturers || [];
      lecturers = await normalizeLecturerNames(lecturers, manualLecturers);

      // 4. Build title from filename
      const known = parseFilenameForBulk(file.name);
      const title = generateExamTitle(known.year || meta.year, known.semester || meta.semester, known.moed || meta.moed);

      bulkLog(`  זוהו ${questions.length} שאלות | כותרת: ${title || '(ללא)'} | מרצים: ${lecturers.join(', ') || '—'} | מודל: ${result.model || '?'}`, 'info');

      // 5. Upload PDF to Storage
      showSpinner(`📤 ${file.name} — מעלה PDF...`);
      const examId = genId();
      let pdfUrl = null;
      try {
        const stor = typeof storage !== 'undefined' && storage ? storage : firebase.storage();
        const ref  = stor.ref(`exam-pdfs/${examId}.pdf`);
        await ref.put(file);
        pdfUrl = await ref.getDownloadURL();
      } catch (e) {
        bulkLog(`  ⚠️ העלאת PDF נכשלה: ${e.message}`, 'warn');
      }

      // 6. Check for duplicate title in this course
      const finalTitle = title || file.name.replace(/\.[^/.]+$/, '');
      const dupSnap = await db.collection('exams')
        .where('courseId', '==', courseId)
        .where('title', '==', finalTitle)
        .get();
      if (!dupSnap.empty) {
        setBulkFileStatus(i, '⚠️', '#d97706');
        bulkLog(`  דולג — מבחן בשם "${finalTitle}" כבר קיים בקורס`, 'warn');
        failed++;
        continue;
      }

      // 7. Save exam to Firestore
      const exam = {
        id: examId, courseId,
        title: finalTitle,
        year:      known.year     || meta.year     || null,
        semester:  known.semester || meta.semester || null,
        moed:      known.moed     || meta.moed     || null,
        lecturers: lecturers.length ? lecturers : null,
        pdfUrl,
        parsedModel: result.model || null,
        verified: false,
        questions: questions.map(q => ({
          id: q.id || genId(), text: q.text, isBonus: q.isBonus === true,
          subs: (q.subs || []).map(s => ({ id: s.id || genId(), label: s.label, text: s.text }))
        })),
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        createdBy: adminUser?.email || 'admin',
      };

      await db.collection('exams').doc(examId).set(exam);

      // Invalidate cache so next file benefits from this lecturer
      _knownLecturers = null;

      setBulkFileStatus(i, '✅', '#065f46');
      bulkLog(`  הועלה בהצלחה → ${title}`, 'success');
      succeeded++;

    } catch (err) {
      console.error(err);
      setBulkFileStatus(i, '❌', '#991b1b');
      bulkLog(`  שגיאה: ${err.message}`, 'error');
      failed++;
    }
  }

  hideSpinner();
  if (btn) { btn.disabled = false; btn.textContent = '🚀 התחל העלאה'; }

  const label = document.getElementById('bulk-progress-label');
  if (label) label.textContent = `הסתיים — ${succeeded} הצליחו, ${failed} נכשלו`;

  bulkLog(`━━━ סיום: ${succeeded}/${_bulkFiles.length} הועלו בהצלחה ━━━`, succeeded === _bulkFiles.length ? 'success' : 'warn');
  toast(`הועלו ${succeeded}/${_bulkFiles.length} מבחנים`, succeeded === _bulkFiles.length ? 'success' : '');

  await refreshDashboard();
  await populateAllSelects();
}

// Thin wrapper so bulk upload can call parseFilename without circular issues
function parseFilenameForBulk(filename) {
  return typeof parseFilename === 'function' ? parseFilename(filename) : {};
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
 * Generate exam title code like "2025AB":
 * year + semester letter (A=א, B=ב, S=קיץ) + moed letter (A=א, B=ב, C=ג)
 */
function generateExamTitle(year, semester, moed) {
  if (!year) return '';
  const semMap  = { 'א': 'A', 'ב': 'B', 'קיץ': 'S' };
  const moedMap = { 'א': 'A', 'ב': 'B', 'ג': 'C' };
  const s = semMap[semester]  || '';
  const m = moedMap[moed]     || '';
  return `${year}${s}${m}`;
}

/**
 * Apply extracted metadata to the form fields.
 */
function applyExamMetadata(metadata) {
  if (!metadata) return;

  // Year
  if (metadata.year) {
    const el = document.getElementById('ae-year');
    if (el && !el.value) el.value = metadata.year;
  }

  // Semester
  if (metadata.semester) {
    const el = document.getElementById('ae-sem');
    if (el && !el.value) el.value = metadata.semester;
  }

  // Moed
  if (metadata.moed) {
    const el = document.getElementById('ae-moed');
    if (el && !el.value) el.value = metadata.moed;
  }

  // Lecturers — normalize against known names then add to widget
  if (Array.isArray(metadata.lecturers) && metadata.lecturers.length) {
    normalizeLecturerNames(metadata.lecturers).then(normalized => {
      normalized.forEach(n => {
        const name = (n || '').trim();
        if (name && !_lecturers.includes(name)) _lecturers.push(name);
      });
      _renderLecturersWidget();
    });
  }

  // Auto-generate title if not already set
  const titleEl = document.getElementById('ae-title');
  if (titleEl && !titleEl.value.trim()) {
    const title = generateExamTitle(metadata.year, metadata.semester, metadata.moed);
    if (title) titleEl.value = title;
  }

  // Course matching — try to match courseName to an existing course in the select
  let courseMatched = false;
  if (metadata.courseName) {
    const sel = document.getElementById('ae-course');
    if (sel && !sel.value) {
      const needle = _normalizeForMatch(metadata.courseName);
      let bestOption = null;
      let bestScore  = 0;

      Array.from(sel.options).forEach(opt => {
        if (!opt.value) return; // skip placeholder
        const score = _matchScore(needle, _normalizeForMatch(opt.text));
        if (score > bestScore) { bestScore = score; bestOption = opt; }
      });

      // Accept if similarity is good enough (>0.45)
      if (bestOption && bestScore > 0.45) {
        sel.value    = bestOption.value;
        courseMatched = true;
      }
    }
  }

  // Banner
  const filled = [];
  if (metadata.courseName) {
    filled.push(courseMatched
      ? `קורס: ${metadata.courseName} ✓`
      : `קורס שזוהה: "${metadata.courseName}" (לא נמצא — בחר ידנית)`);
  }
  if (metadata.year)              filled.push(`שנה: ${metadata.year}`);
  if (metadata.semester)          filled.push(`סמסטר: ${metadata.semester}`);
  if (metadata.moed)              filled.push(`מועד: ${metadata.moed}`);
  if (metadata.lecturers?.length) filled.push(`מרצים: ${metadata.lecturers.join(', ')}`);

  if (filled.length) {
    const banner = document.getElementById('meta-autofill-banner');
    if (banner) {
      banner.textContent = '✨ זוהה אוטומטית: ' + filled.join(' | ');
      banner.style.display = 'block';
      setTimeout(() => { banner.style.display = 'none'; }, 8000);
    }
  }
}

/** Normalize string for fuzzy matching: lowercase, strip punctuation/spaces */
function _normalizeForMatch(s) {
  return (s || '').toLowerCase()
    .replace(/['"״׳\-–]/g, '')
    .replace(/\b(ד"ר|דר|פרופ|פרופסור|prof|dr|assoc|mr|ms|mrs)\b\.?/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * General similarity score (used for course matching).
 */
function _matchScore(a, b) {
  if (!a || !b) return 0;
  if (a === b)  return 1;
  if (b.includes(a) || a.includes(b)) return 0.92;
  const wordsA = a.split(' ').filter(Boolean);
  const wordsB = b.split(' ').filter(Boolean);
  const setA   = new Set(wordsA);
  const setB   = new Set(wordsB);
  const lastA  = wordsA[wordsA.length - 1];
  const lastB  = wordsB[wordsB.length - 1];
  if (lastA && lastB && lastA === lastB) return 0.88;
  let common = 0;
  setA.forEach(w => { if (setB.has(w)) common++; });
  if (common > 0 && (wordsA.length === 1 || wordsB.length === 1)) return 0.85;
  return (2 * common) / (setA.size + setB.size);
}

/**
 * Lecturer-specific match: returns the best known name for a detected name.
 * Strategy: any significant word (≥2 chars) shared between detected and known
 * name counts as a match. This handles OCR returning partial names.
 */
function _lecturerMatchScore(detected, known) {
  if (!detected || !known) return 0;
  const d = _normalizeForMatch(detected);
  const k = _normalizeForMatch(known);
  if (!d || !k) return 0;
  if (d === k) return 1;
  if (k.includes(d) || d.includes(k)) return 0.95;

  const wordsD = d.split(' ').filter(w => w.length >= 2);
  const wordsK = k.split(' ').filter(w => w.length >= 2);
  const setK   = new Set(wordsK);

  // Any word from detected found in known name → strong match
  const anyMatch = wordsD.some(w => setK.has(w));
  if (anyMatch) return 0.85;

  // Partial word match: a word from detected starts with/contains a word from known
  const partialMatch = wordsD.some(wd =>
    wordsK.some(wk => wd.startsWith(wk) || wk.startsWith(wd))
  );
  if (partialMatch) return 0.70;

  return 0;
}

/**
 * Render PDF pages to base64 JPEG images using pdf.js canvas.
 * This replicates app.py's image-based Vision approach in the browser.
 */
async function renderPdfToBase64Images(file, maxPages = 15) {
  if (!pdfjsLib) initPdfJs();
  if (!pdfjsLib) throw new Error('pdf.js לא נטען');

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const total = Math.min(pdf.numPages, maxPages);
  const images = [];

  for (let i = 1; i <= total; i++) {
    showSpinner(`🖼️ מעבד עמוד ${i}/${total}...`);
    const page    = await pdf.getPage(i);
    const scale   = 2.0;                  // ~200 DPI equivalent
    const viewport = page.getViewport({ scale });
    const canvas  = document.createElement('canvas');
    canvas.width  = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    // toDataURL gives "data:image/jpeg;base64,..."
    const dataUrl = canvas.toDataURL('image/jpeg', 0.90);
    images.push(dataUrl.split(',')[1]);   // strip the prefix, keep base64 only
  }
  return images;
}

/**
 * Send images to Claude directly (Opus → Sonnet → Haiku).
 */
async function processWithVision(images, filenameHint) {
  const content = [
    { type: 'text', text: _buildDirectPrompt(filenameHint || '') },
  ];
  images.forEach((imgBase64, i) => {
    content.push({ type: 'text', text: `\n=== עמוד ${i + 1} ===` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imgBase64 } });
  });

  const data = await callClaudeDirect(
    [{ role: 'user', content }],
    (model, i) => showSpinner(`🤖 ניסיון ${i+1}/3: ${model}...`)
  );
  return _normalizeResult(data);
}

/**
 * Send exam PDF/text to Claude directly (Opus → Sonnet → Haiku).
 */
async function processWithClaude(text, opts = {}) {
  let messages;

  if (opts.isPDF && opts.base64) {
    messages = [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: opts.base64 } },
        { type: 'text', text: _buildDirectPrompt(opts.filenameHint || opts.titleHint || '') },
      ],
    }];
  } else {
    const hint = opts.titleHint ? `שם/קוד המבחן: "${opts.titleHint}". ` : '';
    messages = [{
      role: 'user',
      content: `${hint}אתה מנתח מבחן אקדמי. שלוף שאלות וסעיפים והחזר JSON בלבד.
פורמט: {"questions":[{"number":1,"text":"...","isBonus":false,"parts":[{"letter":"א","text":"..."}]}]}
הוראות: שלוף הכל, LaTeX ב-$...$, שמור עברית מקורית, החזר JSON תקני בלבד.

טקסט המבחן:
${text}`,
    }];
  }

  const data = await callClaudeDirect(
    messages,
    (model, i) => showSpinner(`🤖 ניסיון ${i+1}/3: ${model}...`)
  );
  return _normalizeResult(data);
}

/**
 * Normalize parsed result from any mode into { questions, metadata }.
 */
/**
 * Strip points notation from question/part text.
 * Handles all positions (start, end, after colon) and formats:
 *   (12 נק') / (12 נקודות) / (12 pts) / [10 points] / 12 נק'
 */
function stripPoints(text) {
  if (!text) return '';
  // Pattern matches the points block in any format
  const pts = /\(?\s*\d+\.?\d*\s*(נק'|נקודות|pts?|points?|נק)\s*\)?/gi;
  return text
    .replace(pts, '')   // remove all occurrences anywhere in the string
    .replace(/^\s*[-–—:,]\s*/, '')  // clean leftover leading punctuation
    .replace(/\s*[-–—:,]\s*$/, '')  // clean leftover trailing punctuation
    .replace(/\s{2,}/g, ' ')        // collapse double spaces
    .trim();
}

function _normalizeResult(parsed) {
  const questions = (parsed.questions || []).map((q, i) => {
    const text  = stripPoints(q.text || '');
    const bonus = q.isBonus === true || BONUS_REGEX.test(text);
    return {
      id:      genId(),
      index:   q.number || i + 1,
      text,
      isBonus: bonus,
      subs:    (q.parts || []).map(p => ({
        id:    genId(),
        label: '(' + (p.letter || '') + ')',
        text:  stripPoints(p.text || '')
      }))
    };
  });
  return { questions, metadata: parsed.metadata || null, model: parsed.model || null };
}

function _normalizeQuestions(parsed) {
  return _normalizeResult(parsed).questions;
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

function setupBulkZone() {
  const zone = document.getElementById('bulk-zone');
  if (!zone) return;
  zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
  zone.addEventListener('dragenter', e => { e.preventDefault(); zone.classList.add('drag'); });
  zone.addEventListener('drop', e => {
    e.preventDefault(); zone.classList.remove('drag');
    const files = Array.from(e.dataTransfer.files).filter(f =>
      f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
    if (files.length) {
      files.forEach(f => { if (!_bulkFiles.find(x => x.name === f.name)) _bulkFiles.push(f); });
      renderBulkFileList();
    }
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
    if (s) s.textContent = `${(file.size / 1024).toFixed(0)} KB — ממתין לניתוח Vision...`;
  }

  const isPDF = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');

  setStatus('📤 קורא קובץ...');
  setProgress(10);
  showSpinner('📄 קורא קובץ...');

  try {
    let result; // { questions, metadata }

    if (isPDF) {
      /* ── Vision path: render pages → images → Claude Vision ── */
      setStatus('🖼️ ממיר PDF לתמונות...');
      setProgress(20);

      let images;
      try {
        images = await renderPdfToBase64Images(file, 15);
      } catch (renderErr) {
        // pdf.js not available or render failed — fall back to base64 PDF mode
        console.warn('Vision render failed, falling back to PDF base64 mode:', renderErr.message);
        images = null;
      }

      if (images && images.length > 0) {
        setProgress(45);
        setStatus(`🤖 Claude Vision מנתח ${images.length} עמודים...`);
        showSpinner(`🤖 Claude Vision מנתח ${images.length} עמודים...`);
        result = await processWithVision(images, file.name);
      } else {
        // Fallback: send PDF as base64 document
        setProgress(45);
        setStatus('🤖 Claude מנתח PDF...');
        showSpinner('🤖 Claude מנתח PDF...');
        const base64 = await new Promise((res, rej) => {
          const r = new FileReader();
          r.onload  = () => res(r.result.split(',')[1]);
          r.onerror = () => rej(new Error('קריאת קובץ נכשלה'));
          r.readAsDataURL(file);
        });
        const data = await processWithClaude('', { isPDF: true, base64 });
        result = typeof data === 'object' && data.questions ? data : { questions: data, metadata: null };
      }

    } else {
      /* ── Text / LaTeX file ── */
      setProgress(30);
      showSpinner('📖 קורא טקסט...');
      const text = await file.text();
      document.getElementById('raw-text').value = text;
      setProgress(50);
      setStatus('🤖 Claude מנתח טקסט...');
      showSpinner('🤖 Claude מנתח טקסט...');
      const titleHint = document.getElementById('ae-title')?.value?.trim() || '';
      const data = await processWithClaude(text, { titleHint });
      result = typeof data === 'object' && data.questions ? data : { questions: data, metadata: null };
    }

    setProgress(95);

    parsedQuestions = result.questions || [];
    _parsedModel   = result.model || null;

    // Auto-fill metadata into form fields
    if (result.metadata) {
      applyExamMetadata(result.metadata);
    }

    // Auto-set this PDF as the download file for students
    if (isPDF) {
      _examPdfFile = file;
      const nameEl  = document.getElementById('ae-pdf-name');
      const clearEl = document.getElementById('ae-pdf-clear');
      if (nameEl)  nameEl.textContent = file.name;
      if (clearEl) clearEl.style.display = '';
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
let _parsedModel    = null;  // which Claude model parsed the current exam

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
    const result = await processWithClaude(raw, { titleHint });
    const questions = result.questions || result; // backward compat

    setProgress(100);
    parsedQuestions = Array.isArray(questions) ? questions : [];
    if (result.metadata) applyExamMetadata(result.metadata);
    if (statusEl) statusEl.textContent = `✅ זוהו ${parsedQuestions.length} שאלות`;

    if (titleHint && !result.metadata) {
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
      parsedModel: _parsedModel || null,
      verified:  false,
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
  _parsedModel    = null;
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
      <td><button class="btn btn-secondary btn-sm" onclick="showSection('courses')">✏️</button></td>
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

let _manageTab = 'all'; // 'all' | 'verified' | 'unverified'

function setManageTab(tab) {
  _manageTab = tab;
  document.querySelectorAll('.manage-tab').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById(`tab-${tab}`);
  if (btn) btn.classList.add('active');
  renderManageTable();
}

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

    // Stats
    const allDocs    = snap.docs;
    const totalCount = allDocs.length;
    const verifiedCount   = allDocs.filter(d => d.data().verified === true).length;
    const unverifiedCount = totalCount - verifiedCount;

    // Update stats bar
    const statsEl = document.getElementById('manage-stats');
    if (statsEl) {
      statsEl.innerHTML = `
        <span class="stat-chip" style="background:#f3f4f6;color:#374151">📋 סה"כ: <strong>${totalCount}</strong></span>
        <span class="stat-chip" style="background:#d1fae5;color:#065f46">✅ נבדקו: <strong>${verifiedCount}</strong></span>
        <span class="stat-chip" style="background:#fef9c3;color:#92400e">❌ לא נבדקו: <strong>${unverifiedCount}</strong></span>
      `;
    }

    // Update tab labels with counts
    const tabAll = document.getElementById('tab-all');
    const tabV   = document.getElementById('tab-verified');
    const tabU   = document.getElementById('tab-unverified');
    if (tabAll) tabAll.textContent = `הכל (${totalCount})`;
    if (tabV)   tabV.textContent   = `✅ נבדקו (${verifiedCount})`;
    if (tabU)   tabU.textContent   = `❌ לא נבדקו (${unverifiedCount})`;

    // Filter by tab
    let filteredDocs = allDocs;
    if (_manageTab === 'verified')   filteredDocs = allDocs.filter(d => d.data().verified === true);
    if (_manageTab === 'unverified') filteredDocs = allDocs.filter(d => !d.data().verified);

    if (!filteredDocs.length) {
      const emptyMsg = _manageTab === 'verified' ? 'אין מבחנים שנבדקו' : _manageTab === 'unverified' ? 'כל המבחנים נבדקו! 🎉' : 'אין מבחנים';
      container.innerHTML = `<div class="empty"><span class="ei">📭</span><h3>${emptyMsg}</h3></div>`;
      return;
    }

    // Sort client-side: newest first
    const sortedDocs = filteredDocs.slice().sort((a, b) => {
      const ta = a.data().createdAt?.toMillis?.() || a.data().updatedAt?.toMillis?.() || 0;
      const tb = b.data().createdAt?.toMillis?.() || b.data().updatedAt?.toMillis?.() || 0;
      return tb - ta;
    });

    const rows = sortedDocs.map(d => {
      const e = { ...d.data(), id: d.id };
      const qIds = (e.questions || []).map(q => q.id).filter(Boolean).join(',');
      const modelShort = (e.parsedModel || '').replace('claude-','').split('-202')[0] || '—';
      const modelColor = e.parsedModel?.includes('opus') ? '#7c3aed'
                       : e.parsedModel?.includes('sonnet') ? '#2563eb'
                       : e.parsedModel?.includes('haiku') ? '#059669' : '#6b7280';
      return `<tr style="background:${e.verified ? '#d1fae5' : '#fef9c3'}">
        <td><strong>${esc(e.title)}</strong></td>
        <td>${esc(courseMap[e.courseId] || e.courseId)}</td>
        <td>${e.year || '-'}</td>
        <td>${esc(e.semester) || '-'}</td>
        <td>${esc(e.moed) || '-'}</td>
        <td>${_fmtLecturers(e.lecturers || e.lecturer)}</td>
        <td><span class="badge b-gray">${(e.questions || []).length}</span></td>
        <td><span class="badge" style="font-size:.7rem;background:${modelColor};color:#fff">${esc(modelShort)}</span></td>
        <td style="text-align:center">
          <input type="checkbox" ${e.verified ? 'checked' : ''} onchange="toggleVerified('${e.id}',this.checked,this)" title="סמן כנבדק" style="width:18px;height:18px;cursor:pointer">
        </td>
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
      <thead><tr><th>כותרת</th><th>קורס</th><th>שנה</th><th>סמסטר</th><th>מועד</th><th>מרצה</th><th>שאלות</th><th>מודל</th><th>נבדק</th><th>קושי</th><th></th></tr></thead>
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

async function toggleVerified(examId, checked, cb) {
  try {
    // Instant visual feedback
    const row = cb?.closest?.('tr');
    if (row) row.style.background = checked ? '#d1fae5' : '#fef9c3';

    await db.collection('exams').doc(examId).update({
      verified: checked,
      verifiedAt: checked ? firebase.firestore.FieldValue.serverTimestamp() : null,
      verifiedBy: checked ? (adminUser?.email || 'admin') : null,
    });
    toast(checked ? '✅ מבחן סומן כנבדק' : '↩️ סימון נבדק הוסר');
  } catch (e) {
    toast('שגיאה: ' + e.message, 'error');
    // Revert on error
    if (cb) cb.checked = !checked;
    const row = cb?.closest?.('tr');
    if (row) row.style.background = !checked ? '#d1fae5' : '#fef9c3';
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
      <td><button class="btn btn-secondary btn-sm" onclick="openEditCourse('${c.id}','${esc(c.name)}','${esc(c.code)}','${esc(c.icon || '')}')">✏️ עריכה</button></td>
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

/* ── Edit Course Modal ─────────────────────────────────────── */

const COURSE_ICONS = ['📐','📊','⚛️','🧮','🔬','🧬','💻','🌍','🏛️','📖',
                      '🎓','🔭','📈','🧪','🔢','📜','🗓️','🖥️','🎯','⚙️',
                      '🔑','🌐','📡','🧲','🔐','🗂️','📋','📌','🏗️','🔍'];

function openEditCourse(id, name, code, icon) {
  // Remove existing modal if any
  const existing = document.getElementById('edit-course-modal');
  if (existing) existing.remove();

  const iconsHtml = COURSE_ICONS.map(ic => `
    <button type="button" class="icon-pick-btn ${ic === icon ? 'selected' : ''}"
            onclick="selectCourseIcon(this, '${ic}')">${ic}</button>
  `).join('');

  const modal = document.createElement('div');
  modal.id = 'edit-course-modal';
  modal.style.cssText = `
    position:fixed;inset:0;z-index:9999;
    background:rgba(0,0,0,.55);
    display:flex;align-items:center;justify-content:center;
    padding:1rem;
  `;
  modal.innerHTML = `
    <div style="background:var(--card,#fff);border-radius:16px;padding:2rem;
                width:100%;max-width:480px;box-shadow:0 8px 32px rgba(0,0,0,.2);
                direction:rtl;position:relative">
      <button onclick="document.getElementById('edit-course-modal').remove()"
              style="position:absolute;top:1rem;left:1rem;background:none;border:none;
                     font-size:1.3rem;cursor:pointer;color:var(--muted,#888)">✕</button>
      <h3 style="margin:0 0 1.5rem;font-size:1.1rem;font-weight:700">✏️ עריכת קורס</h3>

      <input type="hidden" id="edit-course-id" value="${esc(id)}">

      <div class="form-group">
        <label style="font-weight:600">שם קורס</label>
        <input id="edit-course-name" type="text" value="${esc(name)}"
               placeholder="אנליזה 1">
      </div>

      <div class="form-group">
        <label style="font-weight:600">קוד קורס</label>
        <input id="edit-course-code" type="text" value="${esc(code)}"
               placeholder="104031" dir="ltr">
      </div>

      <div class="form-group">
        <label style="font-weight:600">אייקון</label>
        <div id="edit-course-icon-selected"
             style="font-size:2rem;margin:.35rem 0 .75rem;min-height:2.5rem">${esc(icon) || '🎓'}</div>
        <input type="hidden" id="edit-course-icon" value="${esc(icon) || '🎓'}">
        <div style="display:flex;flex-wrap:wrap;gap:.35rem;max-height:160px;
                    overflow-y:auto;padding:.5rem;border:1.5px solid var(--border,#e5e7eb);
                    border-radius:10px">
          ${iconsHtml}
        </div>
      </div>

      <div style="display:flex;gap:.75rem;justify-content:flex-end;margin-top:1.5rem">
        <button class="btn btn-secondary"
                onclick="document.getElementById('edit-course-modal').remove()">ביטול</button>
        <button class="btn btn-primary" onclick="saveEditCourse()">💾 שמור שינויים</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  // Close on backdrop click
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

function selectCourseIcon(btn, icon) {
  document.querySelectorAll('.icon-pick-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  document.getElementById('edit-course-icon').value = icon;
  document.getElementById('edit-course-icon-selected').textContent = icon;
}

async function saveEditCourse() {
  const id   = document.getElementById('edit-course-id').value;
  const name = document.getElementById('edit-course-name').value.trim();
  const code = document.getElementById('edit-course-code').value.trim();
  const icon = document.getElementById('edit-course-icon').value;

  if (!name || !code) { toast('נא למלא שם וקוד', 'error'); return; }

  const saveBtn = document.querySelector('#edit-course-modal .btn-primary');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'שומר...'; }

  try {
    await db.collection('courses').doc(id).update({
      name,
      code,
      icon,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedBy: adminUser?.email || 'unknown',
    });
    document.getElementById('edit-course-modal').remove();
    toast('✅ הקורס עודכן בהצלחה', 'success');
    await renderCoursesList();
    await populateAllSelects();
    await refreshDashboard();
  } catch (e) {
    toast('שגיאה בעדכון: ' + e.message, 'error');
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '💾 שמור שינויים'; }
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

  try {
    const snap   = await db.collection('authorized_users').get();
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

async function _loadReportsBadge() {
  try {
    const snap = await db.collection('reports').where('status', '==', 'open').get();
    const badge = document.getElementById('reports-badge');
    if (!badge) return;
    if (snap.size > 0) { badge.textContent = snap.size; badge.style.display = 'inline-block'; }
    else badge.style.display = 'none';
  } catch(e) { console.warn('_loadReportsBadge:', e.message); }
}

/* ══════════════════════════════════════════════════════════════
   REPORTS SECTION
   ═══════════════════════════════════════════════════════════ */

let _reportsCurrentTab = 'open'; // 'open' | 'archived'

function switchReportsTab(tab) {
  _reportsCurrentTab = tab;
  document.getElementById('reports-tab-open')?.classList.toggle('active', tab === 'open');
  document.getElementById('reports-tab-archived')?.classList.toggle('active', tab === 'archived');
  _renderReportsContent();
}

async function renderReportsSection() {
  const el = document.getElementById('reports-content');
  if (el) el.innerHTML = '<div class="spinner" style="margin:2rem auto"></div>';

  // update badge with open count
  try {
    const snap = await db.collection('reports').where('status', '==', 'open').get();
    const badge = document.getElementById('reports-badge');
    if (badge) {
      if (snap.size > 0) { badge.textContent = snap.size; badge.style.display = 'inline-block'; }
      else badge.style.display = 'none';
    }
  } catch(e) { /* non-critical */ }

  _renderReportsContent();
}

async function _renderReportsContent() {
  const el = document.getElementById('reports-content');
  if (!el) return;
  el.innerHTML = '<div class="spinner" style="margin:2rem auto"></div>';

  const isArchive = _reportsCurrentTab === 'archived';
  const status    = isArchive ? 'closed' : 'open';

  try {
    const snap = await db.collection('reports').where('status', '==', status).get();

    const items = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));

    if (!items.length) {
      el.innerHTML = `
        <div class="empty" style="padding:2.5rem;text-align:center">
          <span style="font-size:2rem;display:block;margin-bottom:.5rem">${isArchive ? '🗂️' : '📭'}</span>
          <h3 style="font-weight:600;margin-bottom:.3rem">${isArchive ? 'הארכיון ריק' : 'אין דיווחים פתוחים'}</h3>
          <p style="color:var(--muted);font-size:.88rem">${isArchive ? 'עוד לא נסגרו דיווחים' : 'כל הדיווחים טופלו'}</p>
        </div>`;
      return;
    }

    const rows = items.map(r => {
      const date = r.createdAt?.toDate?.();
      const dateStr = date
        ? date.toLocaleDateString('he-IL', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' })
        : '—';

      const closedDate = r.closedAt?.toDate?.();
      const closedStr  = closedDate
        ? closedDate.toLocaleDateString('he-IL', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' })
        : '—';

      const categoryBadge = r.category === 'bug'
        ? `<span class="badge" style="background:#fef3c7;color:#92400e;border:1px solid #fcd34d">⚠ תקלה</span>`
        : `<span class="badge" style="background:#ede9fe;color:#5b21b6;border:1px solid #c4b5fd">✉ פנייה</span>`;

      const typeBadge = r.category === 'contact' && r.typeLabel
        ? `<span class="badge b-blue" style="font-size:.72rem">${esc(r.typeLabel)}</span>`
        : '';

      const examInfo = r.examId
        ? `<div style="font-size:.78rem;color:var(--muted);margin-top:.25rem">מבחן: <strong>${esc(r.examTitle || r.examId)}</strong></div>`
        : '';

      const closedInfo = isArchive
        ? `<div style="font-size:.75rem;color:var(--muted);margin-top:.3rem;display:flex;flex-direction:column;gap:.15rem">
             <span>נסגר על ידי: <strong>${esc(r.closedByEmail || '—')}</strong> · ${closedStr}</span>
             ${r.closedNote ? `<span style="color:var(--text);font-size:.8rem;margin-top:.15rem">💬 ${esc(r.closedNote)}</span>` : ''}
           </div>`
        : '';

      const actionBtn = isArchive
        ? `<button class="btn btn-sm" style="background:#fee2e2;color:#b91c1c;border-color:#fca5a5"
             onclick="deleteReport('${esc(r.id)}')">🗑 מחק לצמיתות</button>`
        : `<button class="btn btn-secondary btn-sm" onclick="closeReport('${esc(r.id)}')">✓ סגור תקלה</button>`;

      return `
        <div class="ac" style="margin-bottom:.75rem">
          <div style="padding:1rem 1.25rem;display:flex;flex-direction:column;gap:.5rem">
            <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap">
              ${categoryBadge}${typeBadge}
              <span style="font-size:.78rem;color:var(--muted);margin-right:auto">${dateStr}</span>
            </div>
            <div style="font-size:.83rem;color:var(--muted)">
              <strong>${esc(r.userEmail || '—')}</strong>
            </div>
            ${examInfo}
            <div style="background:var(--bg,#f9fafb);border-radius:8px;padding:.65rem .9rem;
                        font-size:.9rem;line-height:1.6;border:1px solid var(--border);
                        white-space:pre-wrap;word-break:break-word">${esc(r.message)}</div>
            ${closedInfo}
            <div style="display:flex;justify-content:flex-end">${actionBtn}</div>
          </div>
        </div>`;
    }).join('');

    el.innerHTML = rows;

  } catch(e) {
    el.innerHTML = `<div style="color:var(--danger);padding:1.5rem">שגיאה בטעינה: ${esc(e.message)}</div>`;
  }
}

function closeReport(reportId) {
  if (!adminUser) return;

  // Remove any existing close modal
  document.getElementById('close-report-modal')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'close-report-modal';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:20000;padding:1rem;backdrop-filter:blur(2px)';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:14px;width:min(94vw,440px);box-shadow:0 20px 60px rgba(0,0,0,.28);direction:rtl;overflow:hidden">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:1rem 1.25rem;border-bottom:1px solid var(--border)">
        <h3 style="margin:0;font-size:1rem;font-weight:700">✓ סגור דיווח</h3>
        <button onclick="document.getElementById('close-report-modal').remove()"
          style="background:none;border:none;cursor:pointer;font-size:1rem;color:var(--muted);padding:.2rem .4rem;border-radius:6px">✕</button>
      </div>
      <div style="padding:1.25rem;display:flex;flex-direction:column;gap:.9rem">
        <div class="form-group" style="margin:0">
          <label style="font-weight:600;font-size:.85rem">הערה לסגירה <span style="font-weight:400;color:var(--muted)">(אופציונלי)</span></label>
          <textarea id="close-report-note" rows="3" dir="rtl"
            placeholder="למשל: טופל, לא ניתן לשחזר..."
            style="width:100%;border:1.5px solid var(--border);border-radius:8px;padding:.75rem;
                   font-family:inherit;font-size:.88rem;resize:vertical;box-sizing:border-box;
                   color:var(--text);margin-top:.35rem"></textarea>
        </div>
        <div id="close-report-err" style="color:var(--danger);font-size:.82rem;display:none"></div>
        <div style="display:flex;justify-content:flex-end;gap:.75rem">
          <button class="btn btn-secondary" onclick="document.getElementById('close-report-modal').remove()">ביטול</button>
          <button class="btn btn-primary" id="close-report-confirm-btn"
            onclick="_doCloseReport('${esc(reportId)}')">✓ אשר סגירה</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.getElementById('close-report-note')?.focus();
}

async function _doCloseReport(reportId) {
  const btn  = document.getElementById('close-report-confirm-btn');
  const note = document.getElementById('close-report-note')?.value.trim() || '';
  const errEl = document.getElementById('close-report-err');
  if (btn) { btn.disabled = true; btn.textContent = 'שומר...'; }

  try {
    const update = {
      status:        'closed',
      closedAt:      firebase.firestore.FieldValue.serverTimestamp(),
      closedBy:      adminUser.uid   || '',
      closedByEmail: adminUser.email || '',
    };
    if (note) update.closedNote = note;
    await db.collection('reports').doc(reportId).update(update);
    document.getElementById('close-report-modal')?.remove();
    toast('הדיווח נסגר והועבר לארכיון', 'info');
    renderReportsSection();
  } catch(e) {
    if (btn) { btn.disabled = false; btn.textContent = '✓ אשר סגירה'; }
    if (errEl) { errEl.textContent = 'שגיאה: ' + e.message; errEl.style.display = 'block'; }
  }
}

async function deleteReport(reportId) {
  if (!confirm('למחוק את הדיווח לצמיתות? פעולה זו אינה הפיכה.')) return;
  try {
    await db.collection('reports').doc(reportId).delete();
    toast('הדיווח נמחק', 'info');
    renderReportsSection();
  } catch(e) {
    toast('שגיאה במחיקה: ' + e.message, 'error');
  }
}

