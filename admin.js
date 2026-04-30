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

function safeUrl(u) {
  if (!u) return '';
  try { const p = new URL(u); return ['https:','http:'].includes(p.protocol) ? esc(u) : ''; }
  catch { return ''; }
}

function normalizeHttpUrl(u) {
  if (!u) return '';
  try {
    const p = new URL(String(u).trim());
    return ['https:','http:'].includes(p.protocol) ? p.toString() : '';
  } catch {
    return '';
  }
}

function sanitizeStorageFileName(name) {
  return String(name || 'image')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'image';
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
   CLAUDE API via Edge Function — server-side proxy.
   No timeout. Tries Opus → Sonnet → Haiku.
   ═══════════════════════════════════════════════════════════ */
const PARSE_EXAM_ENDPOINT = '/api/parse-exam';
let _geminiKey       = null;
const FEW_SHOT_MAX_EXAMPLES = 3;
const LOW_CONFIDENCE_THRESHOLD = 70;
const _fewShotCache = new Map();
let _lastParseQuality = null;

async function loadApiKeys() {
  try {
    const doc = await db.collection('settings').doc('api_keys').get();
    if (doc.exists && doc.data().gemini) {
      _geminiKey = doc.data().gemini;
      console.log('✅ Gemini API key loaded');
    }
    console.log('✅ Anthropic API key is server-side (edge function)');
  } catch (e) { console.warn('Could not load API keys:', e.message); }
}

/**
 * Call Claude via the parse-exam edge function.
 * Client drives fallback: Opus → Sonnet → Haiku with live spinner.
 * @param {Array} messages — Claude messages array
 * @returns {Promise<{questions, metadata, usage, model}>}
 */
let _parseAbortController = null;

const CLAUDE_MODELS_DISPLAY = [
  { id: 'claude-opus-4-6',            name: 'Opus' },
  { id: 'claude-sonnet-4-6',          name: 'Sonnet' },
  { id: 'claude-haiku-4-5-20251001',  name: 'Haiku' },
];

function abortParsing() {
  if (_parseAbortController) {
    _parseAbortController.abort();
    _parseAbortController = null;
    toast('⛔ הניתוח בוטל', 'error');
    hideSpinner();
  }
}

async function callClaudeViaEdge(messages) {
  _parseAbortController = new AbortController();
  const signal = _parseAbortController.signal;
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) throw new Error('לא מחובר — יש להתחבר מחדש');

  let lastErr = null;

  for (let i = 0; i < CLAUDE_MODELS_DISPLAY.length; i++) {
    const { id: modelId, name: modelName } = CLAUDE_MODELS_DISPLAY[i];
    const attempt = i + 1;
    const total = CLAUDE_MODELS_DISPLAY.length;

    // Update spinner with current model attempt
    showSpinner(`🤖 מנתח עם Claude ${modelName} — ניסיון ${attempt}/${total}`, true);

    if (signal.aborted) throw new DOMException('Parsing aborted', 'AbortError');

    try {
      const response = await fetch(PARSE_EXAM_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`,
        },
        body: JSON.stringify({ messages, model: modelId }),
        signal,
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        let errData = {};
        try { errData = JSON.parse(errText); } catch {}
        const errMsg = errData.error || `HTTP ${response.status}`;

        // If retryable (529/5xx/invalid format), try next model
        if (errData.retryable && i < CLAUDE_MODELS_DISPLAY.length - 1) {
          console.warn(`⚠️ ${modelName}: ${errMsg} — trying next model...`);
          showSpinner(`⚠️ ${modelName} נכשל — עובר למודל הבא...`);
          await new Promise(r => setTimeout(r, 800)); // brief pause so user sees the message
          lastErr = errMsg;
          continue;
        }
        throw new Error(errMsg);
      }

      const data = await response.json();

      if (!data.questions || !Array.isArray(data.questions)) {
        throw new Error('תשובה לא תקנית מהשרת');
      }

      // Show which model succeeded
      const usedModel = modelName;
      showSpinner(`✅ ${usedModel} — ${data.questions.length} שאלות`);
      console.log(`✅ ${data.model}: ${data.questions.length} questions parsed (via edge function)`);
      return data;

    } catch (err) {
      if (err.name === 'AbortError') throw err;
      if (err.message && i < CLAUDE_MODELS_DISPLAY.length - 1 && !err.message.startsWith('לא מחובר')) {
        console.warn(`⚠️ ${modelName}: ${err.message}`);
        lastErr = err.message;
        continue;
      }
      throw err;
    }
  }

  throw new Error(lastErr || 'כל המודלים נכשלו');
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

function _tokenizeForSimilarity(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\.[^/.]+$/, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.length >= 2);
}

function _overlapScore(a, b) {
  if (!a.length || !b.length) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let common = 0;
  sa.forEach(x => { if (sb.has(x)) common++; });
  return common / Math.max(sa.size, sb.size);
}

function _truncate(s, n = 280) {
  const str = String(s || '').trim();
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

function _sampleQuestionsForPrompt(questions, limit = 3) {
  return (questions || []).slice(0, limit).map((q, i) => ({
    number: q.number || q.index || i + 1,
    text: _truncate(q.text || '', 300),
    isBonus: q.isBonus === true,
    parts: (q.parts || q.subs || []).slice(0, 3).map((p, pi) => ({
      letter: p.letter || p.label || String(pi + 1),
      text: _truncate(p.text || '', 220),
    }))
  }));
}

async function getApprovedFewShotExamples({ courseId = '', titleHint = '', filenameHint = '', limit = FEW_SHOT_MAX_EXAMPLES } = {}) {
  try {
    const key = JSON.stringify({ courseId: courseId || '', titleHint: titleHint || '', filenameHint: filenameHint || '', limit });
    if (_fewShotCache.has(key)) return _fewShotCache.get(key);

    const snap = await db.collection('parse_examples')
      .where('approved', '==', true)
      .limit(80)
      .get();

    const queryTokens = _tokenizeForSimilarity(`${titleHint || ''} ${filenameHint || ''}`);
    const scored = snap.docs.map(d => ({ id: d.id, ...d.data() })).map(ex => {
      const exTokens = _tokenizeForSimilarity(`${ex.title || ''} ${ex.filenameHint || ''} ${ex.titlePattern || ''}`);
      const overlap = _overlapScore(queryTokens, exTokens);
      const courseBoost = (courseId && ex.courseId === courseId) ? 0.45 : 0;
      const qualityBoost = typeof ex.parseQualityScore === 'number'
        ? Math.max(0, Math.min(1, ex.parseQualityScore / 100)) * 0.2
        : 0;
      return { ex, score: overlap + courseBoost + qualityBoost };
    });

    const best = scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .filter(x => x.score > 0.05)
      .map(x => x.ex);

    _fewShotCache.set(key, best);
    return best;
  } catch (e) {
    console.warn('Few-shot retrieval skipped:', e.message);
    return [];
  }
}

function buildFewShotPromptBlock(examples = []) {
  if (!examples.length) return '';
  const rows = examples.map((ex, i) => {
    const payload = {
      metadata: {
        courseName: ex.metadata?.courseName || ex.courseName || null,
        lecturers: ex.metadata?.lecturers || ex.lecturers || [],
        year: ex.metadata?.year || ex.year || null,
        semester: ex.metadata?.semester || ex.semester || null,
        moed: ex.metadata?.moed || ex.moed || null,
      },
      questions: _sampleQuestionsForPrompt(ex.questions || [], 3),
    };
    return `דוגמה ${i + 1} (מאושרת):\n${JSON.stringify(payload)}`;
  }).join('\n\n');

  return `\n\n════ דוגמאות מאושרות ללמידת סגנון (Few-shot) ════\n` +
    `חקה את מבנה הפלט, חלוקת הסעיפים, וסגנון LaTeX כפי שמודגם בדוגמאות.\n` +
    `אל תעתיק תוכן מילולי לא רלוונטי; שמור על דיוק לטקסט הקלט הנוכחי בלבד.\n\n` +
    rows + `\n\n`;
}

function computeParseQuality(result, context = {}) {
  const questions = result?.questions || [];
  const metadata  = result?.metadata || {};
  const flags = [];
  let score = 100;

  if (!questions.length) {
    score -= 85;
    flags.push('לא זוהו שאלות');
  }

  const avgLen = questions.length
    ? questions.reduce((s, q) => s + String(q.text || '').trim().length, 0) / questions.length
    : 0;
  if (questions.length && avgLen < 24) {
    score -= 18;
    flags.push('טקסט שאלות קצר מהרגיל');
  }

  const emptyQuestions = questions.filter(q => !String(q.text || '').trim() && !(q.subs || []).length).length;
  if (emptyQuestions > 0) {
    score -= Math.min(22, emptyQuestions * 8);
    flags.push(`יש ${emptyQuestions} שאלות ריקות`);
  }

  const noPartsRatio = questions.length
    ? (questions.filter(q => !(q.subs || []).length).length / questions.length)
    : 1;
  if (questions.length >= 4 && noPartsRatio > 0.9) {
    score -= 10;
    flags.push('רוב השאלות ללא סעיפים');
  }

  if (!metadata.year) { score -= 6; flags.push('שנה חסרה במטאדאטה'); }
  if (!metadata.semester) { score -= 5; flags.push('סמסטר חסר במטאדאטה'); }
  if (!metadata.moed) { score -= 5; flags.push('מועד חסר במטאדאטה'); }

  const allText = questions.map(q => String(q.text || '')).join(' ');
  const dollarCount = (allText.match(/\$/g) || []).length;
  if (dollarCount % 2 !== 0) {
    score -= 8;
    flags.push('ייתכן LaTeX לא מאוזן ($)');
  }

  const filenameInfo = _parseFilenameHint(context.filenameHint || '');
  if (filenameInfo.year && metadata.year && Number(filenameInfo.year) !== Number(metadata.year)) {
    score -= 7;
    flags.push('שנה לא תואמת לשם הקובץ');
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const confidence = score >= 85 ? 'high' : score >= LOW_CONFIDENCE_THRESHOLD ? 'medium' : 'low';

  return {
    score,
    confidence,
    flags,
    needsManualReview: score < LOW_CONFIDENCE_THRESHOLD,
  };
}

async function saveParseExample(exam, opts = {}) {
  if (!exam?.id) return;
  const approved = opts.approved === true;
  const quality = opts.quality || null;
  const payload = {
    examId: exam.id,
    approved,
    source: opts.source || 'single',
    title: exam.title || '',
    titlePattern: (exam.title || '').replace(/\d/g, '#'),
    filenameHint: opts.filenameHint || null,
    courseId: exam.courseId || null,
    year: exam.year || null,
    semester: exam.semester || null,
    moed: exam.moed || null,
    lecturers: exam.lecturers || [],
    metadata: {
      courseName: opts.courseName || null,
      lecturers: exam.lecturers || [],
      year: exam.year || null,
      semester: exam.semester || null,
      moed: exam.moed || null,
    },
    questions: (exam.questions || []).map((q, i) => ({
      number: q.index || i + 1,
      text: q.text || '',
      isBonus: q.isBonus === true,
      parts: (q.subs || []).map(s => ({ letter: s.label || '', text: s.text || '' })),
    })),
    parsedModel: exam.parsedModel || null,
    parseQualityScore: quality?.score ?? null,
    parseConfidence: quality?.confidence ?? null,
    parseFlags: quality?.flags || [],
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    updatedBy: adminUser?.email || 'admin',
  };

  await db.collection('parse_examples').doc(`exam_${exam.id}`).set(payload, { merge: true });
  _fewShotCache.clear();
}

/**
 * Phase 3 helper: export approved examples as JSONL for optional fine-tune/open-model workflows.
 * This is optional and invoked manually from console: exportApprovedExamplesForFineTune()
 */
async function exportApprovedExamplesForFineTune(limit = 300) {
  const snap = await db.collection('parse_examples')
    .where('approved', '==', true)
    .limit(Math.max(1, Math.min(limit, 1000)))
    .get();

  const lines = snap.docs.map(d => d.data()).map(ex => {
    const input = {
      filenameHint: ex.filenameHint || ex.title || '',
      metadataHint: ex.metadata || {},
      instruction: 'חלץ מטאדאטה ושאלות בפורמט JSON תקני',
    };
    const output = {
      metadata: ex.metadata || {},
      questions: ex.questions || [],
    };
    return JSON.stringify({ input, output, tags: { courseId: ex.courseId || null, examId: ex.examId || null } });
  });

  const blob = new Blob([lines.join('\n')], { type: 'application/jsonl;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `parse-examples-approved-${Date.now()}.jsonl`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  await db.collection('model_training_exports').add({
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    createdBy: adminUser?.email || 'admin',
    examples: lines.length,
    format: 'jsonl',
    note: 'approved parse examples export',
  });

  toast(`📦 יוצאו ${lines.length} דוגמאות לאימון`, 'success');
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

/* ── Assigned lecturers (uid-based) widget ─────────────── */
// Each entry: { uid, label }
let _assignedLecturers = [];
let _instructorOptionsCache = null; // [{ uid, email, displayName }]

async function _loadInstructorOptions() {
  if (_instructorOptionsCache) return _instructorOptionsCache;
  try {
    // Accept both canonical 'instructor' and legacy Hebrew 'מרצה' role values
    const snap = await db.collection('users').where('role', 'in', ['instructor', 'מרצה']).get();
    const seen = new Set();
    _instructorOptionsCache = snap.docs
      .map(d => {
        const data = d.data() || {};
        return { uid: d.id, email: data.email || '', displayName: data.displayName || '' };
      })
      .filter(u => { if (seen.has(u.uid)) return false; seen.add(u.uid); return true; })
      .sort((a, b) => (a.email || '').localeCompare(b.email || ''));
  } catch (e) {
    console.warn('_loadInstructorOptions failed:', e.message);
    _instructorOptionsCache = [];
  }
  return _instructorOptionsCache;
}

async function _populateAssignedLecturerSelect() {
  const sel = document.getElementById('ae-assigned-lecturer-select');
  if (!sel) return;
  const list = await _loadInstructorOptions();
  const taken = new Set(_assignedLecturers.map(a => a.uid));
  const opts = list
    .filter(u => !taken.has(u.uid))
    .map(u => {
      const label = u.displayName ? `${u.displayName} <${u.email}>` : u.email || u.uid;
      return `<option value="${esc(u.uid)}">${esc(label)}</option>`;
    }).join('');
  sel.innerHTML = `<option value="">— בחר מרצה רשום —</option>${opts}`;
}

function _renderAssignedLecturersWidget() {
  const el = document.getElementById('assigned-lecturers-list');
  if (!el) return;
  el.innerHTML = _assignedLecturers.length
    ? _assignedLecturers.map((a, i) => `<span class="lecturer-tag">
        <span class="lecturer-tag-name">${esc(a.label || a.uid)}</span>
        <button class="lecturer-tag-rm" onclick="removeAssignedLecturer(${i})" title="הסר">✕</button>
      </span>`).join('')
    : '<span class="lecturer-empty">לא שויכו מרצים</span>';
  _populateAssignedLecturerSelect();
}

async function addAssignedLecturer() {
  const sel = document.getElementById('ae-assigned-lecturer-select');
  if (!sel) return;
  const uid = sel.value;
  if (!uid) return;
  if (_assignedLecturers.some(a => a.uid === uid)) return;
  const list = await _loadInstructorOptions();
  const u = list.find(x => x.uid === uid);
  const label = u ? (u.displayName ? `${u.displayName} <${u.email}>` : u.email || uid) : uid;
  _assignedLecturers.push({ uid, label });
  sel.value = '';
  _renderAssignedLecturersWidget();
}

function removeAssignedLecturer(idx) {
  _assignedLecturers.splice(idx, 1);
  _renderAssignedLecturersWidget();
}

async function _setAssignedLecturers(uids) {
  if (!Array.isArray(uids)) uids = [];
  const list = await _loadInstructorOptions();
  _assignedLecturers = uids.filter(Boolean).map(uid => {
    const u = list.find(x => x.uid === uid);
    const label = u ? (u.displayName ? `${u.displayName} <${u.email}>` : u.email || uid) : uid;
    return { uid, label };
  });
  _renderAssignedLecturersWidget();
}

function _clearAssignedLecturers() {
  _assignedLecturers = [];
  _renderAssignedLecturersWidget();
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
      // auth/user-not-found is no longer emitted by newer Firebase SDK versions.
      // Kept here for emulator / legacy SDK compatibility only.
      'auth/user-not-found':       'אימייל לא קיים במערכת',
      'auth/wrong-password':       'סיסמה שגויה',
      // auth/invalid-login-credentials replaces both auth/wrong-password and
      // auth/user-not-found in newer SDK versions — use a generic message to
      // avoid leaking whether the email or password is incorrect (user enumeration).
      'auth/invalid-login-credentials': 'אימייל או סיסמה שגויים',
      'auth/invalid-credential':   'אימייל או סיסמה שגויים',
      'auth/invalid-email':        'פורמט אימייל לא תקין',
      'auth/too-many-requests':    'יותר מדי ניסיונות — נסה שוב מאוחר יותר',
      'auth/network-request-failed': 'שגיאת רשת — בדוק חיבור לאינטרנט',
    };
    err.textContent = messages[e.code] || 'שגיאת התחברות — נסה שוב';
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
      const userData = userDoc.exists ? userDoc.data() : null;

      // ── Forced password change gate ─────────────────────────
      // If an admin flagged this account, block admin panel access
      // and bounce to the main app where the change-password UI lives.
      if (userData?.mustChangePassword === true) {
        try { sessionStorage.setItem('vaultau_forced_pw_redirect', '1'); } catch (_) {}
        // Don't sign out — keep the session so course.js can clear the flag
        // after they set a new password.
        location.href = '/index.html';
        return;
      }

      if (userData?.role === 'admin') {
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
    await loadApiKeys();
    await populateAllSelects();
    await refreshDashboard();
    await renderManageTable();
    // טעינת בדאג'ים ברקע
    _loadReportsBadge();
    await renderCoursesList();
    setupUploadZone();
    setupBulkZone();
    setupBulkSolZone();
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
  if (name === 'add-exam')    { populateAllSelects(); _renderAssignedLecturersWidget(); }
  if (name === 'analytics')   renderAnalytics();
  if (name === 'users')       renderUserStats();
  if (name === 'manage-users') renderManageUsers();
  if (name === 'survey')      renderSurveyManager();
  if (name === 'reports')     renderReportsSection();
  if (name === 'ai-monitor')  renderAIMonitor();
  if (name === 'broadcast')   renderBroadcastSection();
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
    ['ae-course', 'manage-filter', 'an-filter', 'bulk-course', 'bc-course'].forEach(id => {
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
let _bulkSolFiles = []; // Array of File objects for solution PDFs

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
  if (!list) return;

  if (!_bulkFiles.length) {
    list.style.display = 'none';
    updateBulkStartBtn();
    return;
  }

  list.style.display = 'flex';
  updateBulkStartBtn();

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
  _bulkSolFiles = [];
  const zone = document.getElementById('bulk-zone');
  if (zone) {
    zone.querySelector('.uz-text').textContent = 'גרור מספר קבצי PDF לכאן';
    zone.querySelector('.uz-sub').textContent  = 'או לחץ לבחירה — ניתן לבחור מספר קבצים בו-זמנית';
  }
  const solZone = document.getElementById('bulk-sol-zone');
  if (solZone) {
    solZone.querySelector('.uz-text').textContent = 'גרור קבצי פתרונות לכאן';
    solZone.querySelector('.uz-sub').textContent  = 'או לחץ לבחירה — ניתן לבחור מספר קבצים בו-זמנית';
  }
  renderBulkFileList();
  renderBulkSolFileList();
  const logCard = document.getElementById('bulk-log-card');
  if (logCard) logCard.style.display = 'none';
}

/* ── Bulk solution file management ─────────────────────────── */

function onBulkSolFilesSelected(input) {
  const files = Array.from(input.files || []);
  if (!files.length) return;
  files.forEach(f => {
    if (!_bulkSolFiles.find(x => x.name === f.name)) _bulkSolFiles.push(f);
  });
  renderBulkSolFileList();
  input.value = '';
}

function renderBulkSolFileList() {
  const list = document.getElementById('bulk-sol-file-list');
  if (!list) return;

  if (!_bulkSolFiles.length) {
    list.style.display = 'none';
    updateBulkStartBtn();
    return;
  }

  list.style.display = 'flex';
  updateBulkStartBtn();

  list.innerHTML = _bulkSolFiles.map((f, i) => `
    <div id="bulk-sol-row-${i}" style="display:flex;align-items:center;gap:.6rem;padding:.5rem .75rem;
         background:var(--bg,#f9fafb);border:1.5px solid var(--border,#e5e7eb);border-radius:8px">
      <span style="font-size:1.1rem">📝</span>
      <span style="flex:1;font-size:.85rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.name)}</span>
      <span style="font-size:.75rem;color:var(--muted)">${(f.size/1024).toFixed(0)} KB</span>
      <span id="bulk-sol-status-${i}" style="font-size:.8rem;min-width:60px;text-align:center"></span>
      <button class="btn btn-danger btn-sm" onclick="removeBulkSolFile(${i})" style="flex-shrink:0">✕</button>
    </div>`).join('');

  const zone = document.getElementById('bulk-sol-zone');
  if (zone) {
    zone.querySelector('.uz-text').textContent = `${_bulkSolFiles.length} קבצי פתרונות נבחרו`;
    zone.querySelector('.uz-sub').textContent  = 'לחץ להוספת קבצים נוספים';
  }
}

function removeBulkSolFile(i) {
  _bulkSolFiles.splice(i, 1);
  renderBulkSolFileList();
}

function setBulkSolFileStatus(i, icon, color) {
  const el = document.getElementById(`bulk-sol-status-${i}`);
  if (el) { el.textContent = icon; el.style.color = color; }
}

/** Parse solution filename: e.g. 2022AB_sol.pdf → { title: "2022AB", type: "sol" } */
function parseSolFilename(filename) {
  const f = filename.replace(/\.[^/.]+$/, ''); // strip extension
  const m = f.match(/^(20\d{2}[A-Za-z]{2})_(sol|all)$/i);
  if (!m) return null;
  return { title: m[1].toUpperCase(), type: m[2].toLowerCase() };
}

/** Enable bulk start button when at least one file (exam or solution) is selected */
function updateBulkStartBtn() {
  const btn = document.getElementById('bulk-start-btn');
  if (btn) btn.disabled = !_bulkFiles.length && !_bulkSolFiles.length;
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
  if (!_bulkFiles.length && !_bulkSolFiles.length) { toast('לא נבחרו קבצים', 'error'); return; }

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
  const totalExams = _bulkFiles.length;

  // ── Phase 1: Upload exam files ───────────────────────────
  for (let i = 0; i < _bulkFiles.length; i++) {
    const file = _bulkFiles[i];
    const label = document.getElementById(`bulk-progress-label`);
    if (label) label.textContent = `מבחנים: ${i + 1} / ${_bulkFiles.length}`;

    setBulkFileStatus(i, '⏳', '#d97706');
    bulkLog(`מתחיל: ${file.name}`, 'info');

    try {
      // 1. Parse with the same PDF pipeline as single upload (Vision-first + fallback)
      let result = await parsePdfWithSharedPipeline(file, {
        onRenderStart: () => {
          showSpinner(`🖼️ ${file.name} — ממיר PDF לתמונות...`);
        },
        onVisionStart: (pages) => {
          showSpinner(`🤖 ${file.name} — Claude Vision מנתח ${pages} עמודים...`);
        },
        onFallbackStart: () => {
          showSpinner(`🤖 ${file.name} — Claude מנתח PDF...`);
        }
      }, {
        courseId,
        filenameHint: file.name,
        titleHint: file.name,
      });
      if (!result.questions) result = { questions: result, metadata: null };

      const meta      = result.metadata || {};
      const questions = (result.questions || []).filter(q => q.text || q.subs?.length);
      const known = parseFilenameForBulk(file.name);
      const title = generateExamTitle(known.year || meta.year, known.semester || meta.semester, known.moed || meta.moed);
      const quality = computeParseQuality({ questions, metadata: meta }, {
        filenameHint: file.name,
        titleHint: title,
      });

      // 3. Normalize lecturer names against manual list + Firestore
      let lecturers = meta.lecturers || [];
      lecturers = await normalizeLecturerNames(lecturers, manualLecturers);

      // 4. Build title from filename
      bulkLog(`  זוהו ${questions.length} שאלות | כותרת: ${title || '(ללא)'} | מרצים: ${lecturers.join(', ') || '—'} | מודל: ${result.model || '?'}`, 'info');
      if (quality.needsManualReview) {
        bulkLog(`  נדרש מעבר ידני — איכות פענוח ${quality.score}/100`, 'warn');
      }

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
        assignedLecturers: [],
        hiddenFromStudents: false,
        pdfUrl,
        solutionPdfUrl: null,
        parsedModel: result.model || null,
        parseQualityScore: quality.score,
        parseConfidence: quality.confidence,
        parseFlags: quality.flags,
        needsManualReview: quality.needsManualReview,
        verified: false,
        questions: questions.map(q => ({
          id: q.id || genId(), text: q.text, isBonus: q.isBonus === true,
          subs: (q.subs || []).map(s => ({ id: s.id || genId(), label: s.label, text: s.text, isBonus: s.isBonus === true }))
        })),
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        createdBy: adminUser?.email || 'admin',
      };

      await db.collection('exams').doc(examId).set(exam);

      // Bulk uploads are stored as non-approved examples for future curation.
      try {
        await saveParseExample(exam, {
          approved: false,
          quality,
          source: 'bulk',
          filenameHint: file.name,
          courseName: meta.courseName || null,
        });
      } catch (exErr) {
        console.warn('Could not save bulk parse example:', exErr.message);
      }

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

  // ── Phase 2: Upload solution files ───────────────────────
  let solSucceeded = 0;
  let solFailed    = 0;

  if (_bulkSolFiles.length) {
    bulkLog(`\n━━━ מתחיל העלאת ${_bulkSolFiles.length} פתרונות ━━━`, 'info');
  }

  for (let i = 0; i < _bulkSolFiles.length; i++) {
    const file = _bulkSolFiles[i];
    const label = document.getElementById('bulk-progress-label');
    if (label) label.textContent = `פתרונות: ${i + 1} / ${_bulkSolFiles.length}`;

    setBulkSolFileStatus(i, '⏳', '#d97706');
    bulkLog(`פתרון: ${file.name}`, 'info');

    try {
      // 1. Parse filename to extract exam title and type
      const parsed = parseSolFilename(file.name);
      if (!parsed) {
        setBulkSolFileStatus(i, '⚠️', '#d97706');
        bulkLog(`  דולג — שם קובץ לא תקין. נדרש פורמט YYYYXZ_sol או YYYYXZ_all`, 'warn');
        solFailed++;
        continue;
      }

      // 2. Find the matching exam in this course
      const examSnap = await db.collection('exams')
        .where('courseId', '==', courseId)
        .where('title', '==', parsed.title)
        .get();

      if (examSnap.empty) {
        setBulkSolFileStatus(i, '⚠️', '#d97706');
        bulkLog(`  לא נמצא מבחן "${parsed.title}" בקורס — דולג`, 'warn');
        solFailed++;
        continue;
      }

      const examDoc = examSnap.docs[0];
      const examData = examDoc.data();

      // 3. Determine solutionPdfUrl
      let solutionPdfUrl;

      if (parsed.type === 'all') {
        // _all: same file as the exam PDF — just point to pdfUrl
        if (examData.pdfUrl) {
          solutionPdfUrl = examData.pdfUrl;
          bulkLog(`  _all — משתמש ב-PDF המבחן הקיים כפתרון`, 'info');
        } else {
          // No exam PDF exists, upload this file as both exam and solution
          showSpinner(`📤 ${file.name} — מעלה PDF...`);
          const stor = typeof storage !== 'undefined' && storage ? storage : firebase.storage();
          const ref = stor.ref(`exam-pdfs/${examDoc.id}.pdf`);
          await ref.put(file);
          solutionPdfUrl = await ref.getDownloadURL();
          bulkLog(`  _all — הועלה כ-PDF מבחן + פתרון`, 'info');
        }
      } else {
        // _sol: upload as separate solution PDF
        showSpinner(`📤 ${file.name} — מעלה פתרון...`);
        const stor = typeof storage !== 'undefined' && storage ? storage : firebase.storage();
        const ref = stor.ref(`solution-pdfs/${examDoc.id}.pdf`);
        await ref.put(file);
        solutionPdfUrl = await ref.getDownloadURL();
      }

      // 4. Update exam document with solutionPdfUrl
      await db.collection('exams').doc(examDoc.id).update({
        solutionPdfUrl,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });

      setBulkSolFileStatus(i, '✅', '#065f46');
      bulkLog(`  פתרון עודכן בהצלחה → ${parsed.title}`, 'success');
      solSucceeded++;

    } catch (err) {
      console.error(err);
      setBulkSolFileStatus(i, '❌', '#991b1b');
      bulkLog(`  שגיאה: ${err.message}`, 'error');
      solFailed++;
    }
  }

  hideSpinner();
  if (btn) { btn.disabled = false; btn.textContent = '🚀 התחל העלאה'; }

  const label = document.getElementById('bulk-progress-label');
  const totalAll = totalExams + _bulkSolFiles.length;
  const successAll = succeeded + solSucceeded;
  const failAll = failed + solFailed;
  if (label) label.textContent = `הסתיים — ${successAll} הצליחו, ${failAll} נכשלו`;

  if (totalExams) {
    bulkLog(`━━━ מבחנים: ${succeeded}/${totalExams} הועלו בהצלחה ━━━`, succeeded === totalExams ? 'success' : 'warn');
  }
  if (_bulkSolFiles.length) {
    bulkLog(`━━━ פתרונות: ${solSucceeded}/${_bulkSolFiles.length} עודכנו בהצלחה ━━━`, solSucceeded === _bulkSolFiles.length ? 'success' : 'warn');
  }
  toast(`סיום: ${successAll}/${totalAll} הועלו`, successAll === totalAll ? 'success' : '');

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
 * Shared PDF parsing pipeline used by both single and bulk upload.
 * Tries Vision first, then falls back to PDF document mode.
 */
async function parsePdfWithSharedPipeline(file, hooks = {}, parseOpts = {}) {
  const { onRenderStart, onVisionStart, onFallbackStart } = hooks;

  if (onRenderStart) onRenderStart();

  let images;
  try {
    images = await renderPdfToBase64Images(file, 15);
  } catch (renderErr) {
    // pdf.js not available or render failed — fall back to base64 PDF mode
    console.warn('Vision render failed, falling back to PDF base64 mode:', renderErr.message);
    images = null;
  }

  if (images && images.length > 0) {
    if (onVisionStart) onVisionStart(images.length);
    return await processWithVision(images, file.name, parseOpts);
  }

  if (onFallbackStart) onFallbackStart();
  const base64 = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload  = () => res(r.result.split(',')[1]);
    r.onerror = () => rej(new Error('קריאת קובץ נכשלה'));
    r.readAsDataURL(file);
  });

  const data = await processWithClaude('', {
    isPDF: true,
    base64,
    filenameHint: file.name,
    titleHint: parseOpts.titleHint || '',
    courseId: parseOpts.courseId || '',
  });
  return typeof data === 'object' && data.questions ? data : { questions: data, metadata: null };
}

/**
 * Send images to Claude via edge function (Opus → Sonnet → Haiku fallback server-side).
 */
async function processWithVision(images, filenameHint, opts = {}) {
  const examples = await getApprovedFewShotExamples({
    courseId: opts.courseId || '',
    filenameHint: filenameHint || '',
    titleHint: opts.titleHint || '',
  });
  const fewShot = buildFewShotPromptBlock(examples);
  const content = [
    { type: 'text', text: _buildDirectPrompt(filenameHint || '') + fewShot },
  ];
  images.forEach((imgBase64, i) => {
    content.push({ type: 'text', text: `\n=== עמוד ${i + 1} ===` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imgBase64 } });
  });

  showSpinner('🤖 מתחיל ניתוח...');
  const data = await callClaudeViaEdge(
    [{ role: 'user', content }]
  );
  return _normalizeResult(data);
}

/**
 * Send exam PDF/text to Claude directly (Opus → Sonnet → Haiku).
 */
async function processWithClaude(text, opts = {}) {
  let messages;
  const examples = await getApprovedFewShotExamples({
    courseId: opts.courseId || '',
    filenameHint: opts.filenameHint || '',
    titleHint: opts.titleHint || '',
  });
  const fewShot = buildFewShotPromptBlock(examples);

  if (opts.isPDF && opts.base64) {
    messages = [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: opts.base64 } },
        { type: 'text', text: _buildDirectPrompt(opts.filenameHint || opts.titleHint || '') + fewShot },
      ],
    }];
  } else {
    const hint = opts.titleHint ? `שם/קוד המבחן: "${opts.titleHint}". ` : '';
    messages = [{
      role: 'user',
      content: `${hint}${fewShot}אתה מנתח מבחן אקדמי. שלוף שאלות וסעיפים והחזר JSON בלבד.
פורמט: {"questions":[{"number":1,"text":"...","isBonus":false,"parts":[{"letter":"א","text":"..."}]}]}
הוראות: שלוף הכל, LaTeX ב-$...$, שמור עברית מקורית, החזר JSON תקני בלבד.

טקסט המבחן:
${text}`,
    }];
  }

  showSpinner('🤖 מתחיל ניתוח...');
  const data = await callClaudeViaEdge(
    messages
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
      inlineImages: {},
      isBonus: bonus,
      subs:    (q.parts || []).map(p => ({
        id:    genId(),
        label: '(' + (p.letter || '') + ')',
        text:  stripPoints(p.text || ''),
        inlineImages: {},
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
function showSpinner(msg = '🤖 Claude מנתח...', showAbort = false) {
  let overlay = document.getElementById('ai-spinner-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'ai-spinner-overlay';
    overlay.className = 'ai-spinner-overlay';
    overlay.innerHTML = `
      <div class="ai-spinner-card">
        <div class="ai-spinner-ring"></div>
        <div class="ai-spinner-msg" id="ai-spinner-msg">${msg}</div>
        <button class="ai-spinner-abort btn btn-sm" id="ai-spinner-abort" onclick="abortParsing()" style="display:none">⛔ ביטול</button>
      </div>`;
    document.body.appendChild(overlay);
  } else {
    document.getElementById('ai-spinner-msg').textContent = msg;
  }
  const abortBtn = document.getElementById('ai-spinner-abort');
  if (abortBtn) abortBtn.style.display = showAbort ? '' : 'none';
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

function setupBulkSolZone() {
  const zone = document.getElementById('bulk-sol-zone');
  if (!zone) return;
  zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
  zone.addEventListener('dragenter', e => { e.preventDefault(); zone.classList.add('drag'); });
  zone.addEventListener('drop', e => {
    e.preventDefault(); zone.classList.remove('drag');
    const files = Array.from(e.dataTransfer.files).filter(f =>
      f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
    if (files.length) {
      files.forEach(f => { if (!_bulkSolFiles.find(x => x.name === f.name)) _bulkSolFiles.push(f); });
      renderBulkSolFileList();
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
      result = await parsePdfWithSharedPipeline(file, {
        onRenderStart: () => {
          setStatus('🖼️ ממיר PDF לתמונות...');
          setProgress(20);
        },
        onVisionStart: (pages) => {
          setProgress(45);
          setStatus(`🤖 Claude Vision מנתח ${pages} עמודים...`);
          showSpinner(`🤖 Claude Vision מנתח ${pages} עמודים...`);
        },
        onFallbackStart: () => {
          setProgress(45);
          setStatus('🤖 Claude מנתח PDF...');
          showSpinner('🤖 Claude מנתח PDF...');
        }
      }, {
        courseId: document.getElementById('ae-course')?.value || '',
        filenameHint: file.name,
        titleHint: document.getElementById('ae-title')?.value?.trim() || '',
      });

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
    _lastParseQuality = computeParseQuality(result, {
      filenameHint: file.name,
      titleHint: document.getElementById('ae-title')?.value?.trim() || '',
    });

    if (_lastParseQuality.needsManualReview) {
      const statusMsg = `⚠️ איכות פענוח נמוכה (${_lastParseQuality.score}/100) — מומלץ לעבור ידנית`;
      setStatus(statusMsg, 'var(--danger)');
      toast(statusMsg, 'error');
    }

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
    const modelTag = _parsedModel ? _parsedModel.replace('claude-','').split('-202')[0] : 'unknown';
    setStatus(`✅ זוהו ${parsedQuestions.length} שאלות (${modelTag})`, 'var(--success)');
    renderPreview();
    toast(`✅ AI זיהה ${parsedQuestions.length} שאלות (מודל: ${modelTag})`, 'success');
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
let _editingExamHidden = false; // preserve hiddenFromStudents flag across edits
let _examPdfFile    = null;  // File object selected for PDF download upload
let _solPdfFile     = null;  // File object selected for solution PDF upload
let _parsedModel    = null;  // which Claude model parsed the current exam
let _loadedExamImageUrls = new Set();
let _pendingImageDeletes  = new Set(); // URLs uploaded this session but removed before save

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

/* ── Solution PDF handlers (add/edit exam) ─────────────────── */

function onSolPdfSelected(input) {
  const file = input.files[0];
  if (!file) return;
  _solPdfFile = file;
  const nameEl  = document.getElementById('ae-sol-name');
  const clearEl = document.getElementById('ae-sol-clear');
  if (nameEl)  nameEl.textContent = file.name;
  if (clearEl) clearEl.style.display = '';
}

function clearSolPdf() {
  _solPdfFile = null;
  const fileEl    = document.getElementById('ae-sol-file');
  const nameEl    = document.getElementById('ae-sol-name');
  const clearEl   = document.getElementById('ae-sol-clear');
  const urlEl     = document.getElementById('ae-sol-url');
  const currentEl = document.getElementById('ae-sol-current');
  if (fileEl)    fileEl.value = '';
  if (nameEl)    nameEl.textContent = 'לא נבחר קובץ';
  if (clearEl)   clearEl.style.display = 'none';
  if (urlEl)     urlEl.value = '';
  if (currentEl) currentEl.style.display = 'none';
}

async function uploadSolPdf(examId) {
  if (!_solPdfFile) return null;

  const stor = typeof storage !== 'undefined' && storage
    ? storage
    : firebase.storage();

  if (!stor) throw new Error('Firebase Storage לא זמין — וודא שה-SDK נטען');

  const ref = stor.ref(`solution-pdfs/${examId}.pdf`);

  return await new Promise((resolve, reject) => {
    const uploadTask = ref.put(_solPdfFile);

    const timeout = setTimeout(() => {
      uploadTask.cancel();
      reject(new Error('העלאת פתרון נכשלה: חרגה מ-60 שניות'));
    }, 60000);

    uploadTask.on('state_changed',
      (snapshot) => {
        const pct = Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100);
        showSpinner(`📤 מעלה פתרון... ${pct}%`);
      },
      (error) => {
        clearTimeout(timeout);
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

async function uploadInlineImageFile(file, storagePath, onProgress) {
  const stor = typeof storage !== 'undefined' && storage
    ? storage
    : firebase.storage();

  if (!stor) throw new Error('Firebase Storage לא זמין — וודא שה-SDK נטען');

  const ref = stor.ref(storagePath);

  return await new Promise((resolve, reject) => {
    const uploadTask = ref.put(file);

    const timeout = setTimeout(() => {
      uploadTask.cancel();
      reject(new Error('העלאת תמונה נכשלה: חרגה מ-60 שניות'));
    }, 60000);

    uploadTask.on('state_changed',
      (snapshot) => {
        const pct = Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100);
        if (onProgress) onProgress(pct);
      },
      (error) => {
        clearTimeout(timeout);
        const messages = {
          'storage/unauthorized':     'אין הרשאה להעלות תמונה — בדוק Firebase Storage Rules',
          'storage/canceled':         'העלאת התמונה בוטלה',
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

const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

function extractImageFileFromPasteEvent(e) {
  const items = e?.clipboardData?.items || [];
  for (const item of items) {
    if (item?.type && ALLOWED_IMAGE_TYPES.has(item.type)) {
      return item.getAsFile();
    }
  }
  return null;
}

function insertTextAtCursor(textarea, text) {
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  const next = textarea.value.slice(0, start) + text + textarea.value.slice(end);
  textarea.value = next;
  const caret = start + text.length;
  textarea.selectionStart = caret;
  textarea.selectionEnd = caret;
}

function removeTokenFromText(text, ref) {
  const escaped = String(ref || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(text || '')
    .replace(new RegExp(`\\n?!\\[[^\\]]*\\]\\(${escaped}\\)\\n?`, 'g'), '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function deleteInlineImageFromEntity(entity, ref) {
  if (!entity) return;
  entity.text = removeTokenFromText(entity.text || '', ref);
  if (String(ref || '').startsWith('img:')) {
    const key = String(ref).slice(4);
    if (entity.inlineImages && typeof entity.inlineImages === 'object') {
      delete entity.inlineImages[key];
    }
  }
}

function removeInlineImageToken(qi, si, ref) {
  const q = parsedQuestions[qi];
  if (!q) return;
  const entity = (si === null || si === undefined) ? q : q.subs?.[si];
  if (!entity) return;
  const entry = resolveInlineImageEntry(ref, entity.inlineImages || {});
  deleteInlineImageFromEntity(entity, ref);
  renderPreview();
  // Defer Storage deletion to save time so a cancel/refresh cannot orphan the Firestore token.
  if (entry?.url && !entry.uploading) {
    const safe = normalizeHttpUrl(entry.url);
    if (safe) _pendingImageDeletes.add(safe);
  }
}

function filterInlineImagesForText(text, inlineImages) {
  const keys = new Set(extractInlineImageKeysFromText(text));
  return Object.fromEntries(
    Object.entries(normalizeInlineImagesMap(inlineImages)).filter(([key]) => keys.has(key))
  );
}

function refreshInlinePreviewContainer(containerId, text, inlineImages, idPrefix, qi, si) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = renderEditorInlineImagePreview(text, inlineImages, idPrefix, qi, si);
}

function updateQuestionText(qi, val) {
  if (!parsedQuestions[qi]) return;
  parsedQuestions[qi].text = val;
  refreshInlinePreviewContainer(`q-inline-preview-${qi}`, val, parsedQuestions[qi].inlineImages, `q-${qi}`, qi, null);
  refreshInlinePreviewContainer(`qb-inline-preview-${qi}`, val, parsedQuestions[qi].inlineImages, `qb-${qi}`, qi, null);
}

function updateSubText(qi, si, val) {
  if (!parsedQuestions[qi]?.subs?.[si]) return;
  parsedQuestions[qi].subs[si].text = val;
  refreshInlinePreviewContainer(`s-inline-preview-${qi}-${si}`, val, parsedQuestions[qi].subs[si].inlineImages, `s-${qi}-${si}`, qi, si);
}

function setDropActive(el, on) {
  if (!el) return;
  el.classList.toggle('pq-drop-active', !!on);
}

function getImageFileFromDropEvent(e) {
  const files = Array.from(e?.dataTransfer?.files || []);
  return files.find(f => ALLOWED_IMAGE_TYPES.has(String(f.type || ''))) || null;
}

async function insertImageFileIntoEntity(file, entity, textarea, successMsg, storagePathBuilder, renderCallback) {
  if (file.size > MAX_IMAGE_SIZE_BYTES) {
    toast(`הקובץ גדול מדי (${(file.size / 1024 / 1024).toFixed(1)} MB) — המקסימום הוא 10 MB`, 'error');
    return;
  }
  entity.inlineImages = normalizeInlineImagesMap(entity.inlineImages);
  const key = genId();
  const token = `img:${key}`;
  entity.inlineImages[key] = {
    url: URL.createObjectURL(file),
    uploading: true,
    progress: 0,
    error: '',
  };
  insertTextAtCursor(textarea, `\n![image](${token})\n`);
  entity.text = textarea.value;
  renderCallback();

  showSpinner('📤 מעלה תמונה...');
  try {
    let lastPct = 0;
    const url = await uploadInlineImageFile(file, storagePathBuilder(), (pct) => {
      if (pct - lastPct < 10 && pct < 100) return;
      lastPct = pct;
      if (entity.inlineImages[key]) {
        entity.inlineImages[key].progress = pct;
        renderCallback();
      }
    });
    entity.inlineImages[key] = { url, uploading: false, progress: 100, error: '' };
    toast(successMsg, 'success');
  } catch (err) {
    if (entity.inlineImages[key]) {
      entity.inlineImages[key].uploading = false;
      entity.inlineImages[key].error = err.message || 'שגיאה בהעלאה';
    }
    toast('שגיאה בהעלאת תמונה: ' + err.message, 'error');
  } finally {
    renderCallback();
    hideSpinner();
  }
}

function collectPersistedInlineImageUrls(exam) {
  const urls = new Set();
  (exam?.questions || []).forEach(q => {
    Object.values(q.inlineImages || {}).forEach(url => {
      const safe = normalizeHttpUrl(typeof url === 'string' ? url : url?.url || '');
      if (safe) urls.add(safe);
    });
    (q.subs || q.parts || []).forEach(s => {
      Object.values(s.inlineImages || {}).forEach(url => {
        const safe = normalizeHttpUrl(typeof url === 'string' ? url : url?.url || '');
        if (safe) urls.add(safe);
      });
    });
  });
  return urls;
}

async function deleteStorageFileByUrl(url) {
  const safe = normalizeHttpUrl(url);
  if (!safe) return true;
  const stor = typeof storage !== 'undefined' && storage ? storage : firebase.storage();
  if (!stor?.refFromURL) return false;
  try {
    await stor.refFromURL(safe).delete();
    return true;
  } catch (e) {
    if (e?.code === 'storage/object-not-found') return true;
    console.warn('Could not delete removed image from storage:', safe, e?.message || e);
    return false;
  }
}

function extractImageRefsFromText(text) {
  const refs = [];
  const re = /!\[([^\]]*)\]\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    refs.push({ alt: m[1] || 'image', ref: (m[2] || '').trim() });
  }
  return refs;
}

function extractInlineImageKeysFromText(text) {
  return extractImageRefsFromText(text)
    .map(it => it.ref)
    .filter(ref => String(ref || '').startsWith('img:'))
    .map(ref => ref.slice(4));
}

function normalizeInlineImagesMap(map) {
  if (!map || typeof map !== 'object') return {};
  return map;
}

function resolveInlineImageEntry(ref, inlineImages) {
  if (!ref) return null;
  if (ref.startsWith('http://') || ref.startsWith('https://')) {
    return { url: ref, uploading: false, progress: 100, error: '' };
  }
  if (!ref.startsWith('img:')) return null;
  const key = ref.slice(4);
  const raw = normalizeInlineImagesMap(inlineImages)[key];
  if (!raw) return null;
  if (typeof raw === 'string') {
    return { url: raw, uploading: false, progress: 100, error: '' };
  }
  return {
    url: raw.url || '',
    uploading: raw.uploading === true,
    progress: Number(raw.progress || 0),
    error: raw.error || '',
  };
}

function renderEditorInlineImagePreview(text, inlineImages, idPrefix = '', qi = null, si = null) {
  const refs = extractImageRefsFromText(text);
  if (!refs.length) return '';

  const cards = refs.map((it, idx) => {
    const entry = resolveInlineImageEntry(it.ref, inlineImages);
    if (!entry || !entry.url) return '';
    const safe = safeUrl(entry.url);
    if (!safe) return '';
    const status = entry.error
      ? esc(entry.error)
      : (entry.uploading ? `מעלה תמונה... ${entry.progress}%` : 'הועלה');
    const cls = entry.error ? 'error' : (entry.uploading ? '' : 'ok');
    const qArg = qi === null || qi === undefined ? 'null' : qi;
    const sArg = si === null || si === undefined ? 'null' : si;
    return `<div class="pq-inline-image-card">
      <button type="button" class="pq-inline-image-remove" onclick="removeInlineImageToken(${qArg},${sArg},'${esc(it.ref).replace(/'/g, '&#39;')}')" title="הסר תמונה">✕</button>
      <img class="pq-inline-image-thumb" src="${safe}" alt="${esc(it.alt || 'image')}" loading="lazy" referrerpolicy="no-referrer">
      <div class="pq-inline-image-meta">${esc(it.ref)}</div>
      <div id="${idPrefix}-img-${idx}" class="pq-inline-image-status ${cls}">${status}</div>
    </div>`;
  }).join('');

  if (!cards) return '';
  return `<div class="pq-inline-image-grid">${cards}</div>`;
}

function migrateLegacyImageToInlineText(entity, alt = 'image') {
  if (!entity || typeof entity !== 'object') return entity;

  const legacyUrl = normalizeHttpUrl(entity.imageUrl || '');
  entity.inlineImages = normalizeInlineImagesMap(entity.inlineImages);

  if (legacyUrl) {
    let existingKey = '';
    for (const [k, v] of Object.entries(entity.inlineImages)) {
      const url = typeof v === 'string' ? v : (v?.url || '');
      if (normalizeHttpUrl(url) === legacyUrl) {
        existingKey = k;
        break;
      }
    }

    const key = existingKey || `imglegacy${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    if (!existingKey) entity.inlineImages[key] = legacyUrl;

    const token = `![${alt}](img:${key})`;
    const txt = String(entity.text || '');
    const hasToken = txt.includes(`img:${key}`) || txt.includes(`(${legacyUrl})`);
    if (!hasToken) {
      entity.text = txt.trim() ? `${txt.trim()}\n${token}` : token;
    }
  }

  // Keep editor source-of-truth in text + inlineImages.
  delete entity.imageUrl;
  delete entity.imageAlign;
  delete entity.imageStoragePath;
  return entity;
}

async function pasteImageIntoQuestionText(e, qi) {
  const file = extractImageFileFromPasteEvent(e);
  if (!file) return;
  e.preventDefault();

  const q = parsedQuestions[qi];
  if (!q) return;
  q.id = q.id || genId();
  const ta = e.target;
  await insertImageFileIntoEntity(
    file,
    q,
    ta,
    '✅ תמונה הודבקה לטקסט השאלה',
    () => {
      const owner = adminUser?.uid || 'admin';
      const draftExamId = _editingExamId || `draft-${owner}`;
      return `question-images/${draftExamId}/q-${q.id}-${Date.now()}-${sanitizeStorageFileName(file.name)}`;
    },
    () => renderPreview()
  );
}

async function pasteImageIntoSubText(e, qi, si) {
  const file = extractImageFileFromPasteEvent(e);
  if (!file) return;
  e.preventDefault();

  const q = parsedQuestions[qi];
  const s = q?.subs?.[si];
  if (!q || !s) return;
  q.id = q.id || genId();
  s.id = s.id || genId();
  const ta = e.target;
  await insertImageFileIntoEntity(
    file,
    s,
    ta,
    '✅ תמונה הודבקה לטקסט הסעיף',
    () => {
      const owner = adminUser?.uid || 'admin';
      const draftExamId = _editingExamId || `draft-${owner}`;
      return `question-images/${draftExamId}/q-${q.id}/s-${s.id}-${Date.now()}-${sanitizeStorageFileName(file.name)}`;
    },
    () => renderPreview()
  );
}

function allowImageDrop(e) {
  e.preventDefault();
  setDropActive(e.currentTarget, true);
}

function clearImageDropState(e) {
  setDropActive(e.currentTarget, false);
}

async function dropImageIntoQuestionText(e, qi) {
  e.preventDefault();
  setDropActive(e.currentTarget, false);
  const file = getImageFileFromDropEvent(e);
  if (!file) return;
  const q = parsedQuestions[qi];
  if (!q) return;
  q.id = q.id || genId();
  await insertImageFileIntoEntity(
    file,
    q,
    e.currentTarget,
    '✅ תמונה נוספה לשאלה',
    () => {
      const owner = adminUser?.uid || 'admin';
      const draftExamId = _editingExamId || `draft-${owner}`;
      return `question-images/${draftExamId}/q-${q.id}-${Date.now()}-${sanitizeStorageFileName(file.name)}`;
    },
    () => renderPreview()
  );
}

async function dropImageIntoSubText(e, qi, si) {
  e.preventDefault();
  setDropActive(e.currentTarget, false);
  const file = getImageFileFromDropEvent(e);
  if (!file) return;
  const q = parsedQuestions[qi];
  const s = q?.subs?.[si];
  if (!q || !s) return;
  q.id = q.id || genId();
  s.id = s.id || genId();
  await insertImageFileIntoEntity(
    file,
    s,
    e.currentTarget,
    '✅ תמונה נוספה לסעיף',
    () => {
      const owner = adminUser?.uid || 'admin';
      const draftExamId = _editingExamId || `draft-${owner}`;
      return `question-images/${draftExamId}/q-${q.id}/s-${s.id}-${Date.now()}-${sanitizeStorageFileName(file.name)}`;
    },
    () => renderPreview()
  );
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
    const result = await processWithClaude(raw, {
      titleHint,
      courseId: document.getElementById('ae-course')?.value || '',
    });
    const questions = result.questions || result; // backward compat

    setProgress(100);
    parsedQuestions = Array.isArray(questions) ? questions : [];
    _lastParseQuality = computeParseQuality({ questions: parsedQuestions, metadata: result.metadata || null }, {
      titleHint,
      filenameHint: titleHint,
    });
    if (result.metadata) applyExamMetadata(result.metadata);
    if (statusEl) {
      const suffix = _lastParseQuality.needsManualReview
        ? ` | ⚠️ איכות ${_lastParseQuality.score}/100`
        : '';
      statusEl.textContent = `✅ זוהו ${parsedQuestions.length} שאלות${suffix}`;
    }

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
          <label class="bonus-chk-label" title="אפשר יצירת שאלת AI">
            <input type="checkbox" ${q.allowAIGen === true ? 'checked' : ''}
              onchange="toggleAIGen(${i}, this.checked)"> ✨ AI
          </label>
          ${!q.text?.trim() && !q._showIntro ? `<button class="btn btn-sm btn-secondary" onclick="addIntroToPreview(${i})">+ הקדמה</button>` : ''}
          <button class="btn btn-sm btn-secondary" onclick="addSubToPreview(${i})">+ סעיף</button>
          <button class="btn btn-sm" id="vbtn-${q.id}" style="background:rgba(239,68,68,.1);color:#dc2626;border-color:rgba(239,68,68,.3);padding:.28rem .38rem" onclick="openVideoAttachAdminModal('${q.id}','שאלה ${q.index||i+1}')" title="צרף סרטון פתרון"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="14" height="14" rx="2.5" ry="2.5"/><polygon points="16 8 22 12 16 16"/></svg></button>
          <button class="btn btn-sm btn-danger" onclick="removeQuestion(${i})">🗑️</button>
        </div>
      </div>
      ${(q._showIntro || (q.text && q.text.trim()))
        ? `<div style="font-size:.78rem;color:var(--muted);margin:.6rem 1.1rem .2rem;font-weight:600;display:flex;align-items:center;gap:.4rem">טקסט פתיחה (אופציונלי):
             <button class="btn-icon btn-sm btn-remove-intro" onclick="removeIntro(${i})" title="הסר הקדמה">✕</button></div>
           <textarea class="pq-textarea" id="qt-${i}" rows="2"
             oninput="updateQuestionText(${i},this.value)"
             onpaste="pasteImageIntoQuestionText(event,${i})"
             ondragover="allowImageDrop(event)"
             ondragleave="clearImageDropState(event)"
             ondrop="dropImageIntoQuestionText(event,${i})">${esc(q.text)}</textarea>
           <div id="q-inline-preview-${i}">${renderEditorInlineImagePreview(q.text, q.inlineImages, `q-${i}`, i, null)}</div>`
        : `<input type="hidden" id="qt-${i}" value="">`}
      ${q.subs.length ? renderSubsPreview(q.subs, i) : `
        <div style="font-size:.78rem;color:var(--muted);margin:.6rem 1.1rem .2rem;font-weight:600">תוכן השאלה:</div>
        <textarea class="pq-textarea" id="qbody-${i}" rows="4"
          oninput="updateQuestionText(${i},this.value)"
          onpaste="pasteImageIntoQuestionText(event,${i})"
          ondragover="allowImageDrop(event)"
          ondragleave="clearImageDropState(event)"
          ondrop="dropImageIntoQuestionText(event,${i})"
          placeholder="טקסט השאלה כאן...">${esc(q.text)}</textarea>
        <div id="qb-inline-preview-${i}">${renderEditorInlineImagePreview(q.text, q.inlineImages, `qb-${i}`, i, null)}</div>`}
    </div>`).join('');

  _refreshAdminVideoButtons();
  if (window.MathJax) MathJax.typesetPromise([grid]);
}

function ensureBody(qi, val) { parsedQuestions[qi].text = val; }

function hasPendingImageUploads() {
  return parsedQuestions.some(q => {
    const qMap = normalizeInlineImagesMap(q.inlineImages);
    const qUploading = Object.values(qMap).some(v => typeof v === 'object' && v?.uploading === true);
    if (qUploading) return true;
    return (q.subs || []).some(s => {
      const sMap = normalizeInlineImagesMap(s.inlineImages);
      return Object.values(sMap).some(v => typeof v === 'object' && v?.uploading === true);
    });
  });
}

function renderSubsPreview(subs, qi) {
  const heLetters = ['א','ב','ג','ד','ה','ו','ז','ח','ט','י','כ','ל'];
  return `<div class="sub-preview" id="static-subs-${qi}">
    <div style="font-size:.78rem;color:var(--muted);margin:.55rem 1.1rem .3rem;font-weight:600">סעיפים:</div>
    ${subs.map((s, si) => `
    <div class="sub-preview-item${s.isBonus ? ' pq-bonus' : ''}" style="margin:0 1.1rem .5rem">
      <div class="sub-preview-top">
        <span class="sub-preview-lbl">${s.isBonus ? '⭐ ' : ''}${esc(s.label || ('(' + (heLetters[si] || si + 1) + ')'))}</span>
        <div class="sub-preview-actions">
          <label class="bonus-chk-label" style="font-size:.72rem;white-space:nowrap" title="סמן סעיף כבונוס">
            <input type="checkbox" ${s.isBonus === true ? 'checked' : ''}
              onchange="toggleSubBonus(${qi},${si},this.checked)"> בונוס
          </label>
          <label class="bonus-chk-label" style="font-size:.72rem;white-space:nowrap" title="אפשר יצירת AI לסעיף זה">
            <input type="checkbox" ${s.allowAIGen === true ? 'checked' : ''}
              onchange="parsedQuestions[${qi}].subs[${si}].allowAIGen=this.checked"> ✨
          </label>
          <button class="btn-icon btn-sm" id="vbtn-${s.id}" style="background:rgba(239,68,68,.1);color:#dc2626;border:1px solid rgba(239,68,68,.3);padding:.28rem .38rem" onclick="openVideoAttachAdminModal('${s.id}','${esc(s.label||'סעיף '+(si+1))}')" title="צרף סרטון"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="14" height="14" rx="2.5" ry="2.5"/><polygon points="16 8 22 12 16 16"/></svg></button>
          <button class="btn-icon btn-sm" style="background:var(--danger-l);color:var(--danger);flex-shrink:0"
            onclick="removeSub(${qi},${si})" title="מחק סעיף">✕</button>
        </div>
      </div>
      <textarea class="pq-textarea sub-pq-textarea" id="st-${qi}-${si}"
        oninput="updateSubText(${qi},${si},this.value)"
        onpaste="pasteImageIntoSubText(event,${qi},${si})"
        ondragover="allowImageDrop(event)"
        ondragleave="clearImageDropState(event)"
        ondrop="dropImageIntoSubText(event,${qi},${si})">${esc(s.text)}</textarea>
      <div id="s-inline-preview-${qi}-${si}">${renderEditorInlineImagePreview(s.text, s.inlineImages, `s-${qi}-${si}`, qi, si)}</div>
    </div>`).join('')}
  </div>`;
}

function addSubToPreview(qi) {
  const heLetters = ['א','ב','ג','ד','ה','ו','ז','ח','ט','י','כ','ל'];
  const n = parsedQuestions[qi].subs.length;
  parsedQuestions[qi].subs.push({
    id: genId(),
    label: '(' + (heLetters[n] || String(n + 1)) + ')',
    text: '',
    inlineImages: {},
  });
  renderPreview();
  setTimeout(() => document.getElementById(`pqc-${qi}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
}

function addIntroToPreview(qi) {
  parsedQuestions[qi]._showIntro = true;
  renderPreview();
  setTimeout(() => {
    const ta = document.getElementById(`qt-${qi}`);
    if (ta) { ta.focus(); }
  }, 50);
}

function removeIntro(qi) {
  parsedQuestions[qi].text = '';
  delete parsedQuestions[qi]._showIntro;
  renderPreview();
}

function removeSub(qi, si)  { parsedQuestions[qi].subs.splice(si, 1); renderPreview(); }
function removeQuestion(i)  { parsedQuestions.splice(i, 1); renderPreview(); }

function toggleSubBonus(qi, si, checked) {
  if (!parsedQuestions[qi]?.subs?.[si]) return;
  parsedQuestions[qi].subs[si].isBonus = checked === true;
  renderPreview();
}
window.toggleSubBonus = toggleSubBonus;

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

function toggleAIGen(i, checked) {
  parsedQuestions[i].allowAIGen = checked;
}

function clearImport() {
  const rt = document.getElementById('raw-text');
  if (rt) rt.value = '';
  parsedQuestions = [];
  _lastParseQuality = null;
  const c = document.getElementById('preview-container');
  if (c) c.style.display = 'none';
  setProgress(0);
}

/* Add an empty question manually (no PDF / no text needed) */
function addManualQuestion() {
  const newIndex = parsedQuestions.length + 1;
  parsedQuestions.push({
    id: genId(),
    index: newIndex,
    text: '',
    isBonus: false,
    subs: [],
    inlineImages: {},
  });
  renderPreview();
  setTimeout(() => {
    const i = parsedQuestions.length - 1;
    const card = document.getElementById('pqc-' + i);
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const ta = document.getElementById('qbody-' + i);
    if (ta) ta.focus();
  }, 60);
  toast('נוספה שאלה ריקה — מלא את התוכן', 'success');
}
window.addManualQuestion = addManualQuestion;

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

  // Sync textarea edits back.
  // Note: when a question has no intro and no subs, the template renders a
  // hidden input `qt-${i}` (always empty) and the actual text lives in the
  // `qbody-${i}` textarea. Prefer the visible textarea over the hidden input
  // so we don't wipe out manually-typed content.
  parsedQuestions.forEach((q, i) => {
    const body = document.getElementById(`qbody-${i}`);
    if (body && body.tagName === 'TEXTAREA') {
      q.text = body.value;
    } else {
      const ta = document.getElementById(`qt-${i}`);
      if (ta && ta.tagName === 'TEXTAREA') q.text = ta.value;
    }
    q.subs.forEach((s, si) => {
      const sta = document.getElementById(`st-${i}-${si}`);
      if (sta) s.text = sta.value;
    });
  });

  if (!parsedQuestions.length) {
    const raw = document.getElementById('raw-text')?.value || '';
    if (raw.trim()) parsedQuestions = parseExamText(raw);
  }

  if (hasPendingImageUploads()) {
    toast('יש העלאות תמונה בתהליך. המתן לסיום לפני שמירה.', 'error');
    return;
  }

  const questions = parsedQuestions.filter(q => {
    const subs = q.subs || [];
    const hasSubContent = subs.some(s => String(s.text || '').trim());
    return String(q.text || '').trim() || hasSubContent;
  });
  if (!questions.length && !confirm('לא זוהו שאלות. לשמור מבחן ריק?')) return;

  const currentQuality = _lastParseQuality || computeParseQuality({
    questions,
    metadata: {
      year: year ? parseInt(year) : null,
      semester: sem || null,
      moed: moed || null,
      lecturers,
    }
  }, {
    titleHint: title,
    filenameHint: title,
  });

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

    // ── Upload Solution PDF if one was selected ──────────────────
    let solutionPdfUrl = document.getElementById('ae-sol-url')?.value || null;
    if (_solPdfFile) {
      showSpinner('📤 מעלה פתרון...');
      try {
        solutionPdfUrl = await uploadSolPdf(examId);
        toast('✅ פתרון הועלה בהצלחה', 'success');
      } catch (solErr) {
        console.error('Solution PDF upload failed:', solErr);
        const goAhead = confirm(`העלאת הפתרון נכשלה:\n${solErr.message}\n\nהאם לשמור את המבחן ללא פתרון?`);
        if (!goAhead) {
          if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '💾 שמור מבחן'; }
          hideSpinner();
          return;
        }
        solutionPdfUrl = null;
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
      assignedLecturers: _assignedLecturers.map(a => a.uid),
      hiddenFromStudents: _editingExamId ? (_editingExamHidden === true) : false,
      pdfUrl:    pdfUrl || null,
      solutionPdfUrl: solutionPdfUrl || null,
      parsedModel: _parsedModel || null,
      parseQualityScore: currentQuality.score,
      parseConfidence: currentQuality.confidence,
      parseFlags: currentQuality.flags,
      needsManualReview: currentQuality.needsManualReview,
      verified:  false,
      questions: questions.map(q => ({
        id:      q.id || genId(),
        text:    q.text,
        inlineImages: Object.fromEntries(
          Object.entries(filterInlineImagesForText(q.text, q.inlineImages)).map(([k, v]) => {
            const url = typeof v === 'string' ? normalizeHttpUrl(v) : normalizeHttpUrl(v?.url || '');
            return [k, url || ''];
          }).filter(([, url]) => !!url)
        ),
        isBonus: q.isBonus === true,
        allowAIGen: q.allowAIGen === true,
        subs:    (q.subs || []).map(s => ({
          id:    s.id || genId(),
          label: s.label,
          text:  s.text,
          inlineImages: Object.fromEntries(
            Object.entries(filterInlineImagesForText(s.text, s.inlineImages)).map(([k, v]) => {
              const url = typeof v === 'string' ? normalizeHttpUrl(v) : normalizeHttpUrl(v?.url || '');
              return [k, url || ''];
            }).filter(([, url]) => !!url)
          ),
          allowAIGen: s.allowAIGen === true,
          isBonus: s.isBonus === true,
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
    console.log('[submitAddExam] saving with assignedLecturers=', exam.assignedLecturers, 'hiddenFromStudents=', exam.hiddenFromStudents);
    await db.collection('exams').doc(examId).set(exam);

    if (_editingExamId && _loadedExamImageUrls.size) {
      const newUrls = collectPersistedInlineImageUrls(exam);
      const removed = [..._loadedExamImageUrls].filter(url => !newUrls.has(url));
      for (const url of removed) {
        _pendingImageDeletes.delete(url); // avoid double-delete
        await deleteStorageFileByUrl(url);
      }
      _loadedExamImageUrls = newUrls;
    }
    // Delete images that were uploaded this session but removed before saving.
    for (const url of _pendingImageDeletes) {
      await deleteStorageFileByUrl(url);
    }
    _pendingImageDeletes.clear();

    // Save a curated example for few-shot prompting; low-confidence stays unapproved.
    try {
      await saveParseExample(exam, {
        approved: !currentQuality.needsManualReview,
        quality: currentQuality,
        source: 'single',
        filenameHint: title,
      });
    } catch (exErr) {
      console.warn('Could not save approved parse example:', exErr.message);
    }
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
  _clearAssignedLecturers();
  clearExamPdf();
  clearSolPdf();
  parsedQuestions = [];
  _editingExamId  = null;
  _editingExamHidden = false;
  _parsedModel    = null;
  _loadedExamImageUrls = new Set();
  _pendingImageDeletes  = new Set();
  _lastParseQuality = null;
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

    // Build map of duplicate doc IDs per kept row, so deletion can sweep ghosts too
    const dupIdsByKept = new Map(); // keptDocId -> [otherDocIds]
    for (const kept of rows) {
      const email = (kept.email || '').toLowerCase().trim();
      if (!email) { dupIdsByKept.set(kept._docId, []); continue; }
      const others = allDocs
        .filter(d => (d.email || '').toLowerCase().trim() === email && d._docId !== kept._docId)
        .map(d => d._docId);
      dupIdsByKept.set(kept._docId, others);
    }

    // ── Sort options ──────────────────────────────────────────
    // Default: email alphabetical (already sorted above)
    // Build table HTML
    const tableRows = rows.map((u, idx) => {
      const starred    = (u.starredQuestions || []).length;
      const done       = (u.completedExams || u.doneExams || []).length;
      const inProgress = (u.inProgressExams || []).length;
      const copies     = u.copyCount || 0;
      const accepted   = u.acceptedTerms === true;
      const aiCount    = (u.aiQuestions || []).length;
      // analyticsConsent: true = consented, false = opted out, undefined = never shown
      const consent    = u.analyticsConsent;
      const canViewLog = consent === true;
      const uid        = u.uid || u._docId || '';

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

      // 3-state consent badge + last change timestamp from audit log
      const auditLog   = u.consentAuditLog || [];
      const lastEntry  = auditLog.length ? auditLog[auditLog.length - 1] : null;
      const lastChange = lastEntry?.at
        ? new Date(lastEntry.at).toLocaleDateString('he-IL', { day:'2-digit', month:'2-digit', year:'2-digit' })
        : null;
      const consentBadge = (consent === true
        ? `<span class="consent-badge consent-badge-yes">✓ מאושר</span>`
        : consent === false
          ? `<span class="consent-badge consent-badge-no">✗ לא</span>`
          : `<span class="consent-badge consent-badge-pending">⏳ טרם</span>`)
        + (lastChange ? `<br><span style="font-size:.68rem;color:var(--muted)">${lastChange}</span>` : '');

      // Activity log button — disabled if no consent
      const logBtn = canViewLog
        ? `<button class="btn btn-sm" onclick="openActivityLogModal('${esc(uid)}','${esc(u.email || '')}')" style="padding:.2rem .5rem;font-size:.8rem">📋</button>`
        : `<button class="btn btn-sm" disabled title="המשתמש לא הסכים למעקב" style="padding:.2rem .5rem;font-size:.8rem;opacity:.35;cursor:not-allowed">📋</button>`;

      // Role dropdown — admin can promote/demote between student/instructor/admin
      const currentRole = u.role || 'student';
      const docId       = u._docId || uid;
      const dupIds      = (dupIdsByKept.get(u._docId) || []).join(',');
      const deleteBtn   = `<button class="btn btn-sm" onclick="deleteUserDoc('${esc(uid)}','${esc(u.email || '')}','${esc(docId)}','${esc(u.email || u.uid || u._docId || '')}','${esc(dupIds)}')" title="מחק משתמש (Firestore + Auth)" style="padding:.2rem .5rem;font-size:.8rem;background:#fef2f2;color:#991b1b;border:1px solid #fca5a5">🗑️</button>`;
      const roleSelect = `
        <select onchange="updateUserRole('${esc(docId)}', this.value, this)"
                data-prev="${esc(currentRole)}"
                style="font-size:.75rem;padding:.15rem .3rem;border:1px solid #cbd5e1;
                       border-radius:5px;background:#fff;cursor:pointer">
          <option value="student"    ${currentRole==='student'    ? 'selected':''}>סטודנט</option>
          <option value="instructor" ${currentRole==='instructor' ? 'selected':''}>מרצה</option>
          <option value="admin"      ${currentRole==='admin'      ? 'selected':''}>אדמין</option>
        </select>`;

      // Consent value as a stable token for filtering
      const consentTok = consent === true ? 'yes' : (consent === false ? 'no' : 'pending');

      return `<tr class="user-row" style="transition:background .15s"
        data-email="${esc((u.email || '').toLowerCase())}"
        data-name="${esc((u.displayName || '').toLowerCase())}"
        data-uid="${esc((u.uid || u._docId || '').toLowerCase())}"
        data-role="${esc(currentRole)}"
        data-consent="${consentTok}"
        data-accepted="${accepted ? 'yes' : 'no'}"
        data-copies="${copies}"
        data-done="${done}"
        data-progress="${inProgress}"
        data-starred="${starred}"
        data-ai="${aiCount}"
        onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background=''">
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
        <td style="text-align:center">${consentBadge}</td>
        <td style="text-align:center">
          ${aiCount > 0
            ? `<span class="badge" style="background:#f5f3ff;color:#5b21b6;border:1px solid #c4b5fd;font-weight:600">🤖 ${aiCount}</span>`
            : `<span style="color:var(--light);font-size:.8rem">0</span>`}
        </td>
        <td style="text-align:center">${logBtn}</td>
      </tr>`;
    }).join('');

    // ── Summary stats bar ─────────────────────────────────────
    const totalCopies     = rows.reduce((s, u) => s + (u.copyCount || 0), 0);
    const totalDone       = rows.reduce((s, u) => s + (u.completedExams || u.doneExams || []).length, 0);
    const totalInProgress = rows.reduce((s, u) => s + (u.inProgressExams || []).length, 0);
    const totalStarred    = rows.reduce((s, u) => s + (u.starredQuestions || []).length, 0);
    const totalAccepted   = rows.filter(u => u.acceptedTerms === true).length;
    const totalConsented  = rows.filter(u => u.analyticsConsent === true).length;

    wrap.innerHTML = `
      <!-- Summary stats -->
      <div style="display:flex;gap:.75rem;flex-wrap:wrap;margin-bottom:1.2rem">
        ${[
          ['📋', 'העתקות סה"כ',    totalCopies,     '#eff6ff','#1d4ed8','#bfdbfe'],
          ['✅', 'מבחנים שהושלמו', totalDone,        '#f0fdf4','#166534','#86efac'],
          ['⏳', 'בתהליך סה"כ',    totalInProgress,  '#fefce8','#854d0e','#fde047'],
          ['⭐', 'כוכביות סה"כ',   totalStarred,     '#fff7ed','#9a3412','#fdba74'],
          ['📜', 'אישרו תנאים',    `${totalAccepted}/${rows.length}`, '#f5f3ff','#5b21b6','#c4b5fd'],
          ['🔬', 'הסכמה למעקב',   `${totalConsented}/${rows.length}`, '#ecfdf5','#065f46','#6ee7b7'],
        ].map(([icon, lbl, val, bg, fg, border]) => `
          <div style="flex:1;min-width:110px;background:${bg};border:1px solid ${border};
                      border-radius:10px;padding:.65rem .9rem;text-align:center">
            <div style="font-size:1.1rem;font-weight:700;color:${fg}">${icon} ${val}</div>
            <div style="font-size:.72rem;color:${fg};opacity:.8;margin-top:.15rem">${lbl}</div>
          </div>`).join('')}
      </div>

      <!-- Filter bar -->
      <div id="users-filter-bar" style="display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;
           background:#fff;border:1px solid var(--border);border-radius:10px;padding:.6rem .8rem;margin-bottom:.8rem">
        <input id="uf-search" type="search" placeholder="🔍 חיפוש לפי אימייל / שם / UID"
          oninput="_applyUsersFilter()"
          style="flex:1;min-width:220px;font-size:.82rem;padding:.35rem .55rem;border:1px solid #cbd5e1;border-radius:6px">
        <select id="uf-role" onchange="_applyUsersFilter()"
          style="font-size:.78rem;padding:.3rem .45rem;border:1px solid #cbd5e1;border-radius:6px;background:#fff;cursor:pointer">
          <option value="">תפקיד: הכול</option>
          <option value="student">סטודנט</option>
          <option value="instructor">מרצה</option>
          <option value="admin">אדמין</option>
        </select>
        <select id="uf-consent" onchange="_applyUsersFilter()"
          style="font-size:.78rem;padding:.3rem .45rem;border:1px solid #cbd5e1;border-radius:6px;background:#fff;cursor:pointer">
          <option value="">הסכמה: הכול</option>
          <option value="yes">✓ אישר</option>
          <option value="no">✗ לא</option>
          <option value="pending">⏳ טרם</option>
        </select>
        <select id="uf-accepted" onchange="_applyUsersFilter()"
          style="font-size:.78rem;padding:.3rem .45rem;border:1px solid #cbd5e1;border-radius:6px;background:#fff;cursor:pointer">
          <option value="">תנאים: הכול</option>
          <option value="yes">✓ אישר</option>
          <option value="no">✗ טרם</option>
        </select>
        <select id="uf-activity" onchange="_applyUsersFilter()"
          style="font-size:.78rem;padding:.3rem .45rem;border:1px solid #cbd5e1;border-radius:6px;background:#fff;cursor:pointer"
          title="סנן לפי פעילות">
          <option value="">פעילות: הכול</option>
          <option value="copies">עם העתקות</option>
          <option value="done">עם מבחנים מושלמים</option>
          <option value="progress">עם מבחנים בתהליך</option>
          <option value="starred">עם כוכביות</option>
          <option value="ai">עם שאלות AI</option>
        </select>
        <button type="button" class="btn btn-sm btn-secondary"
          onclick="_resetUsersFilter()" style="padding:.3rem .65rem;font-size:.75rem">נקה מסננים</button>
        <span id="uf-count" style="font-size:.72rem;color:var(--muted);margin-right:auto"></span>
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
              <th style="text-align:center" title="הסכמה לשימוש בנתוני שימוש למחקר">🔬 הסכמה למעקב</th>
              <th style="text-align:center" title="שאלות AI שנשמרו על ידי המשתמש">🤖 שאלות AI</th>
              <th style="text-align:center" title="יומן פעילות">📋 יומן</th>
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
   ACTIVITY LOG MODAL
══════════════════════════════════════════════════════════ */

const EVENT_LABELS = {
  'session_start':         'התחלת סשן',
  'course_open':           'פתיחת קורס',
  'exam_open':             'פתיחת מבחן',
  'exam_filtered':         'סינון מבחנים',
  'pdf_download':          'הורדת PDF',
  'exam_status_changed':   'שינוי סטטוס מבחן',
  'star_toggled':          'סימון כוכבית',
  'difficulty_voted':      'הצבעת קושי',
  'question_copied':       'העתקת שאלה',
  'ai_question_generated': 'יצירת שאלת AI',
  'ai_question_saved':     'שמירת שאלת AI',
  'ai_question_copied':    'העתקת שאלת AI',
  'ai_question_rated':     'דירוג שאלת AI',
};

function _fmtPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const parts = [];
  if (payload.courseCode) parts.push(`קורס: ${esc(payload.courseCode)}`);
  if (payload.examId)     parts.push(`מבחן: ${esc(payload.examId)}`);
  if (payload.status)     parts.push(`סטטוס: ${esc(payload.status)}`);
  if (payload.level)      parts.push(`רמה: ${esc(payload.level)}`);
  if (payload.starred !== undefined) parts.push(payload.starred ? 'סומן' : 'הוסר');
  if (payload.fromCache !== undefined) parts.push(payload.fromCache ? 'מהמטמון' : 'מהמודל');
  if (payload.rating !== undefined) parts.push(`דירוג: ${payload.rating}`);
  return parts.join(' · ');
}

function _applyUsersFilter() {
  const q   = (document.getElementById('uf-search')?.value || '').trim().toLowerCase();
  const role = document.getElementById('uf-role')?.value || '';
  const consent = document.getElementById('uf-consent')?.value || '';
  const accepted = document.getElementById('uf-accepted')?.value || '';
  const activity = document.getElementById('uf-activity')?.value || '';
  const rows = document.querySelectorAll('tr.user-row');
  let visible = 0;
  rows.forEach(tr => {
    const ds = tr.dataset;
    let show = true;
    if (q) {
      const hay = (ds.email || '') + ' ' + (ds.name || '') + ' ' + (ds.uid || '');
      if (!hay.includes(q)) show = false;
    }
    if (show && role && ds.role !== role) show = false;
    if (show && consent && ds.consent !== consent) show = false;
    if (show && accepted && ds.accepted !== accepted) show = false;
    if (show && activity) {
      const map = { copies:'copies', done:'done', progress:'progress', starred:'starred', ai:'ai' };
      const key = map[activity];
      if (key && Number(ds[key] || 0) <= 0) show = false;
    }
    tr.style.display = show ? '' : 'none';
    if (show) visible++;
  });
  const cnt = document.getElementById('uf-count');
  if (cnt) cnt.textContent = `${visible} / ${rows.length} מוצגים`;
}

function _resetUsersFilter() {
  ['uf-search','uf-role','uf-consent','uf-accepted','uf-activity'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  _applyUsersFilter();
}

async function deleteUserDoc(uid, email, docId, label, dupIdsCsv) {
  const dupIds = (dupIdsCsv || '').split(',').map(s => s.trim()).filter(Boolean);
  const extraDocIds = [docId, ...dupIds].filter(Boolean);
  const total = extraDocIds.length;

  const msg = `למחוק לצמיתות את המשתמש "${label}"?\n\n` +
              `הפעולה תמחק:\n` +
              `· כל המסמכים של המשתמש ב-Firestore (${total} מסמך/ים כולל כפילויות)\n` +
              `· תת-קולקציות (ai_tasks, user_grades וכו')\n` +
              `· חשבון Firebase Authentication — המשתמש לא יוכל להתחבר עוד.\n\n` +
              `אם ירצה להשתמש שוב, יהיה עליו להירשם מחדש.\n\nלהמשיך?`;
  if (!confirm(msg)) return;
  if (!confirm(`אישור סופי: למחוק לצמיתות את "${label}"?`)) return;

  try {
    const idToken = await firebase.auth().currentUser?.getIdToken();
    if (!idToken) { alert('יש להתחבר מחדש'); return; }

    const res = await fetch('/.netlify/functions/delete-user', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`,
      },
      body: JSON.stringify({ uid: uid || '', email: email || '', extraDocIds }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    const parts = [];
    parts.push(`נמחקו ${data.firestoreDeleted || 0} מסמכי Firestore`);
    parts.push(data.authDeleted ? 'חשבון Auth נמחק' : 'חשבון Auth לא נמצא/לא נמחק');
    if (data.authError) parts.push(`⚠️ Auth: ${data.authError}`);
    if ((data.docDeleteErrors || []).length) parts.push(`⚠️ שגיאות ב-${data.docDeleteErrors.length} מסמכים`);
    toast?.(parts.join(' · '));
    renderUserStats();
  } catch (e) {
    console.error('deleteUserDoc error:', e);
    alert('שגיאה במחיקה: ' + (e.message || e));
  }
}

/* ============================================================
   ניהול משתמשים — slim management table
   ============================================================ */
async function renderManageUsers() {
  const wrap = document.getElementById('manage-users-table-wrap');
  if (!wrap) return;
  wrap.innerHTML = `<div style="text-align:center;padding:2rem"><div class="spinner" style="margin:0 auto"></div><p style="color:var(--muted);margin-top:.8rem;font-size:.85rem">טוען משתמשים...</p></div>`;

  try {
    const snap = await db.collection('users').get();
    if (snap.empty) {
      wrap.innerHTML = `<div style="text-align:center;padding:2rem;color:var(--light)">אין משתמשים במערכת</div>`;
      return;
    }
    const allDocs = snap.docs.map(d => ({ _docId: d.id, ...d.data() }));

    // Deduplicate by email — same logic as renderUserStats
    const scoreDoc = d =>
      (d.starredQuestions || []).length +
      (d.completedExams || d.doneExams || []).length * 2 +
      (d.copyCount || 0) / 10 +
      (d.acceptedTerms ? 5 : 0) +
      (d.displayName ? 3 : 0);
    const byEmail = new Map();
    const noEmail = [];
    for (const doc of allDocs) {
      const em = (doc.email || '').toLowerCase().trim();
      if (!em) {
        if (doc.uid || doc.displayName) noEmail.push(doc);
        continue;
      }
      if (!byEmail.has(em) || scoreDoc(doc) > scoreDoc(byEmail.get(em))) byEmail.set(em, doc);
    }
    const rows = [
      ...[...byEmail.values()].sort((a, b) => (a.email || '').localeCompare(b.email || '')),
      ...noEmail.sort((a, b) => (a.uid || a._docId || '').localeCompare(b.uid || b._docId || '')),
    ];

    // Map of duplicate IDs sharing email (for cascading deletion)
    const dupIdsByKept = new Map();
    for (const kept of rows) {
      const em = (kept.email || '').toLowerCase().trim();
      if (!em) { dupIdsByKept.set(kept._docId, []); continue; }
      dupIdsByKept.set(kept._docId, allDocs
        .filter(d => (d.email || '').toLowerCase().trim() === em && d._docId !== kept._docId)
        .map(d => d._docId));
    }

    const tableRows = rows.map(u => {
      const uid = u.uid || u._docId || '';
      const docId = u._docId || uid;
      const identifier = u.email || uid || '—';
      const isUid = !u.email;
      const emailCell = isUid
        ? `<span style="font-family:monospace;font-size:.72rem;color:var(--muted);background:#f1f5f9;padding:2px 5px;border-radius:4px;border:1px solid #e2e8f0" title="אין אימייל — מוצג UID">${esc(identifier)}</span>`
        : `<span style="font-weight:500">${esc(identifier)}</span>`;
      const accepted = u.acceptedTerms === true;
      const consent = u.analyticsConsent;
      const consentBadge = consent === true
        ? `<span class="consent-badge consent-badge-yes">✓ מאושר</span>`
        : consent === false
          ? `<span class="consent-badge consent-badge-no">✗ לא</span>`
          : `<span class="consent-badge consent-badge-pending">⏳ טרם</span>`;

      const currentRole = u.role || 'student';
      const dupIds = (dupIdsByKept.get(u._docId) || []).join(',');

      const roleSelect = `
        <select onchange="updateUserRole('${esc(docId)}', this.value, this)"
                data-prev="${esc(currentRole)}"
                style="font-size:.78rem;padding:.2rem .35rem;border:1px solid #cbd5e1;border-radius:5px;background:#fff;cursor:pointer">
          <option value="student"    ${currentRole==='student'    ? 'selected':''}>סטודנט</option>
          <option value="instructor" ${currentRole==='instructor' ? 'selected':''}>מרצה</option>
          <option value="admin"      ${currentRole==='admin'      ? 'selected':''}>אדמין</option>
        </select>`;

      const deleteBtn = `<button class="btn btn-sm" onclick="deleteUserDoc('${esc(uid)}','${esc(u.email || '')}','${esc(docId)}','${esc(u.email || uid || docId)}','${esc(dupIds)}')" title="מחק משתמש (Firestore + Auth)" style="padding:.25rem .55rem;font-size:.85rem;background:#fef2f2;color:#991b1b;border:1px solid #fca5a5">🗑️</button>`;

      const resetBtn = (u.email || uid)
        ? `<button class="btn btn-sm" onclick="forcePasswordReset('${esc(u.email || '')}','${esc(uid)}')" title="כפה החלפת סיסמה בכניסה הבאה" style="padding:.25rem .55rem;font-size:.85rem;background:#fff7ed;color:#9a3412;border:1px solid #fdba74">🔑</button>`
        : `<button class="btn btn-sm" disabled title="חסר מזהה משתמש" style="padding:.25rem .55rem;font-size:.85rem;opacity:.35;cursor:not-allowed">🔑</button>`;

      return `<tr class="mu-row" style="transition:background .15s"
        data-search="${esc(((u.email || '') + ' ' + (uid || '')).toLowerCase())}"
        data-role="${esc(currentRole)}"
        onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background=''">
        <td style="font-size:.85rem">${emailCell}<br><span style="font-family:monospace;font-size:.7rem;color:var(--muted)">${esc(uid)}</span></td>
        <td style="text-align:center">
          ${accepted
            ? `<span class="badge" style="background:#dcfce7;color:#166534;border:1px solid #86efac">✓ אישר</span>`
            : `<span class="badge" style="background:#fef2f2;color:#991b1b;border:1px solid #fca5a5">✗ טרם</span>`}
        </td>
        <td style="text-align:center">${consentBadge}</td>
        <td style="text-align:center">${roleSelect}</td>
        <td style="text-align:center">${resetBtn}</td>
        <td style="text-align:center">${deleteBtn}</td>
      </tr>`;
    }).join('');

    wrap.innerHTML = `
      <!-- Filter bar -->
      <div style="display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;background:#fff;border:1px solid var(--border);border-radius:10px;padding:.6rem .8rem;margin-bottom:.8rem">
        <input id="mu-search" type="search" placeholder="🔍 חיפוש לפי אימייל / UID"
          oninput="_applyManageUsersFilter()"
          style="flex:1;min-width:220px;font-size:.82rem;padding:.35rem .55rem;border:1px solid #cbd5e1;border-radius:6px">
        <select id="mu-role" onchange="_applyManageUsersFilter()"
          style="font-size:.78rem;padding:.3rem .45rem;border:1px solid #cbd5e1;border-radius:6px;background:#fff;cursor:pointer">
          <option value="">תפקיד: הכול</option>
          <option value="student">סטודנט</option>
          <option value="instructor">מרצה</option>
          <option value="admin">אדמין</option>
        </select>
        <span id="mu-count" style="font-size:.72rem;color:var(--muted);margin-right:auto"></span>
      </div>

      <div style="overflow-x:auto">
        <table class="tbl" style="min-width:560px">
          <thead>
            <tr>
              <th>אימייל / UID</th>
              <th style="text-align:center">📜 הצהרה</th>
              <th style="text-align:center">🔬 הסכמה למעקב</th>
              <th style="text-align:center">👤 תפקיד</th>
              <th style="text-align:center" title="כפה איפוס סיסמה">🔑 איפוס סיסמה</th>
              <th style="text-align:center" title="מחק משתמש לצמיתות">🗑️ מחיקה</th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>
        <p style="font-size:.75rem;color:var(--light);margin-top:.6rem">
          ${rows.length} משתמשים · עודכן ${new Date().toLocaleTimeString('he-IL')}
        </p>
      </div>`;

    _applyManageUsersFilter();
  } catch (e) {
    wrap.innerHTML = `<div class="form-error show">שגיאה בטעינת משתמשים: ${esc(e.message)}</div>`;
    console.error('renderManageUsers error:', e);
  }
}

function _applyManageUsersFilter() {
  const q = (document.getElementById('mu-search')?.value || '').trim().toLowerCase();
  const role = document.getElementById('mu-role')?.value || '';
  const rows = document.querySelectorAll('tr.mu-row');
  let visible = 0;
  rows.forEach(tr => {
    let show = true;
    if (q && !(tr.dataset.search || '').includes(q)) show = false;
    if (show && role && tr.dataset.role !== role) show = false;
    tr.style.display = show ? '' : 'none';
    if (show) visible++;
  });
  const cnt = document.getElementById('mu-count');
  if (cnt) cnt.textContent = `${visible} / ${rows.length} מוצגים`;
}

async function forcePasswordReset(email, uid) {
  if (!email && !uid) { alert('חסר מזהה משתמש'); return; }
  const label = email || uid;
  const msg = `לכפות איפוס סיסמה עבור ${label}?\n\n` +
              `· כל הסשנים הפעילים של המשתמש יבוטלו.\n` +
              `· בכניסה הבאה, המשתמש ייאלץ להגדיר סיסמה חדשה לפני שיוכל להמשיך.\n` +
              `· לא יישלח מייל.\n\n` +
              `להמשיך?`;
  if (!confirm(msg)) return;

  try {
    const idToken = await firebase.auth().currentUser?.getIdToken();
    if (!idToken) { alert('יש להתחבר מחדש'); return; }

    const res = await fetch('/.netlify/functions/force-password-reset', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`,
      },
      body: JSON.stringify({ email: email || '', uid: uid || '' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    toast?.('המשתמש יידרש להגדיר סיסמה חדשה בכניסה הבאה');
  } catch (e) {
    console.error('forcePasswordReset error:', e);
    alert('שגיאה באיפוס: ' + (e.message || e));
  }
}

async function updateUserRole(docId, newRole, selectEl) {
  const allowed = ['student', 'instructor', 'admin'];
  if (!allowed.includes(newRole)) return;
  const prev = selectEl?.dataset?.prev || 'student';
  if (newRole === prev) return;

  const labels = { student: 'סטודנט', instructor: 'מרצה', admin: 'אדמין' };
  if (!confirm(`לשנות תפקיד ל-${labels[newRole]}?`)) {
    if (selectEl) selectEl.value = prev;
    return;
  }

  const wasDisabled = selectEl?.disabled;
  if (selectEl) selectEl.disabled = true;
  try {
    await db.collection('users').doc(docId).update({ role: newRole });
    if (selectEl) selectEl.dataset.prev = newRole;
    toast?.(`התפקיד עודכן ל-${labels[newRole]}`);
  } catch (e) {
    console.error('updateUserRole error:', e);
    alert('שגיאה בעדכון התפקיד: ' + (e.message || e));
    if (selectEl) selectEl.value = prev;
  } finally {
    if (selectEl) selectEl.disabled = !!wasDisabled;
  }
}

async function openActivityLogModal(uid, email) {
  const existing = document.getElementById('activity-log-modal');
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.id = 'activity-log-modal';
  overlay.className = 'admin-modal-overlay';
  overlay.innerHTML = `
    <div class="admin-modal" role="dialog" aria-modal="true">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
        <div>
          <h3 style="margin:0;font-size:1rem;font-weight:700">📋 יומן פעילות</h3>
          <p style="margin:.2rem 0 0;font-size:.78rem;color:var(--muted)">${esc(email || uid)}</p>
        </div>
        <button onclick="document.getElementById('activity-log-modal').remove()"
          style="background:none;border:none;font-size:1.3rem;cursor:pointer;color:var(--muted);line-height:1"
          aria-label="סגור">×</button>
      </div>
      <div id="activity-log-body" style="text-align:center;padding:1.5rem">
        <div class="spinner" style="margin:0 auto"></div>
        <p style="color:var(--muted);font-size:.83rem;margin-top:.6rem">טוען אירועים...</p>
      </div>
    </div>`;

  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);

  const body = document.getElementById('activity-log-body');
  try {
    const snap = await db.collection('analytics_events')
      .where('uid', '==', uid)
      .orderBy('timestamp', 'desc')
      .limit(20)
      .get();

    if (snap.empty) {
      body.innerHTML = `<p style="color:var(--muted);font-size:.85rem;text-align:center">אין אירועים רשומים עבור משתמש זה</p>`;
      return;
    }

    const rows = snap.docs.map(doc => {
      const d = doc.data();
      const label   = EVENT_LABELS[d.event] || esc(d.event);
      const ts      = d.timestamp?.toDate
        ? d.timestamp.toDate().toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' })
        : '—';
      const details = _fmtPayload(d.payload);
      return `<div class="activity-row">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:.5rem">
          <span style="font-weight:600;font-size:.85rem">${label}</span>
          <span style="font-size:.72rem;color:var(--muted);white-space:nowrap">${ts}</span>
        </div>
        ${details ? `<div style="font-size:.76rem;color:var(--muted);margin-top:.15rem">${details}</div>` : ''}
      </div>`;
    }).join('');

    body.innerHTML = `
      <div style="max-height:420px;overflow-y:auto;display:flex;flex-direction:column;gap:.35rem">
        ${rows}
      </div>
      <p style="font-size:.72rem;color:var(--light);text-align:center;margin-top:.75rem">
        מוצגים ${snap.docs.length} אירועים אחרונים
      </p>`;
  } catch (e) {
    body.innerHTML = `<div class="form-error show">שגיאה בטעינת יומן: ${esc(e.message)}</div>`;
    console.error('openActivityLogModal error:', e);
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

let _approvedExamIds = new Set();

async function _loadApprovedExamIds() {
  try {
    const snap = await db.collection('parse_examples')
      .where('approved', '==', true)
      .limit(500)
      .get();
    _approvedExamIds = new Set(snap.docs.map(d => d.data().examId).filter(Boolean));
  } catch (e) {
    console.warn('Could not load approved example IDs:', e.message);
  }
}

async function toggleApprovedExample(examId, checked, cb) {
  try {
    const docRef = db.collection('parse_examples').doc(`exam_${examId}`);
    const docSnap = await docRef.get();

    if (checked) {
      if (docSnap.exists) {
        await docRef.update({
          approved: true,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedBy: adminUser?.email || 'admin',
        });
      } else {
        // Build example from the exam document
        const exam = await fetchExam(examId);
        if (exam) {
          await saveParseExample(exam, {
            approved: true,
            source: 'manual',
            filenameHint: exam.title || '',
          });
        }
      }
      _approvedExamIds.add(examId);
      toast('🧠 דוגמה מאושרת לאימון', 'success');
    } else {
      if (docSnap.exists) {
        await docRef.update({
          approved: false,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedBy: adminUser?.email || 'admin',
        });
      }
      _approvedExamIds.delete(examId);
      toast('↩️ דוגמה הוסרה מאימון');
    }
    _fewShotCache.clear();
  } catch (e) {
    toast('שגיאה: ' + e.message, 'error');
    if (cb) cb.checked = !checked;
  }
}

async function exportApprovedExamples() {
  if (!confirm('לייצא את כל הדוגמאות המאושרות לקובץ JSONL?')) return;
  try {
    showSpinner('📦 מייצא דוגמאות...');
    await exportApprovedExamplesForFineTune();
    hideSpinner();
  } catch (e) {
    hideSpinner();
    toast('שגיאת ייצוא: ' + e.message, 'error');
  }
}

async function renderManageTable() {
  const container = document.getElementById('manage-table');
  if (!container) return;
  container.innerHTML = '<div class="spinner"></div>';

  try {
    await _loadApprovedExamIds();
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
      const isApproved = _approvedExamIds.has(e.id);
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
        <td style="text-align:center">
          <input type="checkbox" ${isApproved ? 'checked' : ''} onchange="toggleApprovedExample('${e.id}',this.checked,this)" title="דוגמת אימון מאושרת" style="width:18px;height:18px;cursor:pointer;accent-color:#7c3aed">
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
      <thead><tr><th>כותרת</th><th>קורס</th><th>שנה</th><th>סמסטר</th><th>מועד</th><th>מרצה</th><th>שאלות</th><th>מודל</th><th>נבדק</th><th title="דוגמת אימון מאושרת">🧠</th><th>קושי</th><th></th></tr></thead>
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
    _editingExamHidden = exam.hiddenFromStudents === true;
    // Keep the original model badge when saving edited exams without re-parsing.
    _parsedModel = exam.parsedModel || null;

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
    await _setAssignedLecturers(exam.assignedLecturers || []);

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
        pdfCurrentEl.innerHTML = `קובץ נוכחי: <a href="${safeUrl(exam.pdfUrl)}" target="_blank" rel="noopener" style="color:var(--blue)">פתח PDF ↗</a>`;
      }
    } else {
      clearExamPdf();
    }

    // ── Solution PDF ───────────────────────────────────────────
    const solUrlEl     = document.getElementById('ae-sol-url');
    const solNameEl    = document.getElementById('ae-sol-name');
    const solClearEl   = document.getElementById('ae-sol-clear');
    const solCurrentEl = document.getElementById('ae-sol-current');
    if (exam.solutionPdfUrl) {
      if (solUrlEl)     solUrlEl.value = exam.solutionPdfUrl;
      if (solNameEl)    solNameEl.textContent = 'פתרון קיים (ניתן להחליף)';
      if (solClearEl)   solClearEl.style.display = '';
      if (solCurrentEl) {
        solCurrentEl.style.display = '';
        solCurrentEl.innerHTML = `פתרון נוכחי: <a href="${safeUrl(exam.solutionPdfUrl)}" target="_blank" rel="noopener" style="color:var(--blue)">פתח פתרון ↗</a>`;
      }
    } else {
      clearSolPdf();
    }

    // ── Questions ──────────────────────────────────────────────
    parsedQuestions = (exam.questions || []).map(q => ({
      ...migrateLegacyImageToInlineText({ ...q, inlineImages: normalizeInlineImagesMap(q.inlineImages) }, 'question-image'),
      subs: (q.subs || q.parts || []).map(s => (
        migrateLegacyImageToInlineText({ ...s, inlineImages: normalizeInlineImagesMap(s.inlineImages) }, 'sub-image')
      ))
    }));
    _loadedExamImageUrls = collectPersistedInlineImageUrls(exam);

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
  const name    = document.getElementById('c-name').value.trim();
  const code    = document.getElementById('c-code').value.trim();
  const creditsRaw = document.getElementById('c-credits').value.trim();
  const credits = parseFloat(creditsRaw);
  if (!name || !code) { toast('נא למלא שם וקוד', 'error'); return; }
  if (creditsRaw === '' || isNaN(credits) || credits < 0) { toast('נא למלא נקודות זכות תקינות', 'error'); return; }

  try {
    const id = genId();
    await db.collection('courses').doc(id).set({
      id,
      name,
      code,
      creditPoints: credits,
      icon: randIcon(),
      status: 'draft',  // Default to draft - admin must publish manually
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    document.getElementById('c-name').value = '';
    document.getElementById('c-code').value = '';
    document.getElementById('c-credits').value = '';
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
      <td><button class="btn btn-secondary btn-sm" onclick="openEditCourse('${c.id}','${esc(c.name)}','${esc(c.code)}','${esc(c.icon || '')}',${c.creditPoints ?? 0})">✏️ עריכה</button></td>
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

function openEditCourse(id, name, code, icon, creditPoints = 0) {
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
        <label style="font-weight:600">נקודות זכות</label>
        <input id="edit-course-credits" type="number" min="0" max="20" step="0.5"
               value="${creditPoints}" placeholder="3" dir="ltr">
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
  const id           = document.getElementById('edit-course-id').value;
  const name         = document.getElementById('edit-course-name').value.trim();
  const code         = document.getElementById('edit-course-code').value.trim();
  const icon         = document.getElementById('edit-course-icon').value;
  const creditsRaw  = document.getElementById('edit-course-credits').value.trim();
  const creditPoints = parseFloat(creditsRaw);

  if (!name || !code) { toast('נא למלא שם וקוד', 'error'); return; }
  if (creditsRaw === '' || isNaN(creditPoints) || creditPoints < 0) { toast('נא למלא נקודות זכות תקינות', 'error'); return; }

  const saveBtn = document.querySelector('#edit-course-modal .btn-primary');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'שומר...'; }

  try {
    await db.collection('courses').doc(id).update({
      name,
      code,
      icon,
      creditPoints,
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
   LEGAL — Terms of Use Management
══════════════════════════════════════════════════════════ */

async function renderLegalSection() {
  const el = document.getElementById('legal-current');
  if (!el) return;
  el.innerHTML = '<span style="color:var(--muted)">טוען...</span>';
  try {
    const doc  = await db.collection('settings').doc('global').get();
    const data = doc.exists ? doc.data() : {};
    const url  = data.termsUrl;
    const updatedAt = data.termsUpdatedAt?.toDate?.();
    if (url) {
      const dateStr = updatedAt ? updatedAt.toLocaleDateString('he-IL') : 'לא ידוע';
      el.innerHTML = `
        <div style="display:flex;align-items:center;gap:1rem;flex-wrap:wrap">
          <span>📄 <strong>terms-of-use.pdf</strong></span>
          <span style="color:var(--muted);font-size:.82rem">עודכן: ${dateStr}</span>
          <a href="${url}" target="_blank" rel="noopener noreferrer"
             class="btn btn-secondary btn-sm">👁️ צפה בקובץ</a>
        </div>`;
    } else {
      el.innerHTML = '<span style="color:var(--muted)">לא הועלה קובץ תנאי שימוש עדיין.</span>';
    }
  } catch (e) {
    el.innerHTML = `<span style="color:var(--danger)">שגיאה: ${e.message}</span>`;
  }
}

async function uploadTermsFile() {
  const input    = document.getElementById('legal-file-input');
  const statusEl = document.getElementById('legal-upload-status');
  const file     = input?.files?.[0];
  if (!file) { toast('נא לבחור קובץ PDF', 'error'); return; }
  if (file.type !== 'application/pdf') { toast('יש להעלות קובץ PDF בלבד', 'error'); return; }
  if (file.size > 10 * 1024 * 1024)   { toast('גודל הקובץ חייב להיות עד 10MB', 'error'); return; }

  const uploadBtn = document.querySelector('#sec-legal .btn-primary');
  if (uploadBtn) { uploadBtn.disabled = true; uploadBtn.textContent = 'מעלה...'; }
  if (statusEl)  statusEl.textContent = '';

  try {
    const storageRef  = firebase.storage().ref('legal/terms-of-use.pdf');
    const snapshot    = await storageRef.put(file);
    const downloadUrl = await snapshot.ref.getDownloadURL();

    await db.collection('settings').doc('global').set({
      termsUrl:       downloadUrl,
      termsUpdatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    toast('✅ קובץ תנאי השימוש עודכן בהצלחה', 'success');
    input.value = '';
    await renderLegalSection();
  } catch (e) {
    console.error('uploadTermsFile error:', e);
    toast('שגיאה בהעלאה: ' + e.message, 'error');
    if (statusEl) statusEl.textContent = 'שגיאה: ' + e.message;
  } finally {
    if (uploadBtn) { uploadBtn.disabled = false; uploadBtn.textContent = '⬆️ העלאה'; }
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


/* ── AI MONITORING DASHBOARD ─────────────────────────────── */
// Token-based pricing (USD per 1M tokens)
const GEMINI_INPUT_PER_M   = 1.25;
const GEMINI_OUTPUT_PER_M  = 5.00;
const CLAUDE_INPUT_PER_M   = 3.00;
const CLAUDE_OUTPUT_PER_M  = 15.00;
// Flat-rate fallback for older docs that lack token counts
const GEMINI_COST_PER_Q    = 0.0025;
const CLAUDE_COST_PER_Q    = 0.0185;
const COST_ALERT_DAILY     = 10;   // alert if daily cost > $10

async function renderAIMonitor() {
  const statsGrid     = document.getElementById('ai-stats-grid');
  const costSummary   = document.getElementById('ai-cost-summary');
  const usageTable    = document.getElementById('ai-usage-table');
  const topUsersEl    = document.getElementById('ai-top-users');
  const alertsEl      = document.getElementById('ai-alerts');
  const hitRateEl     = document.getElementById('ai-hit-rate');
  const errorRateEl   = document.getElementById('ai-error-rate');
  const ratingsEl     = document.getElementById('ai-ratings-summary');
  const errorLogEl    = document.getElementById('ai-error-log');
  if (!statsGrid) return;

  statsGrid.innerHTML   = '<div style="color:var(--muted)">טוען...</div>';
  costSummary.innerHTML = '<div style="color:var(--muted)">טוען...</div>';

  try {
    const todayStr = new Date().toISOString().slice(0, 10);
    const [todaySnap, recentSnap, cacheSnap, ratingsSnap, errorSnap] = await Promise.all([
      db.collection('generate_usage').where('date_key', '==', todayStr).get(),
      db.collection('generate_usage').orderBy('timestamp', 'desc').limit(50).get(),
      db.collection('ai_questions_cache').get(),
      db.collection('question_ratings').orderBy('createdAt', 'desc').limit(100).get(),
      db.collection('generate_usage').where('status', '==', 'error').orderBy('timestamp', 'desc').limit(20).get(),
    ]);

    const todayDocs = todaySnap.docs.map(d => d.data());
    const totalToday  = todayDocs.length;
    const geminiToday = todayDocs.filter(d => d.api === 'gemini').length;
    const claudeToday = todayDocs.filter(d => d.api === 'claude').length;
    const errorToday  = todayDocs.filter(d => d.status === 'error').length;
    const successToday = totalToday - errorToday;
    const cacheDocs   = cacheSnap.size;
    const avgLatency  = totalToday > 0
      ? Math.round(todayDocs.reduce((s, d) => s + (d.latencyMs || 0), 0) / totalToday)
      : 0;
    const uniqueUsers = new Set(todayDocs.map(d => d.uid)).size;

    // Cache hit rate estimation: cached items served vs total requests
    const cachedToday = todayDocs.filter(d => d.cached === true).length;
    const hitRate     = totalToday > 0 ? Math.round(cachedToday / totalToday * 100) : 0;

    // Error rate
    const errorRate   = totalToday > 0 ? (errorToday / totalToday * 100).toFixed(1) : '0';

    // Quality ratings summary
    const ratingsDocs = ratingsSnap.docs.map(d => d.data());
    const thumbsUp    = ratingsDocs.filter(d => d.rating === 'up').length;
    const thumbsDown  = ratingsDocs.filter(d => d.rating === 'down').length;
    const totalRatings = thumbsUp + thumbsDown;
    const satisfactionPct = totalRatings > 0 ? Math.round(thumbsUp / totalRatings * 100) : 0;

    statsGrid.innerHTML = `
      <div class="stat-card"><div class="stat-val">🚀 ${totalToday}</div><div class="stat-lbl">יצירות היום</div></div>
      <div class="stat-card"><div class="stat-val">👤 ${uniqueUsers}</div><div class="stat-lbl">משתמשים פעילים</div></div>
      <div class="stat-card"><div class="stat-val">⚡ ${avgLatency}ms</div><div class="stat-lbl">זמן תגובה ממוצע</div></div>
      <div class="stat-card"><div class="stat-val">📦 ${cacheDocs}</div><div class="stat-lbl">שאלות במטמון</div></div>
      <div class="stat-card"><div class="stat-val">🔷 ${geminiToday}</div><div class="stat-lbl">Gemini</div></div>
      <div class="stat-card"><div class="stat-val">🔶 ${claudeToday}</div><div class="stat-lbl">Claude (fallback)</div></div>
      <div class="stat-card"><div class="stat-val" style="color:${parseFloat(errorRate) > 5 ? '#dc2626' : '#059669'}">${parseFloat(errorRate) > 5 ? '🔴' : '🟢'} ${errorRate}%</div><div class="stat-lbl">שיעור שגיאות</div></div>
      <div class="stat-card"><div class="stat-val" style="color:${hitRate > 50 ? '#059669' : '#f59e0b'}">${hitRate > 50 ? '🟢' : '🟡'} ${hitRate}%</div><div class="stat-lbl">שיעור מטמון</div></div>`;

    const costToday = todayDocs.reduce((sum, d) => {
      if (d.inputTokens || d.outputTokens) {
        const inRate  = d.api === 'claude' ? CLAUDE_INPUT_PER_M  : GEMINI_INPUT_PER_M;
        const outRate = d.api === 'claude' ? CLAUDE_OUTPUT_PER_M : GEMINI_OUTPUT_PER_M;
        return sum + ((d.inputTokens || 0) / 1_000_000 * inRate) + ((d.outputTokens || 0) / 1_000_000 * outRate);
      }
      return sum + (d.api === 'claude' ? CLAUDE_COST_PER_Q : GEMINI_COST_PER_Q);
    }, 0);
    const estMonthly = costToday * 30;
    const costPct = Math.min(Math.round(costToday / COST_ALERT_DAILY * 100), 100);
    const costBarColor = costPct > 80 ? '#dc2626' : costPct > 50 ? '#f59e0b' : '#059669';
    costSummary.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:1rem;padding:.3rem 0">
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:1rem;text-align:center">
          <div><div style="font-size:1.4rem;font-weight:800;color:#059669">$${costToday.toFixed(4)}</div><div style="font-size:.75rem;color:var(--muted);margin-top:.15rem">עלות היום</div></div>
          <div><div style="font-size:1.4rem;font-weight:800;color:#6366f1">$${estMonthly.toFixed(2)}</div><div style="font-size:.75rem;color:var(--muted);margin-top:.15rem">הערכה חודשית</div></div>
          <div><div style="font-size:1.4rem;font-weight:800;color:#f59e0b">${totalToday > 0 ? (costToday / totalToday * 1000).toFixed(2) : '0'}¢</div><div style="font-size:.75rem;color:var(--muted);margin-top:.15rem">ממוצע לשאלה</div></div>
        </div>
        <div>
          <div style="display:flex;justify-content:space-between;font-size:.72rem;color:var(--muted);margin-bottom:.3rem"><span>תקציב יומי</span><span>$${costToday.toFixed(2)} / $${COST_ALERT_DAILY}</span></div>
          <div style="background:#f3f4f6;border-radius:6px;height:8px;overflow:hidden"><div style="width:${costPct}%;height:100%;background:${costBarColor};border-radius:6px;transition:width .3s"></div></div>
        </div>
      </div>`;

    // \u2500\u2500 Cost Alert \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    if (alertsEl) {
      const alerts = [];

      // Count 500 / server errors from the error log
      const errorDocs500 = errorSnap.docs.map(d => d.data()).filter(d =>
        (d.errorMessage || '').includes('[500]') || (d.errorMessage || '').includes('Server error') || (d.errorMessage || '').includes('[client]')
      );
      const errors500Today = errorDocs500.filter(d => d.date_key === todayStr).length;
      if (errors500Today > 0) alerts.push(`🔴 ${errors500Today} שגיאות שרת (500) היום — שאלות לא נוצרו למשתמשים! בדוק לוג שגיאות למטה`);

      if (costToday > COST_ALERT_DAILY) alerts.push(`\u26a0\ufe0f \u05e2\u05dc\u05d5\u05ea \u05d9\u05d5\u05de\u05d9\u05ea ($${costToday.toFixed(2)}) \u05d7\u05d5\u05e8\u05d2\u05ea \u05de-$${COST_ALERT_DAILY}`);
      if (parseFloat(errorRate) > 5) alerts.push(`\u26a0\ufe0f \u05e9\u05d9\u05e2\u05d5\u05e8 \u05e9\u05d2\u05d9\u05d0\u05d5\u05ea \u05d2\u05d1\u05d5\u05d4 (${errorRate}%) \u2014 \u05d1\u05d3\u05d5\u05e7 \u05ea\u05e7\u05d9\u05e0\u05d5\u05ea API`);
      if (estMonthly > 100) alerts.push(`\u26a0\ufe0f \u05d4\u05e2\u05e8\u05db\u05ea \u05e2\u05dc\u05d5\u05ea \u05d7\u05d5\u05d3\u05e9\u05d9\u05ea ($${estMonthly.toFixed(0)}) \u05d7\u05d5\u05e8\u05d2\u05ea \u05de-$100`);
      if (hitRate < 30 && totalToday > 20) alerts.push(`\u2139\ufe0f \u05e9\u05d9\u05e2\u05d5\u05e8 \u05de\u05d8\u05de\u05d5\u05df \u05e0\u05de\u05d5\u05da (${hitRate}%) \u2014 \u05e9\u05e7\u05d5\u05dc \u05dc\u05d4\u05d2\u05d3\u05d9\u05dc TTL`);

      if (alerts.length) {
        alertsEl.innerHTML = alerts.map(a => {
          const isCritical = a.startsWith('🔴');
          const isWarning = a.startsWith('\u26a0\ufe0f');
          const bg = isCritical ? '#fecaca' : isWarning ? '#fef2f2' : '#eff6ff';
          const fg = isCritical ? '#7f1d1d' : isWarning ? '#991b1b' : '#1e40af';
          return `<div style="padding:.5rem .8rem;background:${bg};border-radius:8px;font-size:.85rem;color:${fg};${isCritical ? 'font-weight:700;border:1.5px solid #dc2626' : ''}">${a}</div>`;
        }).join('');
        alertsEl.style.display = 'flex';
      } else {
        alertsEl.innerHTML = '<div style="padding:.5rem .8rem;background:#f0fdf4;border-radius:8px;font-size:.85rem;color:#166534">\u2705 \u05d4\u05db\u05dc \u05ea\u05e7\u05d9\u05df \u2014 \u05d0\u05d9\u05df \u05d4\u05ea\u05e8\u05d0\u05d5\u05ea</div>';
        alertsEl.style.display = 'flex';
      }
    }

    // \u2500\u2500 Quality ratings panel \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    if (ratingsEl) {
      if (totalRatings === 0) {
        ratingsEl.innerHTML = '<div style="color:var(--muted);padding:1.5rem;text-align:center;font-size:.9rem">אין דירוגים עדיין</div>';
      } else {
        ratingsEl.innerHTML = `
          <div style="display:flex;flex-direction:column;gap:1rem;padding:.5rem 0">
            <div style="display:flex;align-items:center;justify-content:center;gap:2.5rem">
              <div style="text-align:center"><span style="font-size:2rem">👍</span><div style="font-size:1.5rem;font-weight:800;color:#059669;margin-top:.2rem">${thumbsUp}</div><div style="font-size:.7rem;color:var(--muted)">חיובי</div></div>
              <div style="text-align:center"><span style="font-size:2rem">👎</span><div style="font-size:1.5rem;font-weight:800;color:#dc2626;margin-top:.2rem">${thumbsDown}</div><div style="font-size:.7rem;color:var(--muted)">שלילי</div></div>
            </div>
            <div>
              <div style="display:flex;justify-content:space-between;font-size:.72rem;color:var(--muted);margin-bottom:.3rem"><span>שביעות רצון</span><span>${satisfactionPct}% (${totalRatings} דירוגים)</span></div>
              <div style="background:#f3f4f6;border-radius:6px;height:8px;overflow:hidden">
                <div style="width:${satisfactionPct}%;height:100%;background:linear-gradient(90deg,#22c55e,#059669);border-radius:6px;transition:width .3s"></div>
              </div>
            </div>
          </div>`;
      }
    }

    const recentDocs = recentSnap.docs.map(d => d.data());
    if (!recentDocs.length) {
      usageTable.innerHTML = '<div style="color:var(--muted);padding:1rem">אין נתוני שימוש עדיין</div>';
    } else {
      const rows = recentDocs.map(d => {
        const ts = d.timestamp ? new Date(d.timestamp).toLocaleString('he-IL', { hour:'2-digit', minute:'2-digit', day:'numeric', month:'short' }) : '-';
        const apiBadge = d.api === 'claude'
          ? '<span style="color:#f59e0b;font-weight:600">Claude</span>'
          : d.api === 'none'
          ? '<span style="color:#dc2626;font-weight:600">None</span>'
          : '<span style="color:#6366f1;font-weight:600">Gemini</span>';
        const statusBadge = d.status === 'error'
          ? '<span style="color:#dc2626">✗</span>'
          : '<span style="color:#059669">✓</span>';
        return '<tr><td style="font-size:.8rem">' + ts + '</td><td>' + esc((d.uid || '').slice(0, 8)) + '…</td><td>' + apiBadge + '</td><td>' + statusBadge + '</td><td>' + (d.latencyMs || 0) + 'ms</td><td>' + (d.inputTokens > 0 ? d.inputTokens + ' tok' : (d.promptLength || 0) + ' ch') + '</td><td>' + (d.outputTokens > 0 ? d.outputTokens + ' tok' : (d.responseLength || 0) + ' ch') + '</td></tr>';
      }).join('');

      usageTable.innerHTML = '<table class="tbl" style="width:100%"><thead><tr><th>זמן</th><th>משתמש</th><th>API</th><th>סטטוס</th><th>השהייה</th><th>טוקנים (קלט)</th><th>טוקנים (פלט)</th></tr></thead><tbody>' + rows + '</tbody></table>';
    }

    const userCounts = {};
    todayDocs.forEach(d => { userCounts[d.uid] = (userCounts[d.uid] || 0) + 1; });
    const sorted = Object.entries(userCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);

    if (!sorted.length) {
      topUsersEl.innerHTML = '<div style="color:var(--muted);padding:1rem">אין שימוש היום</div>';
    } else {
      const uids = sorted.map(([uid]) => uid);
      const userDocs = await Promise.all(uids.map(uid => db.collection('users').doc(uid).get()));
      const emailMap = {};
      userDocs.forEach(snap => { if (snap.exists) emailMap[snap.id] = snap.data().email || snap.id; });

      topUsersEl.innerHTML = sorted.map(([uid, count]) => {
        const email = emailMap[uid] || uid.slice(0, 12) + '…';
        const pct = Math.min(Math.round(count / 10 * 100), 100);
        return '<div style="display:flex;align-items:center;gap:.8rem;padding:.4rem 0"><span style="flex:1;font-size:.85rem">' + esc(email) + '</span><div style="flex:2;background:#f3f4f6;border-radius:6px;height:18px;overflow:hidden"><div style="width:' + pct + '%;height:100%;background:linear-gradient(90deg,#667eea,#764ba2);border-radius:6px"></div></div><span style="font-weight:700;min-width:2.5rem;text-align:left">' + count + '</span></div>';
      }).join('');
    }

    // ── Error log panel ─────────────────────────────────────
    if (errorLogEl) {
      const errorDocs = errorSnap.docs.map(d => d.data());
      if (!errorDocs.length) {
        errorLogEl.innerHTML = '<div style="color:#059669;padding:1rem;text-align:center;font-size:.9rem">✅ אין שגיאות אחרונות — הכל תקין</div>';
      } else {
        const errorUids = [...new Set(errorDocs.map(d => d.uid).filter(Boolean))];
        const errorUserDocs = await Promise.all(errorUids.map(uid => db.collection('users').doc(uid).get()));
        const errorEmailMap = {};
        errorUserDocs.forEach(snap => { if (snap.exists) errorEmailMap[snap.id] = snap.data().email || snap.id; });

        const errorRows = errorDocs.map(d => {
          const ts = d.timestamp ? new Date(d.timestamp).toLocaleString('he-IL', { hour:'2-digit', minute:'2-digit', day:'numeric', month:'short' }) : '-';
          const userEmail = d.uid ? (errorEmailMap[d.uid] || d.uid.slice(0, 8) + '…') : 'N/A';
          const apiBadge = d.api === 'claude'
            ? '<span style="color:#f59e0b;font-weight:600">Claude</span>'
            : d.api === 'none'
            ? '<span style="color:#9ca3af;font-weight:600">—</span>'
            : '<span style="color:#6366f1;font-weight:600">Gemini</span>';
          const errMsg = esc(d.errorMessage || 'שגיאה לא ידועה');
          const is500 = (d.errorMessage || '').includes('[500]') || (d.errorMessage || '').includes('Server error') || (d.errorMessage || '').includes('[client]');
          const rowStyle = is500 ? 'background:#fef2f2;font-weight:600' : '';
          return '<tr style="' + rowStyle + '"><td style="font-size:.8rem;white-space:nowrap">' + ts + '</td><td style="font-size:.8rem">' + esc(userEmail) + '</td><td>' + apiBadge + '</td><td style="font-size:.8rem;color:#dc2626;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + errMsg + '">' + (is500 ? '🔴 ' : '') + errMsg + '</td></tr>';
        }).join('');
        errorLogEl.innerHTML = '<table class="tbl" style="width:100%"><thead><tr><th>זמן</th><th>משתמש</th><th>API</th><th>שגיאה</th></tr></thead><tbody>' + errorRows + '</tbody></table>';
      }
    }

  } catch (e) {
    console.error('AI Monitor error:', e);
    statsGrid.innerHTML = '<div style="color:#dc2626;padding:1rem">שגיאה בטעינה: ' + esc(e.message) + '</div>';
  }
}


async function _loadReportsBadge() {
  try {
    const snap = await db.collection('reports').where('status', '==', 'open').get();
    const visibleOpen = snap.docs.map(d => d.data()).filter(r => !r.adminDeletedAt).length;
    const badge = document.getElementById('reports-badge');
    if (!badge) return;
    if (visibleOpen > 0) { badge.textContent = visibleOpen; badge.style.display = 'inline-block'; }
    else badge.style.display = 'none';
  } catch(e) { console.warn('_loadReportsBadge:', e.message); }
}

/* ══════════════════════════════════════════════════════════════
   REPORTS SECTION
   ═══════════════════════════════════════════════════════════ */

let _reportsCurrentTab = 'open'; // 'open' | 'videos' | 'archived'

function switchReportsTab(tab) {
  _reportsCurrentTab = tab;
  document.getElementById('reports-tab-open')?.classList.toggle('active', tab === 'open');
  document.getElementById('reports-tab-videos')?.classList.toggle('active', tab === 'videos');
  document.getElementById('reports-tab-archived')?.classList.toggle('active', tab === 'archived');
  _renderReportsContent();
}

async function renderReportsSection() {
  const el = document.getElementById('reports-content');
  if (el) el.innerHTML = '<div class="spinner" style="margin:2rem auto"></div>';

  // update badge with open count
  try {
    const snap = await db.collection('reports').where('status', '==', 'open').get();
    const visibleOpen = snap.docs.map(d => d.data()).filter(r => !r.adminDeletedAt).length;
    const badge = document.getElementById('reports-badge');
    if (badge) {
      if (visibleOpen > 0) { badge.textContent = visibleOpen; badge.style.display = 'inline-block'; }
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
  const isVideos  = _reportsCurrentTab === 'videos';
  const status    = isArchive ? 'closed' : 'open';

  try {
    const snap = await db.collection('reports').where('status', '==', status).get();

    let items = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(r => !r.adminDeletedAt)
      .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));

    if (isVideos) items = items.filter(r => r.category === 'lecturer_video_submission');

    if (!items.length) {
      el.innerHTML = `
        <div class="empty" style="padding:2.5rem;text-align:center">
          <span style="font-size:2rem;display:block;margin-bottom:.5rem">${isArchive ? '🗂️' : isVideos ? '🎬' : '📭'}</span>
          <h3 style="font-weight:600;margin-bottom:.3rem">${isArchive ? 'הארכיון ריק' : isVideos ? 'אין סרטונים בהמתנה לאישור' : 'אין דיווחים פתוחים'}</h3>
          <p style="color:var(--muted);font-size:.88rem">${isArchive ? 'עוד לא נסגרו דיווחים' : isVideos ? 'כל ההגשות טופלו' : 'כל הדיווחים טופלו'}</p>
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
        : r.category === 'lecturer_delete_request'
          ? `<span class="badge" style="background:#fee2e2;color:#b91c1c;border:1px solid #fca5a5">🗑 בקשת מחיקה ממרצה</span>`
          : r.category === 'lecturer_video_submission'
            ? `<span class="badge" style="background:#dbeafe;color:#1e3a8a;border:1px solid #93c5fd">🎬 סרטון חדש ממרצה</span>`
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

      const responseDate = r.adminResponseAt?.toDate?.();
      const responseStr = responseDate
        ? responseDate.toLocaleDateString('he-IL', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' })
        : '';
      const hasResponse = Boolean(String(r.adminResponseText || '').trim());
      const responseInfo = hasResponse
        ? `<div style="background:#ecfeff;border:1px solid #a5f3fc;border-radius:8px;padding:.65rem .9rem;display:flex;flex-direction:column;gap:.35rem">
             <div style="font-size:.78rem;color:#0e7490;display:flex;align-items:center;gap:.4rem;flex-wrap:wrap">
               <span>✉ תגובת מנהל למשתמש</span>
               ${responseStr ? `<span style="margin-right:auto">${responseStr}</span>` : ''}
             </div>
             <div style="font-size:.88rem;line-height:1.6;white-space:pre-wrap;word-break:break-word">${esc(r.adminResponseText)}</div>
           </div>`
        : '';

      const responseEditor = `
        <div style="display:flex;flex-direction:column;gap:.4rem">
          <label style="font-size:.8rem;color:var(--muted);font-weight:600">${hasResponse ? 'עדכון תגובה למשתמש' : 'תגובה למשתמש'}</label>
          <textarea id="report-admin-response-${r.id}" rows="3" dir="rtl"
            placeholder="כתוב כאן תגובה שתופיע למשתמש..."
            style="width:100%;border:1.5px solid var(--border);border-radius:8px;padding:.7rem;
                   font-family:inherit;font-size:.86rem;resize:vertical;box-sizing:border-box;color:var(--text)">${esc(r.adminResponseText || '')}</textarea>
          <div style="display:flex;justify-content:flex-end">
            <button class="btn btn-primary btn-sm" id="report-admin-response-btn-${r.id}"
              onclick="saveReportResponse('${esc(r.id)}')">${hasResponse ? 'עדכן תגובה' : 'שלח תגובה'}</button>
          </div>
        </div>`;

      const actionBtn = isArchive
        ? `<button class="btn btn-sm" style="background:#fee2e2;color:#b91c1c;border-color:#fca5a5"
           onclick="deleteReport('${esc(r.id)}')">🗑 הסר מהפאנל</button>`
        : `<button class="btn btn-secondary btn-sm" onclick="closeReport('${esc(r.id)}')">✓ סגור תקלה</button>`;

      const videoReviewPanel = (r.category === 'lecturer_video_submission' && r.submissionId)
        ? `<div id="lvr-panel-${esc(r.id)}" data-submission-id="${esc(r.submissionId)}"
             style="background:#eff6ff;border:1px solid #93c5fd;border-radius:8px;padding:.65rem .9rem;display:flex;flex-direction:column;gap:.5rem">
             <div style="font-size:.78rem;color:#1e3a8a;font-weight:600">🎬 סקירת סרטון מהמרצה</div>
             <div style="font-size:.78rem;color:#1e3a8a">שאלה: <strong>${esc(r.questionId || '')}</strong>${r.examId ? ` · מבחן: <strong>${esc(r.examId)}</strong>` : ''}</div>
             <div style="display:flex;gap:.4rem;flex-wrap:wrap">
               <button class="btn btn-sm" onclick="openLecturerVideoReview('${esc(r.submissionId)}','${esc(r.id)}')">👁 צפה ואשר/דחה</button>
             </div>
           </div>`
        : '';

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
            ${videoReviewPanel}
            ${responseInfo}
            ${responseEditor}
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

async function saveReportResponse(reportId) {
  if (!adminUser) return;

  const ta = document.getElementById(`report-admin-response-${reportId}`);
  const btn = document.getElementById(`report-admin-response-btn-${reportId}`);
  const responseText = ta?.value.trim() || '';

  if (!responseText) {
    toast('נא למלא תגובה לפני השליחה', 'error');
    ta?.focus();
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'שומר...';
  }

  try {
    await db.collection('reports').doc(reportId).update({
      adminResponseText: responseText,
      adminResponseAt: firebase.firestore.FieldValue.serverTimestamp(),
      adminResponseBy: adminUser.uid || '',
      adminResponseByEmail: adminUser.email || '',
    });
    toast('התגובה נשלחה למשתמש', 'info');
    renderReportsSection();
  } catch (e) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'שלח תגובה';
    }
    toast('שגיאה בשמירת התגובה: ' + e.message, 'error');
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
  if (!confirm('להסיר את הדיווח מהפאנל הניהולי בלבד? המשתמש עדיין יוכל לראות אותו.')) return;
  try {
    const ref = db.collection('reports').doc(reportId);
    const snap = await ref.get();
    if (!snap.exists) {
      toast('הדיווח כבר לא קיים', 'info');
      renderReportsSection();
      return;
    }
    const data = snap.data() || {};

    const update = {
      adminDeletedAt: firebase.firestore.FieldValue.serverTimestamp(),
      adminDeletedBy: adminUser?.uid || '',
      adminDeletedByEmail: adminUser?.email || '',
    };
    if (data.userDeletedAt && !data.bothDeletedAt) {
      update.bothDeletedAt = firebase.firestore.FieldValue.serverTimestamp();
    }

    await ref.update(update);
    toast('הדיווח הוסר מפאנל הניהול', 'info');
    renderReportsSection();
  } catch(e) {
    toast('שגיאה במחיקה: ' + e.message, 'error');
  }
}

/* ══════════════════════════════════════════════════════════
   VIDEO ATTACH MODAL — admin panel (mirrors course.js)
══════════════════════════════════════════════════════════ */

async function openVideoAttachAdminModal(entityId, entityLabel) {
  document.getElementById('video-attach-admin-modal')?.remove();
  let existing = {};
  try {
    const doc = await db.collection('question_videos').doc(entityId).get();
    if (doc.exists) existing = doc.data();
  } catch (e) { console.warn('openVideoAttachAdminModal fetch:', e); }

  function _esc(s) {
    if (!s && s !== 0) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  const overlay = document.createElement('div');
  overlay.id = 'video-attach-admin-modal';
  overlay.className = 'admin-modal-overlay';
  overlay.innerHTML = `
    <div class="admin-modal" style="max-width:460px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem">
        <h3 style="margin:0;font-size:1rem">🎬 ${_esc(entityLabel)} — צרף סרטון Bunny</h3>
        <button class="btn-icon" onclick="document.getElementById('video-attach-admin-modal').remove()" style="font-size:1.1rem;background:none;border:none;cursor:pointer;color:var(--muted)">✕</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:.8rem">
        <div>
          <label style="font-size:.85rem;color:var(--muted);display:block;margin-bottom:.3rem">Library ID (מספר הספרייה ב-Bunny)</label>
          <input id="vaa-lib" type="text" placeholder="למשל: 123456"
            value="${_esc(existing.libraryId || '')}"
            style="width:100%;box-sizing:border-box;padding:.5rem .7rem;border:1.5px solid var(--border);border-radius:8px;font-size:.9rem;font-family:inherit">
        </div>
        <div>
          <label style="font-size:.85rem;color:var(--muted);display:block;margin-bottom:.3rem">Video ID (ה-GUID של הסרטון ב-Bunny)</label>
          <input id="vaa-vid" type="text" placeholder="למשל: a1b2c3d4-e5f6-7890-abcd-ef1234567890"
            value="${_esc(existing.videoId || '')}"
            style="width:100%;box-sizing:border-box;padding:.5rem .7rem;border:1.5px solid var(--border);border-radius:8px;font-size:.9rem;font-family:inherit">
        </div>
        <div>
          <label style="font-size:.85rem;color:var(--muted);display:block;margin-bottom:.3rem">כותרת (אופציונלי)</label>
          <input id="vaa-title" type="text" placeholder="פתרון לשאלה..."
            value="${_esc(existing.title || '')}"
            style="width:100%;box-sizing:border-box;padding:.5rem .7rem;border:1.5px solid var(--border);border-radius:8px;font-size:.9rem;font-family:inherit">
        </div>
        <p style="font-size:.8rem;color:var(--muted);margin:0;background:#f8fafc;padding:.6rem .8rem;border-radius:8px;line-height:1.6">
          📋 <strong>איך מוצאים את המזהים?</strong><br>
          Bunny Dashboard → Stream Library → בחר סרטון → העתק Library ID (מספר) ו-Video ID (GUID).
        </p>
        <div id="vaa-err" style="color:#ef4444;font-size:.85rem;display:none"></div>
        <div style="display:flex;gap:.6rem;justify-content:flex-end;flex-wrap:wrap">
          ${existing.videoId ? `<button class="btn" style="color:#ef4444;border-color:#ef4444" onclick="detachQuestionVideoAdmin('${_esc(entityId)}')">🗑 הסר סרטון</button>` : ''}
          <button class="btn" onclick="document.getElementById('video-attach-admin-modal').remove()">ביטול</button>
          <button class="btn btn-primary" onclick="saveVideoAttachAdmin('${_esc(entityId)}')">💾 שמור</button>
        </div>
      </div>
    </div>`;

  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  document.getElementById('vaa-lib')?.focus();
}

async function saveVideoAttachAdmin(entityId) {
  const libraryId = (document.getElementById('vaa-lib')?.value || '').trim();
  const videoId   = (document.getElementById('vaa-vid')?.value || '').trim();
  const title     = (document.getElementById('vaa-title')?.value || '').trim();
  const errEl     = document.getElementById('vaa-err');

  if (!libraryId || !videoId) {
    errEl.textContent = 'Library ID ו-Video ID הם שדות חובה';
    errEl.style.display = 'block';
    return;
  }
  if (!/^\d+$/.test(libraryId)) {
    errEl.textContent = 'Library ID חייב להיות מספר בלבד';
    errEl.style.display = 'block';
    return;
  }
  if (!/^[a-zA-Z0-9\-]{8,}$/.test(videoId)) {
    errEl.textContent = 'Video ID לא תקין — יש להעתיק את ה-GUID מ-Bunny';
    errEl.style.display = 'block';
    return;
  }

  const btn = document.querySelector('#video-attach-admin-modal .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = 'שומר...'; }
  try {
    await db.collection('question_videos').doc(entityId).set({
      libraryId,
      videoId,
      title: title || '',
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    toast('✅ סרטון נשמר בהצלחה', 'success');
    document.getElementById('video-attach-admin-modal')?.remove();
      _refreshAdminVideoButtons();
  } catch (e) {
    if (errEl) { errEl.textContent = 'שגיאה בשמירה: ' + e.message; errEl.style.display = 'block'; }
    if (btn) { btn.disabled = false; btn.textContent = '💾 שמור'; }
  }
}

async function detachQuestionVideoAdmin(entityId) {
  if (!confirm('להסיר את הסרטון מהשאלה?')) return;
  try {
    await db.collection('question_videos').doc(entityId).delete();
    toast('סרטון הוסר', 'info');
    document.getElementById('video-attach-admin-modal')?.remove();
      _refreshAdminVideoButtons();
  } catch (e) {
    toast('שגיאה בהסרה: ' + e.message, 'error');
  }
}

  async function _refreshAdminVideoButtons() {
    const ids = [];
    for (const q of (parsedQuestions || [])) {
      if (q.id) ids.push(q.id);
      for (const s of (q.subs || [])) { if (s.id) ids.push(s.id); }
    }
    if (!ids.length) return;

    const videoSet = new Set();
    for (let i = 0; i < ids.length; i += 30) {
      const chunk = ids.slice(i, i + 30);
      try {
        const snap = await db.collection('question_videos')
          .where(firebase.firestore.FieldPath.documentId(), 'in', chunk).get();
        snap.forEach(d => videoSet.add(d.id));
      } catch (e) { /* ignore */ }
    }

    for (const id of ids) {
      const btn = document.getElementById('vbtn-' + id);
      if (!btn) continue;
      if (videoSet.has(id)) {
        btn.style.background = 'rgba(34,197,94,.12)';
        btn.style.color = '#16a34a';
        btn.style.borderColor = 'rgba(34,197,94,.35)';
        btn.title = 'ערוך סרטון פתרון';
      } else {
        btn.style.background = 'rgba(239,68,68,.1)';
        btn.style.color = '#dc2626';
        btn.style.borderColor = 'rgba(239,68,68,.3)';
        btn.title = 'צרף סרטון פתרון';
      }
    }
  }

/* ══════════════════════════════════════════════════════════
   BROADCAST MESSAGES
   Admins can compose a message and target either ALL users
   or only users who saved a specific course in their personal
   area (savedCourses array). Stored in `broadcasts` collection.
══════════════════════════════════════════════════════════ */

async function renderBroadcastSection() {
  // Populate course dropdown using existing helper
  try { await populateAllSelects(); } catch (_e) {}
  // Make sure form starts in clean state
  resetBroadcastForm();
  renderBroadcastList();
}

function onBroadcastAudienceChange() {
  const v = document.querySelector('input[name="bc-audience"]:checked')?.value || 'all';
  const wrap = document.getElementById('bc-course-wrap');
  if (wrap) wrap.style.display = (v === 'course') ? '' : 'none';
}

function resetBroadcastForm() {
  const t = document.getElementById('bc-title');
  const b = document.getElementById('bc-body');
  const c = document.getElementById('bc-course');
  const err = document.getElementById('bc-error');
  if (t) t.value = '';
  if (b) b.value = '';
  if (c) c.value = '';
  if (err) { err.textContent = ''; err.style.display = 'none'; }
  const allRadio = document.querySelector('input[name="bc-audience"][value="all"]');
  if (allRadio) allRadio.checked = true;
  const regRadio = document.querySelector('input[name="bc-priority"][value="regular"]');
  if (regRadio) regRadio.checked = true;
  onBroadcastAudienceChange();
}

function _bcShowError(msg) {
  const err = document.getElementById('bc-error');
  if (!err) return;
  err.textContent = msg;
  err.style.display = 'block';
}

async function sendBroadcast() {
  const title = (document.getElementById('bc-title')?.value || '').trim();
  const body  = (document.getElementById('bc-body')?.value  || '').trim();
  const audience = document.querySelector('input[name="bc-audience"]:checked')?.value || 'all';
  const priority = document.querySelector('input[name="bc-priority"]:checked')?.value || 'regular';
  const courseId = (document.getElementById('bc-course')?.value || '').trim();
  const btn = document.getElementById('bc-send-btn');
  const err = document.getElementById('bc-error');
  if (err) { err.textContent = ''; err.style.display = 'none'; }

  if (!title) return _bcShowError('יש להזין כותרת');
  if (!body)  return _bcShowError('יש להזין תוכן הודעה');
  if (audience === 'course' && !courseId) return _bcShowError('יש לבחור קורס');

  if (!confirm('לשלוח את ההודעה? לא ניתן לערוך אותה לאחר השליחה.')) return;

  if (btn) { btn.disabled = true; btn.textContent = 'שולח...'; }
  try {
    let courseName = null;
    if (audience === 'course') {
      try {
        const courses = await fetchCourses();
        courseName = courses.find(c => c.id === courseId)?.name || null;
      } catch (_e) {}
    }
    await db.collection('broadcasts').add({
      title,
      body,
      audience,                                  // 'all' | 'course'
      courseId: audience === 'course' ? courseId : null,
      courseName,
      priority,                                  // 'regular' | 'urgent'
      active: true,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      createdBy: adminUser?.email || null,
    });
    toast('ההודעה נשלחה בהצלחה', 'success');
    resetBroadcastForm();
    renderBroadcastList();
  } catch (e) {
    console.error('sendBroadcast error', e);
    _bcShowError('שגיאה בשליחת ההודעה: ' + (e.message || e));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📣 שלח הודעה'; }
  }
}

async function renderBroadcastList() {
  const list = document.getElementById('bc-list');
  if (!list) return;
  list.innerHTML = '<div style="color:var(--muted);font-size:.85rem">טוען...</div>';
  try {
    const snap = await db.collection('broadcasts')
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();
    if (snap.empty) {
      list.innerHTML = '<div style="color:var(--muted);font-size:.85rem">לא נשלחו הודעות עדיין</div>';
      return;
    }
    const rows = snap.docs.map(d => {
      const x = d.data();
      const when = x.createdAt?.toDate ? x.createdAt.toDate().toLocaleString('he-IL') : '—';
      const audienceLabel = x.audience === 'course'
        ? `קורס: ${esc(x.courseName || x.courseId || '')}`
        : 'כל המשתמשים';
      const priorityBadge = x.priority === 'urgent'
        ? '<span style="background:#fef3c7;color:#92400e;padding:.1rem .5rem;border-radius:6px;font-size:.7rem;font-weight:700">⚠️ דחופה</span>'
        : '<span style="background:#e0e7ff;color:#3730a3;padding:.1rem .5rem;border-radius:6px;font-size:.7rem;font-weight:700">📥 תיבת הודעות</span>';
      const activeBadge = x.active === false
        ? '<span style="background:#fee2e2;color:#991b1b;padding:.1rem .5rem;border-radius:6px;font-size:.7rem;font-weight:700">לא פעיל</span>'
        : '<span style="background:#dcfce7;color:#166534;padding:.1rem .5rem;border-radius:6px;font-size:.7rem;font-weight:700">פעיל</span>';
      return `
        <div style="border:1px solid var(--border);border-radius:10px;padding:.85rem 1rem;margin-bottom:.75rem;background:#fff">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:.75rem;margin-bottom:.4rem">
            <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap">
              <strong style="font-size:.95rem">${esc(x.title || '')}</strong>
              ${priorityBadge}
              ${activeBadge}
            </div>
            <div style="display:flex;gap:.4rem;flex-shrink:0">
              <button class="btn btn-secondary btn-sm" onclick="toggleBroadcastActive('${d.id}', ${x.active === false ? 'true' : 'false'})">
                ${x.active === false ? 'הפעל' : 'השבת'}
              </button>
              <button class="btn btn-danger btn-sm" onclick="deleteBroadcast('${d.id}')">מחק</button>
            </div>
          </div>
          <div style="font-size:.85rem;color:#374151;white-space:pre-wrap;margin-bottom:.5rem">${esc(x.body || '')}</div>
          <div style="font-size:.72rem;color:var(--muted);display:flex;gap:.85rem;flex-wrap:wrap">
            <span>👥 ${audienceLabel}</span>
            <span>🕒 ${when}</span>
            <span>✉️ ${esc(x.createdBy || '—')}</span>
          </div>
        </div>`;
    }).join('');
    list.innerHTML = rows;
  } catch (e) {
    console.error('renderBroadcastList error', e);
    list.innerHTML = '<div style="color:#b91c1c;font-size:.85rem">שגיאה בטעינת רשימת ההודעות</div>';
  }
}

async function toggleBroadcastActive(id, makeActive) {
  try {
    await db.collection('broadcasts').doc(id).update({ active: !!makeActive });
    toast('עודכן', 'success');
    renderBroadcastList();
  } catch (e) {
    console.error('toggleBroadcastActive error', e);
    toast('שגיאה בעדכון', 'error');
  }
}

async function deleteBroadcast(id) {
  if (!confirm('למחוק את ההודעה לצמיתות?')) return;
  try {
    await db.collection('broadcasts').doc(id).delete();
    toast('ההודעה נמחקה', 'success');
    renderBroadcastList();
  } catch (e) {
    console.error('deleteBroadcast error', e);
    toast('שגיאה במחיקה', 'error');
  }
}

/* ============================================================
   LECTURER VIDEO SUBMISSIONS — admin review / approve / reject
   ============================================================ */

function _lvrFmtTime(s) {
  s = Math.max(0, Math.floor(Number(s) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}
function _lvrParseTime(str) {
  const parts = String(str || '').trim().split(':').map(p => Number(p));
  if (parts.some(n => !Number.isFinite(n) || n < 0)) return NaN;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return NaN;
}

async function openLecturerVideoReview(submissionId, reportId) {
  document.getElementById('lvr-modal')?.remove();

  let sub;
  try {
    const snap = await db.collection('video_submissions').doc(submissionId).get();
    if (!snap.exists) { toast('ההגשה לא נמצאה', 'error'); return; }
    sub = snap.data();
  } catch (e) {
    toast('שגיאת טעינה: ' + e.message, 'error');
    return;
  }

  // Resolve friendly labels: exam title + question number (sub-question letter if any)
  let examLabel = '';
  let qLabel    = '';
  try {
    if (sub.examId) {
      const exSnap = await db.collection('exams').doc(sub.examId).get();
      if (exSnap.exists) {
        const ex = exSnap.data();
        examLabel = ex.title || ex.name || sub.examId;
        const qs = Array.isArray(ex.questions) ? ex.questions : [];
        // Direct match on top-level question
        let qIdx = qs.findIndex(q => q && q.id === sub.questionId);
        if (qIdx >= 0) {
          qLabel = `שאלה ${qIdx + 1}`;
        } else {
          // Search inside subQuestions of each top-level question
          for (let i = 0; i < qs.length; i++) {
            const subs = Array.isArray(qs[i]?.subQuestions) ? qs[i].subQuestions : [];
            const sIdx = subs.findIndex(s => s && s.id === sub.questionId);
            if (sIdx >= 0) {
              const letter = subs[sIdx].letter || String.fromCharCode(0x05D0 + sIdx);
              qLabel = `שאלה ${i + 1} סעיף ${letter}`;
              break;
            }
          }
        }
      }
    }
  } catch (_) { /* non-fatal */ }
  if (!examLabel) examLabel = sub.examTitle || '';

  _lvrInjectStylesOnce();

  const embedUrl = `https://iframe.mediadelivery.net/embed/${encodeURIComponent(sub.libraryId)}/${encodeURIComponent(sub.videoGuid)}?autoplay=false`;
  const chapters = Array.isArray(sub.chapters) ? sub.chapters : [];
  const headerSub = [examLabel, qLabel].filter(Boolean).join(' — ') || 'סרטון להסבר שאלה';

  const overlay = document.createElement('div');
  overlay.id = 'lvr-modal';
  overlay.className = 'lvr-overlay';
  overlay.innerHTML = `
    <div class="lvr-card" role="dialog" aria-modal="true" aria-labelledby="lvr-title">
      <header class="lvr-header">
        <div class="lvr-header-icon">🎬</div>
        <div class="lvr-header-text">
          <div class="lvr-eyebrow">סקירת סרטון מהמרצה</div>
          <h2 id="lvr-title" class="lvr-title-text">${esc(headerSub)}</h2>
        </div>
        <button class="lvr-close" aria-label="סגור" onclick="document.getElementById('lvr-modal').remove()">×</button>
      </header>

      <div class="lvr-body">
        <div class="lvr-video-wrap">
          <iframe src="${embedUrl}" loading="lazy"
            allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture"
            allowfullscreen></iframe>
        </div>

        <div class="lvr-meta">
          <span class="lvr-meta-icon">👤</span>
          <span>הועלה ע״י <strong>${esc(sub.uploadedByEmail || sub.uploadedByUid || '')}</strong></span>
        </div>

        ${sub.notes ? `
        <section class="lvr-section">
          <div class="lvr-label"><span class="lvr-label-icon">📝</span><span>הערות המרצה</span></div>
          <div class="lvr-notes-box">${esc(sub.notes)}</div>
        </section>` : ''}

        <section class="lvr-section">
          <div class="lvr-section-head">
            <div class="lvr-label"><span class="lvr-label-icon">📑</span><span>פרקים <span class="lvr-muted">· ניתן לערוך לפני אישור</span></span></div>
            <button type="button" class="lvr-btn lvr-btn-ghost lvr-btn-sm" onclick="_lvrAddChapterRow()">＋ פרק</button>
          </div>
          <div id="lvr-chapters" class="lvr-chapters">
            ${chapters.map(c => `
              <div class="lvr-chap-row">
                <input type="text" class="lvr-chap-time" value="${esc(_lvrFmtTime(c.timeSeconds))}" placeholder="00:00">
                <input type="text" class="lvr-chap-title" value="${esc(c.title || '')}" maxlength="200" placeholder="כותרת הפרק">
                <button type="button" class="lvr-btn lvr-btn-ghost lvr-btn-sm lvr-btn-x"
                  onclick="this.parentElement.remove()" aria-label="הסר פרק">×</button>
              </div>`).join('')}
          </div>
        </section>

        <section class="lvr-section">
          <label class="lvr-label" for="lvr-admin-notes">
            <span class="lvr-label-icon">🛠</span><span>הערות אדמין <span class="lvr-muted">· אופציונלי</span></span>
          </label>
          <textarea id="lvr-admin-notes" rows="2" maxlength="4000" class="lvr-input lvr-textarea"
            placeholder="הערות פנימיות (לא יוצג למרצה או לסטודנטים)"></textarea>
        </section>

        <div id="lvr-error" class="lvr-error" hidden></div>
      </div>

      <footer class="lvr-footer">
        <button class="lvr-btn lvr-btn-ghost" onclick="document.getElementById('lvr-modal').remove()">סגור</button>
        <button class="lvr-btn lvr-btn-danger" id="lvr-reject-btn"
          onclick="_lvrDecide('${esc(submissionId)}','${esc(reportId)}','reject')">
          <span class="lvr-btn-icon">✕</span><span>דחה ומחק</span>
        </button>
        <button class="lvr-btn lvr-btn-primary" id="lvr-approve-btn"
          onclick="_lvrDecide('${esc(submissionId)}','${esc(reportId)}','approve')">
          <span class="lvr-btn-icon">✓</span><span>אשר ופרסם</span>
        </button>
      </footer>
    </div>`;
  document.body.appendChild(overlay);
}

function _lvrInjectStylesOnce() {
  if (document.getElementById('lvr-styles')) return;
  const css = `
    .lvr-overlay {
      position: fixed; inset: 0; background: rgba(15, 23, 42, .65);
      backdrop-filter: blur(4px);
      display: flex; align-items: center; justify-content: center;
      z-index: 10000; padding: 1rem;
      animation: lvrFade .15s ease-out;
    }
    @keyframes lvrFade { from { opacity: 0 } to { opacity: 1 } }
    .lvr-card {
      background: #fff; border-radius: 16px;
      width: 100%; max-width: 820px; max-height: 92vh;
      display: flex; flex-direction: column;
      box-shadow: 0 25px 70px -10px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.05);
      overflow: hidden; direction: rtl;
      animation: lvrPop .18s ease-out;
    }
    @keyframes lvrPop { from { transform: translateY(8px) scale(.98); opacity: 0 } to { transform: none; opacity: 1 } }

    .lvr-header {
      background: linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%);
      padding: 1rem 1.25rem; color: #fff;
      display: flex; align-items: center; gap: .85rem;
    }
    .lvr-header-icon {
      width: 42px; height: 42px; border-radius: 50%;
      background: rgba(255,255,255,.2); display: inline-flex;
      align-items: center; justify-content: center;
      font-size: 1.3rem; flex-shrink: 0;
    }
    .lvr-header-text { flex: 1; min-width: 0; }
    .lvr-eyebrow {
      font-size: .72rem; opacity: .85; letter-spacing: .04em;
      text-transform: uppercase; margin-bottom: .15rem;
    }
    .lvr-title-text {
      margin: 0; font-size: 1.05rem; font-weight: 600; line-height: 1.3;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .lvr-close {
      background: rgba(255,255,255,.15); border: 0; color: #fff;
      width: 32px; height: 32px; border-radius: 50%;
      font-size: 1.3rem; line-height: 1; cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
      transition: background .15s;
    }
    .lvr-close:hover { background: rgba(255,255,255,.3); }

    .lvr-body {
      padding: 1.1rem 1.25rem; overflow-y: auto;
      background: #f8fafc; flex: 1;
      display: flex; flex-direction: column; gap: .9rem;
    }

    .lvr-video-wrap {
      position: relative; padding-top: 56.25%;
      background: #000; border-radius: 12px; overflow: hidden;
      box-shadow: 0 4px 12px rgba(0,0,0,.15);
    }
    .lvr-video-wrap iframe {
      position: absolute; inset: 0; width: 100%; height: 100%; border: 0;
    }

    .lvr-meta {
      display: inline-flex; align-items: center; gap: .4rem;
      font-size: .82rem; color: #475569;
      background: #fff; padding: .45rem .7rem; border-radius: 8px;
      border: 1px solid #e2e8f0; align-self: flex-start;
    }
    .lvr-meta-icon { font-size: .9rem; }

    .lvr-section {
      background: #fff; border: 1px solid #e2e8f0; border-radius: 12px;
      padding: .85rem 1rem;
    }
    .lvr-section-head {
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: .55rem;
    }
    .lvr-label {
      display: inline-flex; align-items: center; gap: .4rem;
      font-weight: 600; font-size: .88rem; color: #1e293b;
    }
    .lvr-label-icon { font-size: 1rem; }
    .lvr-muted { font-weight: 400; color: #94a3b8; font-size: .78rem; }

    .lvr-notes-box {
      background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 8px;
      padding: .6rem .8rem; white-space: pre-wrap; font-size: .88rem;
      color: #334155; line-height: 1.5;
    }

    .lvr-input, .lvr-textarea {
      width: 100%; padding: .55rem .7rem;
      border: 1.5px solid #e2e8f0; border-radius: 8px;
      font: inherit; font-size: .88rem; background: #fff;
      transition: border-color .15s, box-shadow .15s;
      box-sizing: border-box;
    }
    .lvr-input:focus, .lvr-textarea:focus {
      outline: 0; border-color: #3b82f6;
      box-shadow: 0 0 0 3px rgba(59,130,246,.15);
    }
    .lvr-textarea { resize: vertical; min-height: 60px; font-family: inherit; }

    .lvr-chapters { display: flex; flex-direction: column; gap: .4rem; }
    .lvr-chap-row {
      display: grid; grid-template-columns: 90px 1fr auto;
      gap: .4rem; align-items: center;
    }
    .lvr-chap-time {
      padding: .5rem .55rem; font-size: .85rem;
      border: 1.5px solid #e2e8f0; border-radius: 8px;
      text-align: center; font-variant-numeric: tabular-nums;
      background: #fff; box-sizing: border-box;
    }
    .lvr-chap-title {
      padding: .5rem .65rem; font-size: .85rem;
      border: 1.5px solid #e2e8f0; border-radius: 8px;
      background: #fff; box-sizing: border-box;
    }
    .lvr-chap-time:focus, .lvr-chap-title:focus {
      outline: 0; border-color: #3b82f6;
      box-shadow: 0 0 0 3px rgba(59,130,246,.15);
    }

    .lvr-btn {
      display: inline-flex; align-items: center; justify-content: center;
      gap: .35rem; padding: .55rem 1rem; border-radius: 10px;
      font: inherit; font-weight: 600; font-size: .88rem;
      cursor: pointer; border: 1.5px solid transparent; line-height: 1;
      transition: background .15s, color .15s, border-color .15s, transform .1s, opacity .15s, box-shadow .15s;
    }
    .lvr-btn:disabled { opacity: .55; cursor: not-allowed; }
    .lvr-btn:active:not(:disabled) { transform: translateY(1px); }
    .lvr-btn-sm { padding: .35rem .65rem; font-size: .78rem; border-radius: 8px; }
    .lvr-btn-icon { font-size: 1rem; line-height: 1; }

    .lvr-btn-ghost {
      background: #fff; color: #475569; border-color: #e2e8f0;
    }
    .lvr-btn-ghost:hover:not(:disabled) {
      background: #f8fafc; border-color: #cbd5e1;
    }
    .lvr-btn-x {
      color: #ef4444; border-color: #fecaca;
    }
    .lvr-btn-x:hover:not(:disabled) { background: #fef2f2; }

    .lvr-btn-primary {
      background: linear-gradient(135deg, #2563eb 0%, #1e40af 100%);
      color: #fff; border-color: transparent;
      box-shadow: 0 2px 8px rgba(37,99,235,.3);
    }
    .lvr-btn-primary:hover:not(:disabled) {
      box-shadow: 0 4px 14px rgba(37,99,235,.45);
    }

    .lvr-btn-danger {
      background: #fff; color: #b91c1c; border-color: #fca5a5;
    }
    .lvr-btn-danger:hover:not(:disabled) {
      background: #fef2f2; border-color: #f87171;
    }

    .lvr-error {
      background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c;
      padding: .55rem .8rem; border-radius: 8px; font-size: .85rem;
    }

    .lvr-footer {
      padding: .85rem 1.25rem; background: #fff;
      border-top: 1px solid #e2e8f0;
      display: flex; gap: .5rem; justify-content: flex-end; flex-wrap: wrap;
    }

    @media (max-width: 600px) {
      .lvr-card { max-height: 100vh; border-radius: 0; }
      .lvr-chap-row { grid-template-columns: 70px 1fr auto; }
    }
  `;
  const style = document.createElement('style');
  style.id = 'lvr-styles';
  style.textContent = css;
  document.head.appendChild(style);
}

function _lvrAddChapterRow() {
  const wrap = document.getElementById('lvr-chapters');
  if (!wrap) return;
  const row = document.createElement('div');
  row.className = 'lvr-chap-row';
  row.innerHTML = `
    <input type="text" class="lvr-chap-time" placeholder="00:00">
    <input type="text" class="lvr-chap-title" placeholder="כותרת הפרק" maxlength="200">
    <button type="button" class="lvr-btn lvr-btn-ghost lvr-btn-sm lvr-btn-x"
      onclick="this.parentElement.remove()" aria-label="הסר פרק">×</button>`;
  wrap.appendChild(row);
}

async function _lvrDecide(submissionId, reportId, action) {
  const errEl  = document.getElementById('lvr-error');
  const apprBtn = document.getElementById('lvr-approve-btn');
  const rejBtn  = document.getElementById('lvr-reject-btn');

  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }

  let chapters = [];
  if (action === 'approve') {
    try {
      const rows = document.querySelectorAll('#lvr-chapters .lvr-chap-row');
      for (const row of rows) {
        const timeStr = row.querySelector('.lvr-chap-time')?.value || '';
        const title   = (row.querySelector('.lvr-chap-title')?.value || '').trim();
        if (!timeStr && !title) continue;
        const t = _lvrParseTime(timeStr);
        if (!Number.isFinite(t)) throw new Error(`זמן לא תקין: ${timeStr}`);
        if (!title) throw new Error(`כותרת חסרה לפרק בזמן ${timeStr}`);
        chapters.push({ timeSeconds: Math.floor(t), title });
      }
    } catch (e) {
      if (errEl) { errEl.textContent = e.message; errEl.hidden = false; }
      return;
    }
  } else if (action === 'reject') {
    if (!confirm('לדחות את הסרטון? הוא יימחק לצמיתות מ-Bunny.')) return;
  }

  if (apprBtn) apprBtn.disabled = true;
  if (rejBtn)  rejBtn.disabled  = true;

  const adminNotes = (document.getElementById('lvr-admin-notes')?.value || '').trim();

  try {
    const idToken = await firebase.auth().currentUser?.getIdToken();
    const r = await fetch('/.netlify/functions/lecturer-video-approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
      body: JSON.stringify({
        videoGuid: submissionId,
        action,
        adminNotes,
        ...(action === 'approve' ? { chapters } : {}),
      }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || `failed (${r.status})`);
    }

    // Auto-close the report so it leaves the open queue
    if (reportId) {
      try {
        await db.collection('reports').doc(reportId).update({
          status: 'closed',
          closedAt: firebase.firestore.FieldValue.serverTimestamp(),
          closedByEmail: adminUser?.email || '',
          closedNote: action === 'approve' ? 'סרטון אושר ופורסם' : 'סרטון נדחה',
        });
      } catch (_) { /* non-fatal */ }
    }

    toast(action === 'approve' ? '✅ הסרטון פורסם' : '❌ הסרטון נדחה', 'success');
    document.getElementById('lvr-modal')?.remove();
    if (typeof renderReportsSection === 'function') renderReportsSection();
  } catch (e) {
    if (errEl) { errEl.textContent = 'שגיאה: ' + e.message; errEl.hidden = false; }
    if (apprBtn) apprBtn.disabled = false;
    if (rejBtn)  rejBtn.disabled  = false;
  }
}




