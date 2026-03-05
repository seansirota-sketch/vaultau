/* ============================================================
   EXAM BANK  —  course.js  (Firebase edition)
   Requires: firebase-config.js loaded first (via script tag)
   ============================================================ */

/* ── UTILS ─────────────────────────────────────────────────── */
function genId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
}

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
  setTimeout(() => t.remove(), 2500);
}

/* ── APP STATE ──────────────────────────────────────────────── */
let STATE = {
  page:     'home',   // home | course | exam
  courseId: null,
  examId:   null,
  tab:      'exams',  // exams | starred
  fireUser: null,     // Firebase Auth user
  userData: null,     // Firestore user doc { starredQuestions: [] }

  // Local caches to avoid re-fetching
  courses:  null,     // Array<Course>
  exams:    {},       // { [courseId]: Array<Exam> }
};

/* ── BOOTSTRAP ─────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  auth.onAuthStateChanged(async (user) => {
    if (user) {
      STATE.fireUser = user;
      STATE.userData = await fetchUserData(user.uid);
      renderNavbar();
      renderPage();
    } else {
      renderAuth();
    }
  });
});

/* ── LOADING OVERLAY ──────────────────────────────────────── */
function showPageLoader(msg = 'טוען...') {
  let el = document.getElementById('page-loader');
  if (!el) {
    el = document.createElement('div');
    el.id = 'page-loader';
    el.className = 'page-loader';
    el.innerHTML = `<div class="spinner"></div><p id="page-loader-msg">${msg}</p>`;
    document.getElementById('page')?.appendChild(el);
  } else {
    document.getElementById('page-loader-msg').textContent = msg;
    el.style.display = 'flex';
  }
}

function hidePageLoader() {
  const el = document.getElementById('page-loader');
  if (el) el.remove();
}

/* ══════════════════════════════════════════════════════════
   AUTH  (Firebase email/password)
══════════════════════════════════════════════════════════ */

