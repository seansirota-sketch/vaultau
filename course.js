console.log('✅ course.js LOADED - version with status filter');
function nl2br(html){if(!html)return '';return html.replace(/\n/g,'<br>');}

/**
 * Format question/sub text for display:
 * - Splits at display math ($$...$$  or  \[...\])
 * - Wraps display math in a centered block div
 * - Converts newlines to <br> only in text segments
 * - Trims blank lines immediately adjacent to display math blocks
 */
function formatMathText(text) {
  if (!text) return '';

  // Split preserving the delimiter (display math blocks)
  const DISPLAY_RE = /(\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\])/g;
  const parts = text.split(DISPLAY_RE);

  return parts.map(part => {
    if (part.startsWith('$$') || part.startsWith('\\[')) {
      // Display math — centered block, LTR for MathJax
      return `<div class="math-display">${part}</div>`;
    }
    // Regular text — trim blank lines adjacent to display blocks, then nl2br
    const trimmed = part.replace(/^\s*\n/, '').replace(/\n\s*$/, '');
    return trimmed ? nl2br(trimmed) : '';
  }).join('');
}
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
  examVotes: {},     // { [questionId]: { easy, medium, hard, unsolved } }
  doneExams: [],     // Array<examId> — exams marked as done by user
  inProgressExams: [], // Array<examId> — exams marked as in-progress by user
  savedFilters: {},    // { [courseId]: { fy, fs, fm, fl } } — persists across exam navigation
};

/* ── BOOTSTRAP ─────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  auth.onAuthStateChanged(async (user) => {
    if (user) {
      // Anonymous users shouldn't reach here anymore, but clean up just in case
      if (user.isAnonymous) {
        auth.signOut().catch(() => {});
        return;
      }

      const email = (user.email || '').toLowerCase().trim();

      STATE.fireUser = user;
      // Save user data on first sign-in (display name may have just been set).
      if (!STATE.userData) {
        await saveUserData(user.uid, {
          uid:              user.uid,
          displayName:      user.displayName || '',
          email:            email,
          starredQuestions: [],
          createdAt:        firebase.firestore.FieldValue.serverTimestamp(),
        }).catch(() => {});
      }
      STATE.userData = await fetchUserData(user.uid, user.email);
      STATE.doneExams       = STATE.userData?.doneExams       || [];
      STATE.inProgressExams = STATE.userData?.inProgressExams || [];

      if (typeof gtag === 'function' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
        gtag('config', 'G-SF9W1XBZZK', { user_id: user.uid });
      }

      // ── 1. Terms check ─────────────────────────────────────
      if (!STATE.userData?.acceptedTerms) {
        renderTermsModal();
        return; // block until accepted
      }

      // ── 2. Survey check ────────────────────────────────────
      // Run in background — don't block initial render
      checkAndShowSurvey();

      // ── 3. Normal load ─────────────────────────────────────
      renderNavbar();
      const hs = history.state;
      if (hs && hs.page) {
        STATE.page     = hs.page;
        STATE.courseId = hs.courseId || null;
        STATE.examId   = hs.examId   || null;
      } else {
        history.replaceState({ page: 'home', courseId: null, examId: null }, '');
      }
      renderPage();

    } else {
      renderAuth();
    }
  });

  // Browser Back / Forward
  window.addEventListener('popstate', async (e) => {
    if (!STATE.fireUser) return;
    const hs = e.state || { page: 'home', courseId: null, examId: null };
    STATE.page          = hs.page     || 'home';
    STATE.courseId      = hs.courseId || null;
    STATE.examId        = hs.examId   || null;
    // Guard: if terms not accepted, block navigation and re-show modal
    if (!STATE.userData?.acceptedTerms) {
      document.getElementById('app').innerHTML = '';
      renderTermsModal();
      return;
    }
    renderNavbar();
    renderPage();
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
          <h1>VaultAU</h1>
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
            <div class="pass-wrap">
              <input id="l-pass" type="password" placeholder="••••••">
              <button type="button" class="pass-eye" onclick="togglePassVis('l-pass','l-eye')"
                title="הצג / הסתר סיסמה" id="l-eye" aria-label="הצג סיסמה">
                ${_eyeIcon(false)}
              </button>
            </div>
          </div>
          <button id="login-btn" class="btn btn-primary" style="width:100%;justify-content:center"
            onclick="doLogin()">כניסה ←</button>
        </div>

        <!-- Signup form — Step 1: Details -->
        <div id="f-signup" style="display:none">
          <div id="signup-step1">
            <div class="form-group">
              <label>שם מלא</label>
              <input id="s-name" type="text" placeholder="ישראל ישראלי">
            </div>
            <div class="form-group">
              <label>אימייל אוניברסיטאי</label>
              <input id="s-email" type="email" placeholder="your@mail.tau.ac.il" dir="ltr" style="text-align:left">
              <small style="color:var(--muted);font-size:.78rem;margin-top:4px;display:block">
                ניתן להירשם רק עם מייל @mail.tau.ac.il
              </small>
            </div>
            <div class="form-group">
              <label>סיסמה</label>
              <div class="pass-wrap">
                <input id="s-pass" type="password" placeholder="לפחות 6 תווים">
                <button type="button" class="pass-eye" onclick="togglePassVis('s-pass','s-eye')"
                  title="הצג / הסתר סיסמה" id="s-eye" aria-label="הצג סיסמה">
                  ${_eyeIcon(false)}
                </button>
              </div>
            </div>
            <button id="signup-btn" class="btn btn-primary" style="width:100%;justify-content:center"
              onclick="doSignupStep1()">שלח קוד אימות ←</button>
          </div>

          <!-- Step 2: Verification code -->
          <div id="signup-step2" style="display:none">
            <div style="text-align:center;margin-bottom:1rem">
              <div style="font-size:2.2rem;margin-bottom:.5rem">📧</div>
              <p style="color:var(--muted);font-size:.88rem;line-height:1.6">
                שלחנו קוד אימות בן 6 ספרות למייל<br>
                <strong id="verify-email-display" dir="ltr"></strong>
              </p>
            </div>
            <div class="form-group">
              <label>קוד אימות</label>
              <input id="s-code" type="text" inputmode="numeric" maxlength="6"
                placeholder="000000" dir="ltr" style="text-align:center;font-size:1.4rem;letter-spacing:6px;font-weight:600"
                autocomplete="one-time-code">
            </div>
            <button id="verify-btn" class="btn btn-primary" style="width:100%;justify-content:center"
              onclick="doSignupStep2()">אימות והרשמה ←</button>
            <div style="text-align:center;margin-top:.75rem">
              <button class="btn" style="background:transparent;border:none;color:var(--muted);font-size:.82rem;cursor:pointer;text-decoration:underline"
                id="resend-btn" onclick="doResendCode()">שלח קוד חדש</button>
              <span id="resend-timer" style="font-size:.8rem;color:var(--muted);display:none"></span>
            </div>
            <button class="btn" style="width:100%;justify-content:center;margin-top:.4rem;
                   color:var(--muted);background:transparent;border-color:transparent;font-size:.82rem"
              onclick="backToSignupStep1()">← חזרה</button>
          </div>
        </div>

      </div>
    </div>`;

  document.getElementById('l-pass')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') doLogin();
  });
  document.getElementById('s-pass')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') doSignupStep1();
  });
  document.getElementById('s-code')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') doSignupStep2();
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

/* ── Eye SVG helper ─────────────────────────────────────── */
function _eyeIcon(visible) {
  return visible
    ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
         <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20C6.48 20 2 15 2 12c0-1.13.35-2.18.94-3.06"/>
         <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c5.52 0 10 5 10 8 0 1.22-.4 2.38-1.08 3.4"/>
         <line x1="2" y1="2" x2="22" y2="22"/>
       </svg>`
    : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
         <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
         <circle cx="12" cy="12" r="3"/>
       </svg>`;
}