function renderAuth() {
  document.getElementById('app').innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="auth-logo">
          <span class="icon">📚</span>
          <h1>בנק מבחנים</h1>
          <p>כניסה לאוסף המבחנים האישי</p>
        </div>
        <div class="auth-tabs">
          <button class="auth-tab active" onclick="switchTab('login')">כניסה</button>
          <button class="auth-tab" onclick="switchTab('signup')">הרשמה</button>
        </div>
        <div id="auth-err" class="form-error"></div>
        <div id="auth-loading" style="display:none;text-align:center;padding:.5rem 0">
          <div class="spinner" style="width:28px;height:28px;margin:.5rem auto"></div>
        </div>

        <!-- Login form -->
        <div id="f-login">
          <div class="form-group">
            <label>אימייל</label>
            <input id="l-email" type="email" placeholder="your@email.com">
          </div>
          <div class="form-group">
            <label>סיסמה</label>
            <input id="l-pass" type="password" placeholder="••••••">
          </div>
          <button id="login-btn" class="btn btn-primary" style="width:100%;justify-content:center"
            onclick="doLogin()">כניסה ←</button>
        </div>

        <!-- Signup form -->
        <div id="f-signup" style="display:none">
          <div class="form-group">
            <label>שם מלא</label>
            <input id="s-name" type="text" placeholder="ישראל ישראלי">
          </div>
          <div class="form-group">
            <label>אימייל</label>
            <input id="s-email" type="email" placeholder="your@email.com">
          </div>
          <div class="form-group">
            <label>סיסמה</label>
            <input id="s-pass" type="password" placeholder="לפחות 6 תווים">
          </div>
          <button id="signup-btn" class="btn btn-primary" style="width:100%;justify-content:center"
            onclick="doSignup()">הרשמה ←</button>
        </div>
      </div>
    </div>`;

  document.getElementById('l-pass')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') doLogin();
  });
  document.getElementById('s-pass')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') doSignup();
  });
}

function switchTab(t) {
  document.querySelectorAll('.auth-tab').forEach((el, i) =>
    el.classList.toggle('active', (i === 0) === (t === 'login'))
  );
  document.getElementById('f-login').style.display  = t === 'login'  ? 'block' : 'none';
  document.getElementById('f-signup').style.display = t === 'signup' ? 'block' : 'none';
  document.getElementById('auth-err').classList.remove('show');
}

function authErr(msg) {
  const e = document.getElementById('auth-err');
  if (!e) return;
  e.textContent = msg;
  e.classList.add('show');
}

function authBusy(busy) {
  document.getElementById('auth-loading').style.display = busy ? 'block' : 'none';
  const lb = document.getElementById('login-btn');
  const sb = document.getElementById('signup-btn');
  if (lb) lb.disabled = busy;
  if (sb) sb.disabled = busy;
}

async function doLogin() {
  const email = document.getElementById('l-email').value.trim();
  const pass  = document.getElementById('l-pass').value;
  if (!email || !pass) return authErr('נא למלא את כל השדות');
  authBusy(true);
  try {
    await auth.signInWithEmailAndPassword(email, pass);
    // onAuthStateChanged will handle the rest
  } catch (e) {
    const messages = {
      'auth/user-not-found':     'אימייל לא קיים במערכת',
      'auth/wrong-password':     'סיסמה שגויה',
      'auth/invalid-email':      'פורמט אימייל לא תקין',
      'auth/too-many-requests':  'יותר מדי ניסיונות — נסה שוב מאוחר יותר',
    };
    authErr(messages[e.code] || 'שגיאת התחברות: ' + e.message);
    authBusy(false);
  }
}

async function doSignup() {
  const name  = document.getElementById('s-name').value.trim();
  const email = document.getElementById('s-email').value.trim();
  const pass  = document.getElementById('s-pass').value;
  if (!name || !email || !pass) return authErr('נא למלא את כל השדות');
  if (pass.length < 6) return authErr('סיסמה חייבת להכיל לפחות 6 תווים');
  authBusy(true);
  try {
    const cred = await auth.createUserWithEmailAndPassword(email, pass);
    await cred.user.updateProfile({ displayName: name });

    // Create user doc in Firestore
    await saveUserData(cred.user.uid, {
      uid:              cred.user.uid,
      displayName:      name,
      email:            email,
      starredQuestions: [],
      createdAt:        firebase.firestore.FieldValue.serverTimestamp(),
    });
    // onAuthStateChanged will handle the rest
  } catch (e) {
    const messages = {
      'auth/email-already-in-use': 'אימייל כבר קיים במערכת',
      'auth/invalid-email':        'פורמט אימייל לא תקין',
      'auth/weak-password':        'הסיסמה חלשה מדי',
    };
    authErr(messages[e.code] || 'שגיאת הרשמה: ' + e.message);
    authBusy(false);
  }
}

async function doLogout() {
  await auth.signOut();
  STATE = { page: 'home', courseId: null, examId: null, tab: 'exams',
            fireUser: null, userData: null, courses: null, exams: {} };
  renderAuth();
}

/* ── NAVBAR ─────────────────────────────────────────────────── */
function renderNavbar() {
  const displayName = STATE.fireUser?.displayName ||
    STATE.fireUser?.email?.split('@')[0] || 'משתמש';

  document.getElementById('app').innerHTML = `
    <nav class="navbar">
      <span class="navbar-brand" onclick="goHome()">
        <span class="ni">📚</span> בנק מבחנים
      </span>
      <div class="navbar-actions">
        <div class="navbar-user">
          <div class="av">${displayName[0].toUpperCase()}</div>
          <span>${esc(displayName)}</span>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="doLogout()">יציאה</button>
      </div>
    </nav>
    <div id="page"></div>
    <div class="toast-wrap" id="toast-wrap"></div>
    <div class="copy-tip" id="copy-tip">הועתק!</div>`;
}

/* ── ROUTING ─────────────────────────────────────────────────── */
function renderPage() {
  if (STATE.page === 'home')   renderHome();
  else if (STATE.page === 'course') renderCourse();
  else if (STATE.page === 'exam')   renderExam();
}

async function goHome() {
  STATE.page = 'home';
  STATE.courseId = null;
  STATE.examId   = null;
  await renderHome();
}

async function goCourse(id) {
  STATE.page     = 'course';
  STATE.courseId = id;
  STATE.examId   = null;
  STATE.tab      = 'exams';
  await renderCourse();
}

async function goExam(cId, eId) {
  STATE.page     = 'exam';
  STATE.courseId = cId;
  STATE.examId   = eId;
  await renderExam();
}

/* ══════════════════════════════════════════════════════════
   HOME
══════════════════════════════════════════════════════════ */

async function renderHome() {
  const page = document.getElementById('page');
  page.innerHTML = `<div class="container"><div class="spinner" style="margin-top:3rem"></div></div>`;

  try {
    if (!STATE.courses) STATE.courses = await fetchCourses();
    const courses = STATE.courses;

    if (!courses.length) {
      page.innerHTML = `<div class="container">
        <div class="empty" style="margin-top:4rem">
          <span class="ei">📭</span>
          <h3>אין קורסים עדיין</h3>
          <p>המנהל טרם הוסיף קורסים למערכת</p>
        </div></div>`;
      return;
    }

    page.innerHTML = `<div class="container">
      <div class="page-header">
        <div>
          <h1 class="page-title">הקורסים שלי</h1>
          <p class="page-sub">בחר קורס לצפייה במבחנים</p>
        </div>
      </div>
      <div class="courses-grid">
        ${courses.map(c => `
          <div class="course-card" onclick="goCourse('${c.id}')">
            <span class="ci">${esc(c.icon || '📚')}</span>
            <div class="cn">${esc(c.name)}</div>
            <div class="cc">${esc(c.code)}</div>
            <div class="cm">לחץ לצפייה במבחנים</div>
          </div>`).join('')}
      </div></div>`;
  } catch (e) {
    page.innerHTML = `<div class="container">
      <div class="empty" style="margin-top:4rem">
        <span class="ei">⚠️</span>
        <h3>שגיאת טעינה</h3>
        <p>${esc(e.message)}</p>
        <button class="btn btn-primary" style="margin-top:1rem" onclick="renderHome()">נסה שוב</button>
      </div></div>`;
  }
}

/* ══════════════════════════════════════════════════════════
   COURSE PAGE
══════════════════════════════════════════════════════════ */

async function renderCourse() {
  const page = document.getElementById('page');
  page.innerHTML = `<div class="container"><div class="spinner" style="margin-top:3rem"></div></div>`;

  try {
    if (!STATE.courses) STATE.courses = await fetchCourses();
    const course = STATE.courses.find(c => c.id === STATE.courseId);
    if (!course) return goHome();

    // Fetch exams (with cache)
    if (!STATE.exams[STATE.courseId]) {
      STATE.exams[STATE.courseId] = await fetchExamsForCourse(STATE.courseId);
    }
    const exams = STATE.exams[STATE.courseId];

    // Refresh user data (starred)
    STATE.userData = await fetchUserData(STATE.fireUser.uid);
    const starred  = STATE.userData?.starredQuestions || [];

    const years     = [...new Set(exams.map(e => e.year).filter(Boolean))].sort((a, b) => b - a);
    const semesters = [...new Set(exams.map(e => e.semester).filter(Boolean))];
    const moeds     = [...new Set(exams.map(e => e.moed).filter(Boolean))];
    const lecturers = [...new Set(exams.map(e => e.lecturer).filter(Boolean))];
    const starCount = countStarred(exams, starred);

    page.innerHTML = `
      <div class="container">
        <div class="breadcrumb">
          <a onclick="goHome()">🏠 ראשי</a><span>›</span><span>${esc(course.name)}</span>
        </div>
        <div class="page-header">
          <div>
            <h1 class="page-title">${esc(course.icon)} ${esc(course.name)}</h1>
            <p class="page-sub">קוד: ${esc(course.code)} · ${exams.length} מבחנים</p>
          </div>
        </div>
        <div class="tabs-bar">
          <button class="tab-btn ${STATE.tab === 'exams' ? 'active' : ''}" onclick="setTab('exams')">
            📋 כל המבחנים
          </button>
          <button class="tab-btn ${STATE.tab === 'starred' ? 'active' : ''}" onclick="setTab('starred')">
            שאלות מסומנות
            ${starCount ? `<span class="badge">${starCount}</span>` : ''}
          </button>
        </div>
        <div id="tab-content"></div>
      </div>`;

    if (STATE.tab === 'starred') renderStarredTab(exams, starred);
    else renderExamsTab(course, exams, years, semesters, moeds, lecturers);

  } catch (e) {
    page.innerHTML = `<div class="container">
      <div class="empty" style="margin-top:4rem">
        <span class="ei">⚠️</span><h3>שגיאת טעינה</h3>
        <p>${esc(e.message)}</p>
        <button class="btn btn-primary" style="margin-top:1rem" onclick="renderCourse()">נסה שוב</button>
      </div></div>`;
  }
}

function countStarred(exams, starred) {
  let n = 0;
  exams.forEach(e => (e.questions || []).forEach(q => {
    if (starred.includes(q.id)) n++;
    (q.subs || []).forEach(s => { if (starred.includes(s.id)) n++; });
  }));
  return n;
}

function setTab(t) { STATE.tab = t; renderCourse(); }

function renderExamsTab(course, exams, years, sems, moeds, lecturers) {
  const tc = document.getElementById('tab-content');
  const opts = arr => arr.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');

  tc.innerHTML = `
    <div class="filters-bar">
      <div class="form-group">
        <label>שנה</label>
        <select id="f-y" onchange="applyFilters()"><option value="">הכל</option>${opts(years)}</select>
      </div>
      <div class="form-group">
        <label>סמסטר</label>
        <select id="f-s" onchange="applyFilters()"><option value="">הכל</option>${opts(sems)}</select>
      </div>
      <div class="form-group">
        <label>מועד</label>
        <select id="f-m" onchange="applyFilters()"><option value="">הכל</option>${opts(moeds)}</select>
      </div>
      ${lecturers.length ? `<div class="form-group">
        <label>מרצה</label>
        <select id="f-l" onchange="applyFilters()"><option value="">הכל</option>${opts(lecturers)}</select>
      </div>` : ''}
      <button class="btn btn-secondary btn-sm" onclick="resetFilters()">🔄 אפס</button>
    </div>
    <div class="exam-list" id="exam-list"></div>`;

  applyFilters();
}

function applyFilters() {
  const exams = STATE.exams[STATE.courseId] || [];
  const fy = document.getElementById('f-y')?.value || '';
  const fs = document.getElementById('f-s')?.value || '';
  const fm = document.getElementById('f-m')?.value || '';
  const fl = document.getElementById('f-l')?.value || '';

  let filtered = exams;
  if (fy) filtered = filtered.filter(e => String(e.year) === fy);
  if (fs) filtered = filtered.filter(e => e.semester === fs);
  if (fm) filtered = filtered.filter(e => e.moed === fm);
  if (fl) filtered = filtered.filter(e => e.lecturer === fl);

  const el = document.getElementById('exam-list');
  if (!el) return;

  if (!filtered.length) {
    el.innerHTML = '<div class="empty"><h3>לא נמצאו מבחנים</h3><p>נסה לשנות את הפילטרים</p></div>';
    return;
  }

  el.innerHTML = filtered.map(e => `
    <div class="exam-item" onclick="goExam('${STATE.courseId}','${e.id}')">
      <div style="flex:1">
        <div class="exam-title">${esc(e.title || e.id)}</div>
        <div class="exam-meta-row">
          ${e.year     ? `<span class="badge">${e.year}</span>` : ''}
          ${e.semester ? `<span class="badge">סמסטר ${esc(e.semester)}</span>` : ''}
          ${e.moed     ? `<span class="badge">מועד ${esc(e.moed)}</span>` : ''}
          ${e.lecturer ? `<span class="badge">${esc(e.lecturer)}</span>` : ''}
          <span class="badge">${(e.questions || []).length} שאלות</span>
        </div>
      </div>
      <span class="exam-arrow">←</span>
    </div>`).join('');
}

function resetFilters() {
  ['f-y', 'f-s', 'f-m', 'f-l'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  applyFilters();
}

/* ── Starred tab ─────────────────────────────────────────── */
function renderStarredTab(exams, starred) {
  const tc    = document.getElementById('tab-content');
  const items = [];

  exams.forEach(exam => {
    (exam.questions || []).forEach((q, qi) => {
      if (starred.includes(q.id)) {
        items.push({ type: 'q', q, qi, examTitle: exam.title || exam.id, examId: exam.id });
      }
      (q.subs || []).forEach((s, si) => {
        if (starred.includes(s.id)) {
          items.push({ type: 's', q, qi, s, si, examTitle: exam.title || exam.id, examId: exam.id });
        }
      });
    });
  });

  if (!items.length) {
    tc.innerHTML = '<div class="empty"><h3>אין שאלות מסומנות</h3><p>סמן שאלות בתוך המבחנים</p></div>';
    return;
  }

  const starSVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="#f59e0b" stroke="#f59e0b" stroke-width="2">
    <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>`;
  const copySVG = `<svg width="15" height="15" viewBox="0 0 16 16" fill="#9ca3af">
    <path d="M4 1.5H3a2 2 0 0 0-2 2V14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V3.5a2 2 0 0 0-2-2h-1v1h1a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1h1v-1z"/>
    <path d="M9.5 1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5h3zm-3-1A1.5 1.5 0 0 0 5 1.5v1A1.5 1.5 0 0 0 6.5 4h3A1.5 1.5 0 0 0 11 2.5v-1A1.5 1.5 0 0 0 9.5 0h-3z"/></svg>`;

  tc.innerHTML = items.map((it) => {
    const isQ    = it.type === 'q';
    const itemId = isQ ? it.q.id : it.s.id;
    const rawText = isQ ? (it.q.text || '') : (it.s.text || '');
    const copyId = 'copy-starred-' + itemId;
    COPY_MAP.set(copyId, rawText);
    const label = isQ
      ? `שאלה ${it.qi + 1}`
      : `שאלה ${it.qi + 1} · ${esc(it.s.label || '')}`;

    return `<div class="qv-card" id="sc-${itemId}">
      <div class="qv-head">
        <div class="qv-head-right">
          <span class="qv-num">${label}</span>
          <span style="font-size:.78rem;color:var(--muted)">📄 ${esc(it.examTitle)}</span>
        </div>
        <div class="qv-actions">
          <button class="qv-btn on" id="${isQ ? 'qb-' + it.q.id : 'sb-' + it.s.id}"
            onclick="toggleStar('${itemId}')" title="הסר סימון">${starSVG}</button>
          <button class="qv-btn" onclick="copyById('${copyId}',event)" title="העתק LaTeX">${copySVG}</button>
        </div>
      </div>
      <div class="qv-text"></div>
    </div>`;
  }).join('');

  items.forEach(it => {
    const isQ    = it.type === 'q';
    const itemId = isQ ? it.q.id : it.s.id;
    const el = tc.querySelector(`#sc-${itemId} .qv-text`);
    if (el) el.innerHTML = isQ ? (it.q.text || '') : (it.s.text || '');
  });

  if (window.MathJax) MathJax.typesetPromise([tc]);
}

/* ══════════════════════════════════════════════════════════
   EXAM VIEWER
══════════════════════════════════════════════════════════ */

async function renderExam() {
  const page = document.getElementById('page');
  page.innerHTML = `<div class="container"><div class="spinner" style="margin-top:3rem"></div></div>`;

  try {
    if (!STATE.courses) STATE.courses = await fetchCourses();
    const course = STATE.courses.find(c => c.id === STATE.courseId);
    if (!course) return goHome();

    const exam = await fetchExam(STATE.examId);
    if (!exam) return goCourse(STATE.courseId);

    STATE.userData = await fetchUserData(STATE.fireUser.uid);
    const starred   = STATE.userData?.starredQuestions || [];
    const questions = exam.questions || [];

    const metaParts = [
      exam.year,
      exam.semester ? 'סמסטר ' + exam.semester : '',
      exam.moed     ? 'מועד '     + exam.moed     : ''
    ].filter(Boolean);
    const metaLine  = metaParts.join(' • ');
    const examTitle = exam.title || exam.id || '';

    page.innerHTML = `
      <div class="ev-wrap">
        <div class="ev-topbar">
          <button class="ev-back" onclick="goCourse('${course.id}')">← חזרה</button>
          <div class="ev-topbar-meta">
            ${exam.lecturer ? `<span>${esc(exam.lecturer)}</span>` : ''}
          </div>
        </div>

        <div class="ev-banner">
          <h1 class="ev-banner-title">${esc(examTitle)}</h1>
          ${metaLine ? `<p class="ev-banner-meta">${esc(metaLine)}</p>` : ''}
        </div>

        <div class="ev-body" id="ev-questions-body">
          ${!questions.length
            ? `<div class="empty"><h3>אין שאלות עדיין</h3></div>`
            : questions.map((q, qi) => renderQuestionCard(q, qi, starred)).join('')}
        </div>
      </div>`;

    // Set text via innerHTML after DOM is built (safe for LaTeX/HTML)
    questions.forEach(q => {
      const subs   = q.subs || q.parts || [];
      const textEl = page.querySelector(`#qc-${q.id} .qv-text`);
      if (textEl) textEl.innerHTML = q.text || '';
      subs.forEach(s => {
        const subEl = page.querySelector(`#si-${s.id} .qv-part-text`);
        if (subEl) subEl.innerHTML = s.text || '';
      });
    });

    if (window.MathJax) MathJax.typesetPromise([page]);

  } catch (e) {
    page.innerHTML = `<div class="container">
      <div class="empty" style="margin-top:4rem">
        <span class="ei">⚠️</span><h3>שגיאת טעינה</h3>
        <p>${esc(e.message)}</p>
        <button class="btn btn-primary" style="margin-top:1rem" onclick="renderExam()">נסה שוב</button>
      </div></div>`;
  }
}