/* ── Toggle password visibility ──────────────────────────── */
function togglePassVis(inputId, btnId) {
  const inp = document.getElementById(inputId);
  const btn = document.getElementById(btnId);
  if (!inp || !btn) return;
  const showing = inp.type === 'text';
  inp.type = showing ? 'password' : 'text';
  btn.innerHTML = _eyeIcon(!showing);
  btn.setAttribute('aria-label', showing ? 'הצג סיסמה' : 'הסתר סיסמה');
  inp.focus();
}

function authBusy(busy) {
  // Guard: auth-form elements may not exist when we're on the request form page
  const loadEl = document.getElementById('auth-loading');
  if (loadEl) loadEl.style.display = busy ? 'block' : 'none';
  const lb = document.getElementById('login-btn');
  const sb = document.getElementById('signup-btn');
  if (lb) lb.disabled = busy;
  if (sb) sb.disabled = busy;
}

async function doLogin() {
  const email = document.getElementById('l-email').value.trim().toLowerCase();
  const pass  = document.getElementById('l-pass').value;
  if (!email || !pass) return authErr('נא למלא את כל השדות');

  authBusy(true);
  try {
    await auth.signInWithEmailAndPassword(email, pass);
    // onAuthStateChanged will handle the authorized flow
  } catch (e) {
    const messages = {
      'auth/user-not-found':     'אימייל לא קיים במערכת',
      'auth/wrong-password':     'סיסמה שגויה',
      'auth/invalid-email':      'פורמט אימייל לא תקין',
      'auth/too-many-requests':  'יותר מדי ניסיונות — נסה שוב מאוחר יותר',
      'auth/invalid-credential': 'אימייל או סיסמה שגויים',
    };
    authErr(messages[e.code] || 'שגיאת התחברות: ' + e.message);
    authBusy(false);
  }
}

/* ── Email verification state ──────────────────────────── */
const _verifyState = {
  token: null,
  expiresAt: null,
  email: null,
  name: null,
  pass: null,
  resendCooldown: false,
};

const ALLOWED_EMAIL_DOMAIN = 'mail.tau.ac.il';

/* ── Step 1: Validate fields + send verification code ──── */
async function doSignupStep1() {
  const name  = document.getElementById('s-name').value.trim();
  const email = document.getElementById('s-email').value.trim().toLowerCase();
  const pass  = document.getElementById('s-pass').value;

  if (!name || !email || !pass) return authErr('נא למלא את כל השדות');
  if (!email.endsWith('@' + ALLOWED_EMAIL_DOMAIN)) {
    return authErr('ניתן להירשם רק עם מייל @' + ALLOWED_EMAIL_DOMAIN);
  }
  if (pass.length < 6) return authErr('סיסמה חייבת להכיל לפחות 6 תווים');

  // Store for later
  _verifyState.name = name;
  _verifyState.email = email;
  _verifyState.pass = pass;

  authBusy(true);
  try {
    const res = await fetch('/.netlify/functions/send-verification-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();

    if (!res.ok) {
      authErr(data.error || 'שגיאה בשליחת קוד האימות');
      authBusy(false);
      return;
    }

    _verifyState.token     = data.token;
    _verifyState.expiresAt = data.expiresAt;

    // Switch to Step 2
    document.getElementById('signup-step1').style.display = 'none';
    document.getElementById('signup-step2').style.display = 'block';
    document.getElementById('verify-email-display').textContent = email;
    document.getElementById('auth-err').classList.remove('show');
    authBusy(false);

    // Focus code input
    setTimeout(() => document.getElementById('s-code')?.focus(), 100);

    // Start resend cooldown
    _startResendCooldown();

  } catch (err) {
    console.error('send-verification-email error:', err);
    authErr('שגיאה בשליחת קוד האימות. נסה שוב.');
    authBusy(false);
  }
}

/* ── Step 2: Verify code + create account ──────────────── */
async function doSignupStep2() {
  const code = (document.getElementById('s-code')?.value || '').trim();
  if (!code || code.length !== 6) return authErr('נא להזין קוד אימות בן 6 ספרות');

  const verifyBtn = document.getElementById('verify-btn');
  if (verifyBtn) verifyBtn.disabled = true;
  authBusy(true);

  try {
    // Verify the code server-side
    const res = await fetch('/.netlify/functions/verify-email-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email:     _verifyState.email,
        code,
        token:     _verifyState.token,
        expiresAt: _verifyState.expiresAt,
      }),
    });
    const data = await res.json();

    if (!res.ok) {
      authErr(data.error || 'קוד אימות שגוי');
      if (verifyBtn) verifyBtn.disabled = false;
      authBusy(false);
      if (data.expired) {
        // Code expired — go back to step 1
        backToSignupStep1();
        authErr('קוד האימות פג תוקף. נא לשלוח קוד חדש.');
      }
      return;
    }

    // ── Code verified — create the Firebase account ──
    const cred = await auth.createUserWithEmailAndPassword(
      _verifyState.email,
      _verifyState.pass
    );
    await cred.user.updateProfile({ displayName: _verifyState.name });

    // Mark email as verified in user data (Firestore)
    try {
      await db.collection('users').doc(cred.user.uid).set(
        { emailVerified: true },
        { merge: true }
      );
    } catch (_) {}

    // onAuthStateChanged will handle the rest

  } catch (e) {
    const messages = {
      'auth/email-already-in-use': 'אימייל כבר קיים במערכת — נסה להתחבר במקום להירשם',
      'auth/invalid-email':        'פורמט אימייל לא תקין',
      'auth/weak-password':        'הסיסמה חלשה מדי',
    };
    authErr(messages[e.code] || 'שגיאת הרשמה: ' + e.message);
    if (verifyBtn) verifyBtn.disabled = false;
    authBusy(false);
  }
}

/* ── Resend code ───────────────────────────────────────── */
async function doResendCode() {
  if (_verifyState.resendCooldown) return;
  authBusy(true);
  try {
    const res = await fetch('/.netlify/functions/send-verification-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: _verifyState.email }),
    });
    const data = await res.json();
    if (!res.ok) {
      authErr(data.error || 'שגיאה בשליחת קוד חדש');
      authBusy(false);
      return;
    }
    _verifyState.token     = data.token;
    _verifyState.expiresAt = data.expiresAt;
    document.getElementById('s-code').value = '';
    document.getElementById('auth-err').classList.remove('show');
    authBusy(false);
    _startResendCooldown();
  } catch (err) {
    authErr('שגיאה בשליחת קוד חדש');
    authBusy(false);
  }
}

function _startResendCooldown() {
  _verifyState.resendCooldown = true;
  const resendBtn   = document.getElementById('resend-btn');
  const resendTimer = document.getElementById('resend-timer');
  if (resendBtn)   resendBtn.style.display   = 'none';
  if (resendTimer) resendTimer.style.display  = 'inline';

  let seconds = 60;
  const tick = () => {
    if (resendTimer) resendTimer.textContent = `שלח קוד חדש (${seconds}s)`;
    if (seconds <= 0) {
      _verifyState.resendCooldown = false;
      if (resendBtn)   resendBtn.style.display   = 'inline';
      if (resendTimer) resendTimer.style.display  = 'none';
      return;
    }
    seconds--;
    setTimeout(tick, 1000);
  };
  tick();
}