function renderQuestionCard(q, qi, starred) {
  const isStarredQ = starred.includes(q.id);
  const subs       = q.subs || q.parts || [];
  const hasSubs    = subs.length > 0;
  const qText      = q.text || '';
  const qCopyId    = 'copy-q-' + q.id;
  COPY_MAP.set(qCopyId, qText);

  const starSVG = (on) => `<svg width="18" height="18" viewBox="0 0 24 24"
    fill="${on ? '#f59e0b' : 'none'}" stroke="${on ? '#f59e0b' : '#9ca3af'}" stroke-width="2">
    <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>`;
  const copySVG = `<svg width="15" height="15" viewBox="0 0 16 16" fill="#9ca3af">
    <path d="M4 1.5H3a2 2 0 0 0-2 2V14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V3.5a2 2 0 0 0-2-2h-1v1h1a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1h1v-1z"/>
    <path d="M9.5 1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5h3zm-3-1A1.5 1.5 0 0 0 5 1.5v1A1.5 1.5 0 0 0 6.5 4h3A1.5 1.5 0 0 0 11 2.5v-1A1.5 1.5 0 0 0 9.5 0h-3z"/></svg>`;

  const points = q.points ? `<span class="qv-pts">(${q.points} נקודות)</span>` : '';

  let partsHtml = '';
  if (hasSubs) {
    partsHtml = subs.map((s, si) => {
      const isStarredP = starred.includes(s.id);
      const rawLabel   = s.label || (s.letter ? '(' + s.letter + ')' : '(' + String.fromCharCode(0x05D0 + si) + ')');
      const sText      = s.text || '';
      const sCopyId    = 'copy-s-' + s.id;
      COPY_MAP.set(sCopyId, sText);
      return `<div class="qv-part" id="si-${s.id}">
        <div class="qv-part-head">
          <span class="qv-part-lbl">${rawLabel}</span>
          <div class="qv-actions">
            <button class="qv-btn ${isStarredP ? 'on' : ''}" id="sb-${s.id}"
              onclick="toggleStar('${s.id}')" title="סמן">${starSVG(isStarredP)}</button>
            <button class="qv-btn" onclick="copyById('${sCopyId}',event)" title="העתק LaTeX">${copySVG}</button>
          </div>
        </div>
        <div class="qv-part-text"></div>
      </div>`;
    }).join('');
    partsHtml = `<div class="qv-parts">${partsHtml}</div>`;
  }

  return `<div class="qv-card" id="qc-${q.id}">
    <div class="qv-head">
      <div class="qv-head-right">
        <span class="qv-num">שאלה ${qi + 1}</span>
        ${points}
      </div>
      <div class="qv-actions">
        <button class="qv-btn ${isStarredQ ? 'on' : ''}" id="qb-${q.id}"
          onclick="toggleStar('${q.id}')" title="סמן שאלה">${starSVG(isStarredQ)}</button>
        <button class="qv-btn" onclick="copyById('${qCopyId}',event)" title="העתק LaTeX">${copySVG}</button>
      </div>
    </div>
    <div class="qv-text"></div>
    ${partsHtml}
  </div>`;
}

/* ── STAR (sync to Firestore) ───────────────────────────────── */
async function toggleStar(id) {
  const uid     = STATE.fireUser?.uid;
  if (!uid) return;

  const starred = [...(STATE.userData?.starredQuestions || [])];
  const idx     = starred.indexOf(id);
  const adding  = idx === -1;

  if (adding) { starred.push(id); toast('נוסף לשאלות מסומנות', 'info'); }
  else        { starred.splice(idx, 1); toast('הוסר מהמסומנות'); }

  // Optimistic UI update
  STATE.userData = { ...STATE.userData, starredQuestions: starred };

  // Update star button visual
  const btn = document.getElementById('qb-' + id) || document.getElementById('sb-' + id);
  if (btn) {
    btn.classList.toggle('on', adding);
    const svg = btn.querySelector('svg');
    if (svg) {
      svg.setAttribute('fill',   adding ? '#f59e0b' : 'none');
      svg.setAttribute('stroke', adding ? '#f59e0b' : '#9ca3af');
    }
  }

  // Persist to Firestore (non-blocking)
  try {
    await saveUserData(uid, { starredQuestions: starred });
  } catch (e) {
    console.error('Failed to save starred:', e);
    toast('שגיאה בשמירת סימון', 'error');
  }

  // Refresh starred tab if active
  if (STATE.tab === 'starred') {
    const exams = STATE.exams[STATE.courseId] || [];
    renderStarredTab(exams, starred);
  }
}

/* ── COPY ─────────────────────────────────────────────────── */
function htmlToLatex(html) {
  if (!html) return '';
  let s = html.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
       .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

const COPY_MAP = new Map();

function copyById(id, event) {
  const text  = COPY_MAP.get(id) || '';
  const latex = htmlToLatex(text);
  _doCopy(latex, event);
}

function _doCopy(text, event) {
  navigator.clipboard.writeText(text).then(() => {
    const tip = document.getElementById('copy-tip');
    if (tip) {
      tip.style.top      = (event.clientY - 38) + 'px';
      tip.style.left     = (event.clientX - 28) + 'px';
      tip.style.position = 'fixed';
      tip.classList.add('show');
      setTimeout(() => tip.classList.remove('show'), 1400);
    }
    toast('✅ הועתק!', 'info');
  }).catch(() => toast('העתקה נכשלה', 'error'));
}