/* ── Back to step 1 ────────────────────────────────────── */
function backToSignupStep1() {
  document.getElementById('signup-step1').style.display = 'block';
  document.getElementById('signup-step2').style.display = 'none';
  document.getElementById('s-code').value = '';
  document.getElementById('auth-err').classList.remove('show');
}

/* ── Legacy doSignup — redirects to step 1 ─────────────── */
async function doSignup() { doSignupStep1(); }

async function doLogout() {
  await auth.signOut();
  STATE = { page: 'home', courseId: null, examId: null, tab: 'exams',
            fireUser: null, userData: null, courses: null, exams: {}, examVotes: {},
            doneExams: [], inProgressExams: [], savedFilters: {} };
  renderAuth();
}

/* ── NAVBAR ─────────────────────────────────────────────────── */
function renderNavbar() {
  const displayName = STATE.fireUser?.displayName ||
    STATE.fireUser?.email?.split('@')[0] || 'משתמש';

  document.getElementById('app').innerHTML = `
    <nav class="navbar">
      <span class="navbar-brand" onclick="goHome()">
        <span class="ni">📚</span> VaultAU
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
function requireTermsAccepted() {
  // Central gate — called before ANY page render.
  // If the user hasn't accepted terms yet, wipe the app and show the modal.
  // Returns true if access is allowed, false if blocked.
  if (!STATE.fireUser) return false;          // not logged in — auth handles this
  if (STATE.userData?.acceptedTerms) return true; // already accepted — allow through
  // Not accepted yet — replace entire app with the terms screen
  document.getElementById('app').innerHTML = '';  // clear navbar first so no content leaks
  renderTermsModal();
  return false;
}

function requireSurveyDone() {
  // If a survey is active and user hasn't completed it, block all navigation.
  if (STATE._surveyPending && STATE.userData?.surveyDone !== true) {
    // Re-show the survey modal if it was somehow closed
    if (!document.getElementById('survey-modal') && STATE._surveyUrl) {
      showSurveyModal(STATE._surveyUrl);
    }
    return false;
  }
  return true;
}

function renderPage() {
  if (!requireTermsAccepted()) return;
  if (!requireSurveyDone())   return;
  if (STATE.page === 'home')        renderHome();
  else if (STATE.page === 'course') renderCourse();
  else if (STATE.page === 'exam')   renderExam();
}

async function goHome() {
  STATE.page = 'home';
  STATE.courseId = null;
  STATE.examId   = null;
  history.pushState({ page: 'home', courseId: null, examId: null }, '');
  await renderHome();
}

async function goCourse(id) {
  STATE.page     = 'course';
  STATE.courseId = id;
  STATE.examId   = null;
  STATE.tab      = 'exams';
  history.pushState({ page: 'course', courseId: id, examId: null }, '');
  await renderCourse();
}

async function goExam(cId, eId) {
  // Snapshot current filter values into STATE before navigating away
  STATE.savedFilters[cId] = {
    fy: document.getElementById('f-y')?.value || '',
    fs: document.getElementById('f-s')?.value || '',
    fm: document.getElementById('f-m')?.value || '',
    fl: document.getElementById('f-l')?.value || '',
  };
  STATE.page     = 'exam';
  STATE.courseId = cId;
  STATE.examId   = eId;
  history.pushState({ page: 'exam', courseId: cId, examId: eId }, '');
  await renderExam();
}

/* ══════════════════════════════════════════════════════════
   TERMS MODAL  (pilot — shown once per user)
══════════════════════════════════════════════════════════ */

function renderTermsModal() {
  document.getElementById('app').innerHTML = `
    <div id="terms-overlay" style="
      position:fixed;inset:0;background:rgba(0,0,0,.6);
      display:flex;align-items:center;justify-content:center;
      z-index:9999;padding:1rem">
      <div style="
        background:#fff;border-radius:16px;max-width:500px;width:100%;
        padding:2rem 2rem 1.5rem;box-shadow:0 20px 60px rgba(0,0,0,.3);
        direction:rtl;text-align:right">

        <div style="text-align:center;margin-bottom:1.2rem">
          <span style="font-size:2.2rem">📜</span>
          <h2 style="margin:.5rem 0 .25rem;font-size:1.2rem;color:#1e293b">הצהרת סטודנט</h2>
          <p style="font-size:.82rem;color:#64748b">יש לקרוא ולאשר לפני שימוש במערכת</p>
        </div>

        <div style="
          background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;
          padding:1rem 1.2rem;font-size:.88rem;line-height:1.8;color:#334155;
          margin-bottom:1.2rem">
          <p style="margin:0 0 .8rem">
            בעת הכניסה לפלטפורמה, אני מצהיר/ה ומאשר/ת את התנאים הבאים:
          </p>
          <ul style="margin:0;padding-right:1.2rem;list-style:disc">
            <li style="margin-bottom:.5rem"><strong>סטטוס אקדמי:</strong> אני סטודנט/ית מן המניין באוניברסיטת תל אביב.</li>
            <li style="margin-bottom:.5rem"><strong>שימוש אישי:</strong> התכנים במאגר (מבחנים, פתרונות וסיכומים) מיועדים ללמידה אישית בלבד.</li>
            <li style="margin-bottom:.5rem"><strong>זכויות יוצרים:</strong> ידוע לי כי החומרים מוגנים בזכויות יוצרים. אני מתחייב/ת שלא להפיץ, לפרסם, לשתף או למסחר אותם בשום פלטפורמה חיצונית או רשת חברתית.</li>
            <li><strong>יושרה אקדמית:</strong> השימוש בחומרים ייעשה בהתאם לתקנון האוניברסיטה.</li>
          </ul>
        </div>

        <!-- Checkbox confirmation -->
        <label class="terms-check-label" id="terms-check-label">
          <input type="checkbox" id="terms-check" onchange="onTermsCheckChange()">
          <span class="terms-check-text">
            קראתי, הבנתי ואני מסכים/ה לתנאים המפורטים לעיל
          </span>
        </label>

        <button id="terms-accept-btn" class="btn btn-primary"
          style="width:100%;justify-content:center;font-size:.95rem;padding:.75rem;margin-top:1rem"
          disabled
          onclick="acceptTerms()">
          אני מאשר/ת ומתחייב/ת ✓
        </button>

        <p style="text-align:center;font-size:.75rem;color:#94a3b8;margin-top:.9rem">
          הצהרה זו נשמרת ואינה תופיע שוב
        </p>
      </div>
    </div>`;
}

function onTermsCheckChange() {
  const cb  = document.getElementById('terms-check');
  const btn = document.getElementById('terms-accept-btn');
  const lbl = document.getElementById('terms-check-label');
  if (!cb || !btn) return;
  btn.disabled = !cb.checked;
  if (lbl) lbl.classList.toggle('terms-check-label--checked', cb.checked);
}

async function acceptTerms() {
  // Double-check the checkbox — never trust only the button's disabled state
  const cb  = document.getElementById('terms-check');
  if (!cb?.checked) {
    document.getElementById('terms-check-label')?.classList.add('terms-check-label--error');
    setTimeout(() => document.getElementById('terms-check-label')?.classList.remove('terms-check-label--error'), 1200);
    return;
  }

  const btn = document.getElementById('terms-accept-btn');
  if (btn) { btn.disabled = true; btn.textContent = '💾 שומר...'; }

  try {
    const uid = STATE.fireUser?.uid;
    if (!uid) throw new Error('לא מחובר');

    const now = firebase.firestore.Timestamp.now();
    await saveUserData(uid, {
      acceptedTerms:   true,
      acceptedTermsAt: now,       // exact timestamp of acceptance
    });
    STATE.userData = { ...STATE.userData, acceptedTerms: true, acceptedTermsAt: now };

    // Continue to normal app load
    renderNavbar();
    history.replaceState({ page: 'home', courseId: null, examId: null }, '');
    renderPage();

  } catch (e) {
    console.error('acceptTerms error:', e);
    if (btn) { btn.disabled = false; btn.textContent = 'אני מאשר/ת ומתחייב/ת ✓'; }
    alert('שגיאה בשמירת האישור: ' + e.message + '\nנסה שוב.');
  }
}

/* ══════════════════════════════════════════════════════════
   HOME
══════════════════════════════════════════════════════════ */

async function renderHome() {
  const page = document.getElementById('page');
  page.innerHTML = `<div class="container"><div class="spinner" style="margin-top:3rem"></div></div>`;

  try {
    // Check if user is admin
    const isAdmin = STATE.userData?.role === 'admin';
    
    // Fetch courses from Firestore with server-side filtering
    let snap;
    if (isAdmin) {
      // Admin sees published + admin-only courses (NOT drafts)
      snap = await db.collection('courses').where('status', 'in', ['published', 'admin']).get();
    } else {
      // Regular user sees only published courses
      snap = await db.collection('courses').where('status', '==', 'published').get();
    }
    
    // Sort by name client-side (avoids need for composite index)
    const courses = snap.docs
      .map(d => ({ ...d.data(), id: d.id }))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    
    console.log('renderHome - courses count:', courses.length);
    
    STATE.courses = courses;

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
        <div class="course-card" onclick="openContactModal()">
          <span class="ci">✉️</span>
          <div class="cn">צור איתנו קשר</div>
          <div class="cc">שתף חוויה · בקש קורס</div>
          <div class="cm">לחץ לפנייה</div>
        </div>
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
    // Check if user is admin
    const isAdmin = STATE.userData?.role === 'admin';
    
    // Fetch the course directly by ID
    const courseDoc = await db.collection('courses').doc(STATE.courseId).get();
    if (!courseDoc.exists) return goHome();
    
    const course = { ...courseDoc.data(), id: courseDoc.id };
    
    // Check access:
    // - draft: no one can access (only visible in admin panel)
    // - admin: only admins can access
    // - published: everyone can access
    if (course.status === 'draft') {
      console.log('renderCourse - access denied, draft course');
      return goHome();
    }
    if (course.status === 'admin' && !isAdmin) {
      console.log('renderCourse - access denied, admin-only course');
      return goHome();
    }

    // Fetch exams (with cache)
    // Always re-fetch exams so pdfUrl and other updates are reflected immediately
    STATE.exams[STATE.courseId] = await fetchExamsForCourse(STATE.courseId);
    const exams = STATE.exams[STATE.courseId];

    // Use cached userData, only fetch if missing
    if (!STATE.userData) {
      STATE.userData = await fetchUserData(STATE.fireUser.uid, STATE.fireUser.email);
      STATE.doneExams = STATE.userData?.doneExams || [];
      STATE.inProgressExams = STATE.userData?.inProgressExams || [];
    }
    const starred  = STATE.userData?.starredQuestions || [];

    const years     = [...new Set(exams.map(e => e.year).filter(Boolean))].sort((a, b) => b - a);
    const semesters = [...new Set(exams.map(e => e.semester).filter(Boolean))];
    const moeds     = [...new Set(exams.map(e => e.moed).filter(Boolean))];
    // Support both 'lecturers' (array, new) and 'lecturer' (string, legacy)
    const lecturers = [...new Set(exams.flatMap(e =>
      Array.isArray(e.lecturers) ? e.lecturers : (e.lecturer ? [e.lecturer] : [])
    ).filter(Boolean))];
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
            ⭐ שאלות מסומנות
            ${starCount ? `<span class="badge b-orange">${starCount}</span>` : ''}
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

  // Restore saved filter values for this course (persisted across exam navigation)
  const saved = STATE.savedFilters[STATE.courseId];
  if (saved) {
    const fy = document.getElementById('f-y'); if (fy) fy.value = saved.fy || '';
    const fs = document.getElementById('f-s'); if (fs) fs.value = saved.fs || '';
    const fm = document.getElementById('f-m'); if (fm) fm.value = saved.fm || '';
    const fl = document.getElementById('f-l'); if (fl) fl.value = saved.fl || '';
  }
  applyFilters();
}

function applyFilters() {
  const exams = STATE.exams[STATE.courseId] || [];
  const fy = document.getElementById('f-y')?.value || '';
  const fs = document.getElementById('f-s')?.value || '';
  const fm = document.getElementById('f-m')?.value || '';
  const fl = document.getElementById('f-l')?.value || '';

  // Persist current filter values so they survive exam navigation
  if (STATE.courseId) {
    STATE.savedFilters[STATE.courseId] = { fy, fs, fm, fl };
  }

  let filtered = exams;
  if (fy) filtered = filtered.filter(e => String(e.year) === fy);
  if (fs) filtered = filtered.filter(e => e.semester === fs);
  if (fm) filtered = filtered.filter(e => e.moed === fm);
  if (fl) filtered = filtered.filter(e => {
    const lecs = Array.isArray(e.lecturers) ? e.lecturers : (e.lecturer ? [e.lecturer] : []);
    return lecs.includes(fl);
  });

  // Sort: numeric prefix first (desc), then lexicographic suffix (asc)
  // e.g. 2025BB > 2025BA > 2025AB > 2025AA, and 2025 > 2024
  filtered = [...filtered].sort((a, b) => {
    const ta = (a.title || a.id || '').toUpperCase();
    const tb = (b.title || b.id || '').toUpperCase();
    const numA = parseInt(ta) || 0;
    const numB = parseInt(tb) || 0;
    if (numB !== numA) return numB - numA;          // higher year first
    return ta.localeCompare(tb, undefined, { numeric: false }); // suffix A-Z
  });

  const el = document.getElementById('exam-list');
  if (!el) return;

  if (!filtered.length) {
    el.innerHTML = '<div class="empty"><span class="ei">🔍</span><h3>לא נמצאו מבחנים</h3><p>נסה לשנות את הפילטרים</p></div>';
    return;
  }

  el.innerHTML = filtered.map(e => {
    const isDone       = STATE.doneExams.includes(e.id);
    const isInProgress = STATE.inProgressExams.includes(e.id);
    const statusClass  = isDone ? 'exam-done' : isInProgress ? 'exam-inprogress' : '';
    return `
    <div class="exam-item ${statusClass}" onclick="goExam('${STATE.courseId}','${e.id}')">
      <div style="flex:1">
        <div class="exam-title">
          ${isDone ? '<span class="done-check" title="בוצע">✓</span> ' : isInProgress ? '<span class="inprogress-check" title="בתהליך">⏳</span> ' : ''}${esc(e.title || e.id)}
        </div>
        <div class="exam-badges">
          ${e.year     ? `<span class="badge b-blue">${e.year}</span>` : ''}
          ${e.semester ? `<span class="badge b-green">${esc(e.semester)}</span>` : ''}
          ${e.moed     ? `<span class="badge b-purple">${esc(e.moed)}</span>` : ''}
          ${(Array.isArray(e.lecturers) ? e.lecturers : (e.lecturer ? [e.lecturer] : [])).map(l =>
            `<span class="badge b-orange">${esc(l)}</span>`).join('')}
          <span class="badge b-gray">${(e.questions || []).length} שאלות</span>
          ${isDone ? '<span class="badge b-done">✓ בוצע</span>' : isInProgress ? '<span class="badge b-inprogress">⏳ בתהליך</span>' : ''}
        </div>
      </div>
      ${e.pdfUrl ? `<a class="pdf-download-btn" href="${e.pdfUrl}" target="_blank" rel="noopener"
        onclick="event.stopPropagation()" title="הורד טופס מבחן">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 3v13M5 16l7 7 7-7"/><line x1="3" y1="22" x2="21" y2="22"/>
        </svg>
      </a>` : ''}
      <button class="inprogress-toggle-btn ${isInProgress ? 'inprogress-active' : ''}"
        onclick="event.stopPropagation(); toggleInProgress('${e.id}')"
        title="${isInProgress ? 'בטל בתהליך' : 'סמן כבתהליך'}">
        ${isInProgress ? '⏳' : '◑'}
      </button>
      <button class="done-toggle-btn ${isDone ? 'done-active' : ''}"
        onclick="event.stopPropagation(); toggleDone('${e.id}')"
        title="${isDone ? 'בטל סימון בוצע' : 'סמן כבוצע'}">
        ${isDone ? '✓' : '○'}
      </button>
      <button class="report-exam-btn"
        onclick="event.stopPropagation(); openReportBugModal('${e.id}','${esc(e.title || e.id)}','${STATE.courseId}')"
        title="דווח על תקלה">
        ⚠
      </button>
      <span class="exam-arrow">←</span>
    </div>`;
  }).join('');
}

function resetFilters() {
  ['f-y', 'f-s', 'f-m', 'f-l'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  if (STATE.courseId) delete STATE.savedFilters[STATE.courseId];
  applyFilters();
}

/* ── DONE EXAM (sync to Firestore) ─────────────────────────── */
async function toggleDone(examId) {
  const uid = STATE.fireUser?.uid;
  if (!uid) return;

  const done    = [...STATE.doneExams];
  const idx     = done.indexOf(examId);
  const adding  = idx === -1;

  if (adding) {
    done.push(examId);
    toast('✅ סומן כבוצע', 'info');
    // הסר מ"בתהליך" אם היה שם
    const ipIdx = STATE.inProgressExams.indexOf(examId);
    if (ipIdx !== -1) {
      const ip = [...STATE.inProgressExams];
      ip.splice(ipIdx, 1);
      STATE.inProgressExams = ip;
      STATE.userData = { ...STATE.userData, inProgressExams: ip };
    }
  } else {
    done.splice(idx, 1);
    toast('הוסר סימון בוצע');
  }

  STATE.doneExams = done;
  if (!STATE.userData) STATE.userData = {};
  STATE.userData = { ...STATE.userData, doneExams: done };

  // completedExams — separate array for admin tracking (only grows, never shrinks)
  const completed = [...(STATE.userData?.completedExams || [])];
  if (adding && !completed.includes(examId)) completed.push(examId);
  STATE.userData = { ...STATE.userData, completedExams: completed };

  applyFilters();

  try {
    await saveUserData(uid, {
      doneExams:      done,
      inProgressExams: STATE.inProgressExams,
      completedExams:  completed,
    });
  } catch (e) {
    console.error('Failed to save doneExams:', e);
    toast('שגיאה בשמירת הסימון', 'error');
  }
}

/* ── IN-PROGRESS EXAM (sync to Firestore) ───────────────────── */
async function toggleInProgress(examId) {
  const uid = STATE.fireUser?.uid;
  if (!uid) return;

  const ip    = [...STATE.inProgressExams];
  const idx   = ip.indexOf(examId);
  const adding = idx === -1;

  if (adding) {
    ip.push(examId);
    toast('⏳ סומן כבתהליך', 'info');
    // הסר מ"בוצע" אם היה שם
    const doneIdx = STATE.doneExams.indexOf(examId);
    if (doneIdx !== -1) {
      const done = [...STATE.doneExams];
      done.splice(doneIdx, 1);
      STATE.doneExams = done;
      STATE.userData = { ...STATE.userData, doneExams: done };
    }
  } else {
    ip.splice(idx, 1);
    toast('הוסר סימון בתהליך');
  }

  STATE.inProgressExams = ip;
  if (!STATE.userData) STATE.userData = {};
  STATE.userData = { ...STATE.userData, inProgressExams: ip };

  applyFilters();

  try {
    await saveUserData(uid, { doneExams: STATE.doneExams, inProgressExams: ip });
  } catch (e) {
    console.error('Failed to save inProgressExams:', e);
    toast('שגיאה בשמירת הסימון', 'error');
  }
}

/* ── Starred tab ─────────────────────────────────────────── */
function renderStarredTab(exams, starred) {
  const tc    = document.getElementById('tab-content');
  const items = [];

  exams.forEach(exam => {
    (exam.questions || []).forEach((q, qi) => {
      if (starred.includes(q.id)) {
        items.push({ q, qi, examTitle: exam.title || exam.id, examId: exam.id });
      }
    });
  });

  if (!items.length) {
    tc.innerHTML = '<div class="empty"><span class="ei">⭐</span><h3>אין שאלות מסומנות</h3><p>סמן שאלות בכוכבית בתוך המבחנים</p></div>';
    return;
  }

  const starSVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="#f59e0b" stroke="#f59e0b" stroke-width="2">
    <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>`;
  const copySVG = `<svg width="15" height="15" viewBox="0 0 16 16" fill="#9ca3af">
    <path d="M4 1.5H3a2 2 0 0 0-2 2V14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V3.5a2 2 0 0 0-2-2h-1v1h1a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1h1v-1z"/>
    <path d="M9.5 1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5h3zm-3-1A1.5 1.5 0 0 0 5 1.5v1A1.5 1.5 0 0 0 6.5 4h3A1.5 1.5 0 0 0 11 2.5v-1A1.5 1.5 0 0 0 9.5 0h-3z"/></svg>`;

  tc.innerHTML = items.map((it) => {
    const { q, qi, examTitle } = it;
    const subs   = q.subs || q.parts || [];
    const copyId = 'copy-starred-' + q.id;
    const fullStarredText = subs.length
      ? [q.text || '', ...subs.map((s, si) => {
          const lbl = s.label || (s.letter ? '(' + s.letter + ')' : '(' + String.fromCharCode(0x05D0 + si) + ')');
          return lbl + ' ' + (s.text || '');
        })].filter(Boolean).join('\n\n')
      : (q.text || '');
    COPY_MAP.set(copyId, fullStarredText);

    const partsHtml = subs.length ? `<div class="qv-parts">${subs.map((s, si) => {
      const rawLabel = s.label || (s.letter ? '(' + s.letter + ')' : '(' + String.fromCharCode(0x05D0 + si) + ')');
      const sCopyId  = 'copy-starred-s-' + s.id;
      COPY_MAP.set(sCopyId, s.text || '');
      return `<div class="qv-part" id="sc-si-${s.id}">
        <div class="qv-part-head">
          <span class="qv-part-lbl">${rawLabel}</span>
          <div class="qv-actions">
            <button class="qv-btn" onclick="copyById('${sCopyId}',event)" title="העתק LaTeX">${copySVG}</button>
          </div>
        </div>
        <div class="qv-part-text"></div>
      </div>`;
    }).join('')}</div>` : '';

    return `<div class="qv-card" id="sc-${q.id}">
      <div class="qv-head">
        <div class="qv-head-right">
          <span class="qv-num">שאלה ${qi + 1}</span>
          <span style="font-size:.78rem;color:var(--muted)">${esc(examTitle)}</span>
        </div>
        <div class="qv-actions">
          <button class="qv-btn on" id="qb-${q.id}"
            onclick="toggleStar('${q.id}')" title="הסר סימון">${starSVG}</button>
          <button class="qv-btn" onclick="copyById('${copyId}',event)" title="העתק LaTeX">${copySVG}</button>
        </div>
      </div>
      <div class="qv-text"></div>
      ${partsHtml}
    </div>`;
  }).join('');

  // Set text content safely
  items.forEach(it => {
    const { q } = it;
    const subs  = q.subs || q.parts || [];
    const qEl   = tc.querySelector(`#sc-${q.id} .qv-text`);
    if (qEl) qEl.innerHTML = formatMathText(q.text || '');
    subs.forEach(s => {
      const sEl = tc.querySelector(`#sc-si-${s.id} .qv-part-text`);
      if (sEl) sEl.innerHTML = formatMathText(s.text || '');
    });
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
    // Check if user is admin
    const isAdmin = STATE.userData?.role === 'admin';
    
    // Fetch the course directly by ID
    const courseDoc = await db.collection('courses').doc(STATE.courseId).get();
    if (!courseDoc.exists) return goHome();
    
    const course = { ...courseDoc.data(), id: courseDoc.id };
    
    // Check access:
    // - draft: no one can access
    // - admin: only admins can access
    // - published: everyone can access
    if (course.status === 'draft') {
      console.log('renderExam - access denied, draft course');
      return goHome();
    }
    if (course.status === 'admin' && !isAdmin) {
      console.log('renderExam - access denied, admin-only course');
      return goHome();
    }

    const exam = await fetchExam(STATE.examId);
    if (!exam) return goCourse(STATE.courseId);

    // GA — exam view start
    if (typeof gtag === 'function') {
      gtag('event', 'exam_view_start', {
        course_id: STATE.courseId,
        exam_id:   STATE.examId,
        exam_title: exam.title || STATE.examId,
      });
    }

    // Fetch userData only if not cached; fetch votes in parallel
    const [_, votes] = await Promise.all([
      STATE.userData ? Promise.resolve() : fetchUserData(STATE.fireUser.uid, STATE.fireUser.email).then(d => { STATE.userData = d; }),
      fetchExamVotes(exam.questions || []),
    ]);
    STATE.examVotes = votes;
    const starred   = STATE.userData?.starredQuestions || [];
    const questions = exam.questions || [];
    const userVotes = STATE.userData?.difficultyVotes || {};

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
            ${(Array.isArray(exam.lecturers) ? exam.lecturers : (exam.lecturer ? [exam.lecturer] : []))
              .map(l => `<span>${esc(l)}</span>`).join('<span class="lec-sep"> · </span>')}
          </div>
        </div>

        <div class="ev-banner">
          <h1 class="ev-banner-title">${esc(examTitle)}</h1>
          ${metaLine ? `<p class="ev-banner-meta">${esc(metaLine)}</p>` : ''}
        </div>

        <div class="ev-body" id="ev-questions-body">
          ${!questions.length
            ? `<div class="empty"><span class="ei">📝</span><h3>אין שאלות עדיין</h3></div>`
            : questions.map((q, qi) => renderQuestionCard(q, qi, starred, userVotes)).join('')}
        </div>
      </div>`;

    // Set text via innerHTML after DOM is built (safe for LaTeX/HTML)
    questions.forEach(q => {
      const subs   = q.subs || q.parts || [];
      const textEl = page.querySelector(`#qc-${q.id} .qv-text`);
      if (textEl) textEl.innerHTML = formatMathText(q.text || '');
      subs.forEach(s => {
        const subEl = page.querySelector(`#si-${s.id} .qv-part-text`);
        if (subEl) subEl.innerHTML = formatMathText(s.text || '');
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

function renderQuestionCard(q, qi, starred, userVotes = {}) {
  const isStarredQ = starred.includes(q.id);
  const isBonus    = q.isBonus === true;
  const subs       = q.subs || q.parts || [];
  const hasSubs    = subs.length > 0;
  const qText      = q.text || '';
  const qCopyId    = 'copy-q-' + q.id;

  // Top copy button copies the full question: stem + all sub-parts
  const fullQText = hasSubs
    ? [qText, ...subs.map((s, si) => {
        const lbl = s.label || (s.letter ? '(' + s.letter + ')' : '(' + String.fromCharCode(0x05D0 + si) + ')');
        return lbl + ' ' + (s.text || '');
      })].filter(Boolean).join('\n\n')
    : qText;
  COPY_MAP.set(qCopyId, fullQText);

  const starSVG = (on) => `<svg width="18" height="18" viewBox="0 0 24 24"
    fill="${on ? '#f59e0b' : 'none'}" stroke="${on ? '#f59e0b' : '#9ca3af'}" stroke-width="2">
    <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>`;
  const copySVG = `<svg width="15" height="15" viewBox="0 0 16 16" fill="#9ca3af">
    <path d="M4 1.5H3a2 2 0 0 0-2 2V14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V3.5a2 2 0 0 0-2-2h-1v1h1a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1h1v-1z"/>
    <path d="M9.5 1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5h3zm-3-1A1.5 1.5 0 0 0 5 1.5v1A1.5 1.5 0 0 0 6.5 4h3A1.5 1.5 0 0 0 11 2.5v-1A1.5 1.5 0 0 0 9.5 0h-3z"/></svg>`;

  const points = q.points ? `<span class="qv-pts">(${q.points} נקודות)</span>` : '';
  const bonusBadge = isBonus
    ? `<span class="qv-bonus-badge">⭐ שאלת בונוס לקבוצות B ו-C</span>`
    : '';

  let partsHtml = '';
  if (hasSubs) {
    partsHtml = subs.map((s, si) => {
      const rawLabel   = s.label || (s.letter ? '(' + s.letter + ')' : '(' + String.fromCharCode(0x05D0 + si) + ')');
      const sText      = s.text || '';
      const sCopyId    = 'copy-s-' + s.id;
      COPY_MAP.set(sCopyId, sText);
      return `<div class="qv-part" id="si-${s.id}">
        <div class="qv-part-head">
          <span class="qv-part-lbl">${rawLabel}</span>
          <div class="qv-actions">
            <button class="qv-btn" onclick="copyById('${sCopyId}',event)" title="העתק LaTeX">${copySVG}</button>
          </div>
        </div>
        <div class="qv-part-text"></div>
      </div>`;
    }).join('');
    partsHtml = `<div class="qv-parts">${partsHtml}</div>`;
  }

  return `<div class="qv-card${isBonus ? ' qv-card-bonus' : ''}" id="qc-${q.id}">
    <div class="qv-head${isBonus ? ' qv-head-bonus' : ''}">
      <div class="qv-head-right">
        <span class="qv-num">${isBonus ? 'שאלת בונוס' : 'שאלה ' + (qi + 1)}</span>
        ${points}
        ${bonusBadge}
      </div>
      <div class="qv-actions" id="dw-${q.id}">
        ${renderDifficultyButtons(q.id, userVotes[q.id] || null)}
        <div class="qv-actions-sep"></div>
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
  const uid = STATE.fireUser?.uid;
  if (!uid) return;

  // Ensure userData is loaded
  if (!STATE.userData) {
    STATE.userData = await fetchUserData(uid, STATE.fireUser?.email);
  }

  const starred = [...(STATE.userData?.starredQuestions || [])];
  const idx     = starred.indexOf(id);
  const adding  = idx === -1;

  if (adding) { starred.push(id); toast('⭐ נוסף לשאלות מסומנות', 'info'); }
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

/* ── DIFFICULTY RATING ──────────────────────────────────────── */
const DIFF_LEVELS = [
  { key: 'easy',     label: 'קל' },
  { key: 'medium',   label: 'בינוני' },
  { key: 'hard',     label: 'קשה' },
  { key: 'unsolved', label: 'לא פתרתי' },
];

function renderDifficultyButtons(qid, myVote) {
  return DIFF_LEVELS.map(l => {
    const active = myVote === l.key;
    return `<button class="diff-btn diff-${l.key}${active ? ' active' : ''}"
      onclick="voteDifficulty('${qid}','${l.key}')"
      title="${l.label}">${l.label}</button>`;
  }).join('');
}

// Keep renderDifficultyWidget as alias for starred tab (not used there anymore but safe)
function renderDifficultyWidget(qid, myVote) { return ''; }

async function fetchExamVotes(questions) {
  const qIds = (questions || []).map(q => q.id).filter(Boolean);
  if (!qIds.length) return {};
  const votes = {};
  for (let i = 0; i < qIds.length; i += 30) {
    try {
      const chunk = qIds.slice(i, i + 30);
      const snap  = await db.collection('questionVotes')
        .where(firebase.firestore.FieldPath.documentId(), 'in', chunk).get();
      snap.docs.forEach(d => { votes[d.id] = d.data(); });
    } catch(e) { console.warn('fetchExamVotes chunk error:', e); }
  }
  return votes;
}

async function voteDifficulty(qid, level) {
  const uid = STATE.fireUser?.uid;
  if (!uid) return;

  const userVotes = { ...(STATE.userData?.difficultyVotes || {}) };
  const prev      = userVotes[qid];

  const localCounts = { ...(STATE.examVotes[qid] || {}) };

  if (prev === level) {
    localCounts[level] = Math.max(0, (localCounts[level] || 0) - 1);
    delete userVotes[qid];
  } else {
    if (prev) localCounts[prev] = Math.max(0, (localCounts[prev] || 0) - 1);
    localCounts[level] = (localCounts[level] || 0) + 1;
    userVotes[qid] = level;
  }

  STATE.examVotes[qid] = localCounts;
  STATE.userData = { ...STATE.userData, difficultyVotes: userVotes };

  // שליחת אירוע ל-Google Analytics
  if (typeof gtag === 'function') {
    gtag('event', 'rate_difficulty', {
      level:   userVotes[qid] || 'removed',
      exam_id: STATE.examId || 'unknown',
    });
  }

  // Re-render just the diff buttons inside the existing dw- container
  const container = document.getElementById('dw-' + qid);
  if (container) {
    container.querySelectorAll('.diff-btn').forEach(b => b.remove());
    const sep = container.querySelector('.qv-actions-sep');
    const newBtns = renderDifficultyButtons(qid, userVotes[qid] || null);
    sep.insertAdjacentHTML('beforebegin', newBtns);
  }

  try {
    const inc = firebase.firestore.FieldValue.increment;
    const updates = {};
    if (prev === level) {
      updates[level] = inc(-1);
    } else {
      if (prev) updates[prev] = inc(-1);
      updates[level] = inc(1);
    }
    await db.collection('questionVotes').doc(qid).set(updates, { merge: true });
    await saveUserData(uid, { difficultyVotes: userVotes });
  } catch(e) {
    console.error('voteDifficulty error:', e);
    toast('שגיאה בשמירת דירוג', 'error');
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
    // GA — copy question
    if (typeof gtag === 'function') {
      gtag('event', 'copy_question', {
        course_id: STATE.courseId || '',
        exam_id:   STATE.examId   || '',
      });
    }
    // Firestore — increment copy counter for this user
    const uid = STATE.fireUser?.uid;
    if (uid) {
      db.collection('users').doc(uid).set(
        { copyCount: firebase.firestore.FieldValue.increment(1) },
        { merge: true }
      ).catch(e => console.warn('copyCount increment failed:', e));
    }
  }).catch(() => toast('העתקה נכשלה', 'error'));
}


/* ══════════════════════════════════════════════════════════
   SURVEY MODAL  (student-facing)
══════════════════════════════════════════════════════════ */

async function checkAndShowSurvey() {
  try {
    // Already filled — skip
    if (STATE.userData?.surveyDone === true) return;

    const doc = await db.collection('settings').doc('global').get();
    if (!doc.exists) return;
    const { isSurveyActive, surveyUrl } = doc.data();
    if (!isSurveyActive || !surveyUrl) return;

    // Mark survey as pending on STATE so renderPage can gate on it
    STATE._surveyPending = true;
    STATE._surveyUrl     = surveyUrl;

    showSurveyModal(surveyUrl);
  } catch(e) {
    console.warn('checkAndShowSurvey error:', e);
  }
}

function showSurveyModal(url) {
  // Remove any existing survey modal first
  document.getElementById('survey-modal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'survey-modal';
  modal.className = 'survey-modal-overlay';
  modal.innerHTML = `
    <div class="survey-modal-box">
      <div class="survey-modal-header">
        <div>
          <h2 class="survey-modal-title">📋 סקר משוב קצר</h2>
          <p class="survey-modal-sub">נשמח לשמוע את דעתך — נדרשות כ-2 דקות בלבד</p>
        </div>
      </div>
      <div class="survey-iframe-wrap">
        <iframe
          src="${url}"
          class="survey-iframe"
          frameborder="0"
          marginheight="0"
          marginwidth="0"
          title="סקר משוב">
          טוען...
        </iframe>
      </div>
      <div class="survey-modal-footer">
        <p class="survey-mandatory-note">
          ⚠️ מילוי הסקר הוא <strong>חובה</strong> — לא ניתן לגשת למבחנים לפני השלמתו
        </p>
        <button class="btn btn-primary" onclick="markSurveyDone()">
          ✅ סיימתי למלא את הסקר
        </button>
      </div>
    </div>`;

  document.body.appendChild(modal);
  // Prevent background scroll
  document.body.style.overflow = 'hidden';
}

async function markSurveyDone() {
  const uid = STATE.fireUser?.uid;
  const btn = document.querySelector('#survey-modal .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = '💾 שומר...'; }

  try {
    if (uid) {
      await saveUserData(uid, { surveyDone: true });
      STATE.userData = { ...STATE.userData, surveyDone: true };
    }
    STATE._surveyPending = false;
    closeSurveyModal();
    toast('תודה על המשוב! 🙏', 'info');
    // Now let the user into the app
    renderNavbar();
    renderPage();
  } catch(e) {
    console.error('markSurveyDone error:', e);
    if (btn) { btn.disabled = false; btn.textContent = '✅ סיימתי למלא את הסקר'; }
    toast('שגיאה בשמירה — נסה שוב', 'error');
  }
}

function closeSurveyModal() {
  document.getElementById('survey-modal')?.remove();
  document.body.style.overflow = '';
}

/* ══════════════════════════════════════════════════════════
   CONTACT US MODAL
══════════════════════════════════════════════════════════ */

const _CONTACT_TYPES = [
  { value: 'experience',    icon: '💬', label: 'שתף חוויה',         placeholder: 'ספר לנו על החוויה שלך...' },
  { value: 'request-course',icon: '📚', label: 'בקש קורס',          placeholder: 'איזה קורס תרצה שנוסיף?' },
  { value: 'request-exam',  icon: '📝', label: 'בקש מבחן',          placeholder: 'איזה מבחן תרצה שנוסיף?' },
  { value: 'other',         icon: '✉️', label: 'אחר',               placeholder: 'כתוב כאן...' },
];

function openContactModal() {
  document.getElementById('contact-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'contact-modal';
  modal.className = 'modal-overlay';
  modal.dataset.contactType = 'experience';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:480px">
      <div class="modal-header">
        <h3 style="margin:0;font-size:1.1rem">✉️ צור איתנו קשר</h3>
        <button class="modal-close" onclick="closeContactModal()">✕</button>
      </div>
      <div style="padding:1.25rem;display:flex;flex-direction:column;gap:1rem">
        <div>
          <label style="font-size:.82rem;font-weight:600;color:var(--muted);display:block;margin-bottom:.45rem">
            נושא הפנייה
          </label>
          <div class="contact-scroll-list" id="contact-scroll-list">
            ${_CONTACT_TYPES.map(t => `
              <div class="contact-scroll-item${t.value === 'experience' ? ' selected' : ''}"
                   onclick="setContactType('${t.value}')" data-value="${t.value}">
                <span class="csi-icon">${t.icon}</span>
                <span>${t.label}</span>
                <span class="csi-radio"></span>
              </div>`).join('')}
          </div>
        </div>
        <div class="form-group" style="margin:0">
          <label id="contact-label">ספר לנו על החוויה שלך</label>
          <textarea id="contact-message" rows="4" dir="rtl"
            placeholder="ספר לנו על החוויה שלך..."
            style="width:100%;border:1.5px solid var(--border);border-radius:8px;
                   padding:.75rem;font-family:inherit;font-size:.9rem;resize:vertical;
                   box-sizing:border-box;color:var(--text)"></textarea>
        </div>
        <div id="contact-err" style="color:var(--danger);font-size:.83rem;display:none"></div>
        <div style="display:flex;justify-content:flex-end;gap:.75rem">
          <button class="btn btn-secondary" onclick="closeContactModal()">ביטול</button>
          <button class="btn btn-primary" id="contact-submit-btn" onclick="submitContactForm()">שלח</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);
  document.body.style.overflow = 'hidden';
  modal.addEventListener('click', e => { if (e.target === modal) closeContactModal(); });
}

function setContactType(value) {
  const modal = document.getElementById('contact-modal');
  if (!modal) return;
  modal.dataset.contactType = value;
  modal.querySelectorAll('.contact-scroll-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.value === value);
  });
  const t = _CONTACT_TYPES.find(t => t.value === value);
  const label = document.getElementById('contact-label');
  const ta    = document.getElementById('contact-message');
  if (label && t) label.textContent = t.label;
  if (ta    && t) ta.placeholder    = t.placeholder;
}

async function submitContactForm() {
  const msgEl = document.getElementById('contact-message');
  const errEl = document.getElementById('contact-err');
  const btn   = document.getElementById('contact-submit-btn');
  const modal = document.getElementById('contact-modal');
  const type  = modal?.dataset.contactType || 'experience';
  const msg   = msgEl?.value.trim();

  if (!msg) {
    if (errEl) { errEl.textContent = 'אנא כתוב הודעה לפני השליחה'; errEl.style.display = 'block'; }
    return;
  }
  if (errEl) errEl.style.display = 'none';
  if (btn) { btn.disabled = true; btn.textContent = 'שולח...'; }

  try {
    const typeObj = _CONTACT_TYPES.find(t => t.value === type);
    await db.collection('reports').add({
      category:  'contact',
      type:      type,
      typeLabel: typeObj?.label || type,
      message:   msg,
      userId:    STATE.fireUser?.uid   || '',
      userEmail: STATE.fireUser?.email || '',
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      status:    'open',
    });
    closeContactModal();
    toast('תודה על הפנייה! 🙏', 'info');
  } catch(e) {
    if (btn) { btn.disabled = false; btn.textContent = 'שלח'; }
    if (errEl) { errEl.textContent = 'שגיאה בשליחה — נסה שוב'; errEl.style.display = 'block'; }
  }
}

function closeContactModal() {
  document.getElementById('contact-modal')?.remove();
  document.body.style.overflow = '';
}

/* ══════════════════════════════════════════════════════════
   REPORT BUG MODAL (per exam)
══════════════════════════════════════════════════════════ */

function openReportBugModal(examId, examTitle, courseId) {
  document.getElementById('report-bug-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'report-bug-modal';
  modal.className = 'modal-overlay';
  modal.dataset.examId    = examId;
  modal.dataset.examTitle = examTitle;
  modal.dataset.courseId  = courseId;
  modal.innerHTML = `
    <div class="modal-card" style="max-width:460px">
      <div class="modal-header">
        <h3 style="margin:0;font-size:1.1rem">⚠ דווח על תקלה</h3>
        <button class="modal-close" onclick="closeReportBugModal()">✕</button>
      </div>
      <div style="padding:1.25rem;display:flex;flex-direction:column;gap:1rem">
        <div style="background:var(--bg2,#f9fafb);border-radius:8px;padding:.65rem .9rem;
                    font-size:.85rem;color:var(--muted);border:1px solid var(--border)">
          מבחן: <strong>${esc(examTitle)}</strong>
        </div>
        <div class="form-group" style="margin:0">
          <label>תאר את התקלה</label>
          <textarea id="report-bug-message" rows="4" dir="rtl"
            placeholder="למשל: שאלה 3 חסרה, PDF לא נפתח, תשובה שגויה..."
            style="width:100%;border:1.5px solid var(--border);border-radius:8px;
                   padding:.75rem;font-family:inherit;font-size:.9rem;resize:vertical;
                   box-sizing:border-box;color:var(--text)"></textarea>
        </div>
        <div id="report-bug-err" style="color:var(--danger);font-size:.83rem;display:none"></div>
        <div style="display:flex;justify-content:flex-end;gap:.75rem">
          <button class="btn btn-secondary" onclick="closeReportBugModal()">ביטול</button>
          <button class="btn btn-primary" id="report-bug-submit-btn" onclick="submitBugReport()">שלח דיווח</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);
  document.body.style.overflow = 'hidden';
  modal.addEventListener('click', e => { if (e.target === modal) closeReportBugModal(); });
}

async function submitBugReport() {
  const modal  = document.getElementById('report-bug-modal');
  const msgEl  = document.getElementById('report-bug-message');
  const errEl  = document.getElementById('report-bug-err');
  const btn    = document.getElementById('report-bug-submit-btn');
  const msg    = msgEl?.value.trim();

  if (!msg) {
    if (errEl) { errEl.textContent = 'אנא תאר את התקלה'; errEl.style.display = 'block'; }
    return;
  }
  if (errEl) errEl.style.display = 'none';
  if (btn) { btn.disabled = true; btn.textContent = 'שולח...'; }

  try {
    await db.collection('reports').add({
      category:   'bug',
      examId:     modal.dataset.examId    || '',
      examTitle:  modal.dataset.examTitle || '',
      courseId:   modal.dataset.courseId  || '',
      message:    msg,
      userId:     STATE.fireUser?.uid   || '',
      userEmail:  STATE.fireUser?.email || '',
      createdAt:  firebase.firestore.FieldValue.serverTimestamp(),
      status:     'open',
    });
    closeReportBugModal();
    toast('הדיווח נשלח — תודה! 🙏', 'info');
  } catch(e) {
    if (btn) { btn.disabled = false; btn.textContent = 'שלח דיווח'; }
    if (errEl) { errEl.textContent = 'שגיאה בשליחה — נסה שוב'; errEl.style.display = 'block'; }
  }
}

function closeReportBugModal() {
  document.getElementById('report-bug-modal')?.remove();
  document.body.style.overflow = '';
}
