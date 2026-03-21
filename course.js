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
    // If we just denied a user and called signOut, skip the null-user render
    if (!user && STATE._blockNextAuthRender) {
      STATE._blockNextAuthRender = false;
      return;
    }
    if (user) {
      // ── Anonymous users are a temporary session for Firestore writes only.
      // Never run the auth/UI flow for them.
      if (user.isAnonymous) return;

      const email = (user.email || '').toLowerCase().trim();

      // ── 1. Authorization check (Firestore-backed) ───────────
      // Check authorization FIRST — existing authorized users bypass email verification.
      // Only new/unknown users must verify their email before requesting access.
      const authorized = await isUserAuthorized(email);

      // ── 0. Email verification gate (new users only) ─────────
      if (!user.emailVerified && !authorized) {
        renderEmailVerificationScreen(user);
        return;
      }

      if (!authorized) {
        // Sign out (keep account alive) — after admin approves, user can just log in.
        // Do NOT delete: if we delete, the user can't log in after approval.
        STATE._blockNextAuthRender = true;
        const savedName = user.displayName || '';
        try { await auth.signOut(); } catch (_) {}
        renderAccessRequestForm(email, savedName);
        return;
      }

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

      // ── 2. Terms check ─────────────────────────────────────
      // Existing users (already have a userData doc) get terms auto-accepted silently.
      if (!STATE.userData?.acceptedTerms) {
        const isExistingUser = !!(STATE.userData?.createdAt || STATE.userData?.doneExams || STATE.userData?.starredQuestions?.length);
        if (isExistingUser) {
          // Silently accept terms for existing users — don't block their login
          saveUserData(user.uid, { acceptedTerms: true }).catch(() => {});
          STATE.userData = { ...STATE.userData, acceptedTerms: true };
        } else {
          renderTermsModal();
          return;
        }
      }

      // ── 3. Survey check ────────────────────────────────────
      // Run in background — don't block initial render
      checkAndShowSurvey();

      // ── 4. Normal load ─────────────────────────────────────
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
          <button type="button" style="width:100%;background:none;border:none;cursor:pointer;
            color:var(--muted);font-size:.82rem;margin-top:.55rem;padding:.3rem;text-align:center"
            onclick="renderForgotPassword()">
            שכחתי סיסמה
          </button>
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
            <div class="pass-wrap">
              <input id="s-pass" type="password" placeholder="לפחות 6 תווים">
              <button type="button" class="pass-eye" onclick="togglePassVis('s-pass','s-eye')"
                title="הצג / הסתר סיסמה" id="s-eye" aria-label="הצג סיסמה">
                ${_eyeIcon(false)}
              </button>
            </div>
          </div>
          <div class="form-group">
            <label>תוכנית לימודים <span style="color:var(--danger)">*</span></label>
            <input id="s-program" type="text"
              placeholder="לדוגמה: מדעי המחשב, מדעי המחשב כלכלה, ביואינפורמטיקה...">
            <p style="font-size:.78rem;color:var(--muted);margin:.3rem 0 0">
              חובה — ציין את שם התוכנית שאתה לומד בה
            </p>
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


/* ══════════════════════════════════════════════════════════
   EMAIL VERIFICATION SCREEN
══════════════════════════════════════════════════════════ */

function renderEmailVerificationScreen(user) {
  const email = user?.email || '';
  document.getElementById('app').innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="auth-logo">
          <span class="icon">📧</span>
          <h1>אימות אימייל</h1>
          <p>שלחנו קישור אימות לכתובת</p>
          <p style="font-weight:700;color:var(--primary);font-size:.95rem;margin-top:.2rem">${esc(email)}</p>
        </div>
        <p style="text-align:center;color:var(--muted);font-size:.87rem;line-height:1.75;margin-bottom:1.2rem">
          פתח את תיבת הדואר שלך ולחץ על קישור האימות.<br>
          לאחר האימות, לחץ על הכפתור למטה כדי להיכנס.
        </p>
        <div id="ver-err" class="form-error"></div>
        <button class="btn btn-primary" style="width:100%;justify-content:center" onclick="checkEmailVerified()">
          אימתתי את המייל — כניסה ←
        </button>
        <button class="btn" style="width:100%;justify-content:center;margin-top:.75rem;
          color:var(--muted);background:transparent;border-color:transparent;font-size:.85rem"
          onclick="resendVerificationEmail()">
          לא קיבלתי — שלח שוב
        </button>
        ${(location.hostname === 'localhost' || location.hostname === '127.0.0.1') ? `
        <button class="btn btn-secondary" style="width:100%;justify-content:center;margin-top:.6rem;font-size:.82rem"
          onclick="devEmulatorVerifyEmail()">
          🔧 [DEV] אמת מייל ישירות (אמולטור)
        </button>` : ''}
        <button class="btn" style="width:100%;justify-content:center;margin-top:.2rem;
          color:var(--muted);background:transparent;border-color:transparent;font-size:.82rem"
          onclick="auth.signOut().catch(()=>{}).finally(()=>renderAuth())">
          ← חזרה לכניסה
        </button>
      </div>
    </div>`;
}

async function checkEmailVerified() {
  const errEl = document.getElementById('ver-err');
  if (errEl) errEl.classList.remove('show');
  try {
    await auth.currentUser.reload();
    if (auth.currentUser?.emailVerified) {
      // Reload triggers onAuthStateChanged which handles the rest
      location.reload();
    } else {
      if (errEl) {
        errEl.textContent = 'המייל טרם אומת. לחץ על הקישור שנשלח לדואר שלך ונסה שוב.';
        errEl.classList.add('show');
      }
    }
  } catch (e) {
    if (errEl) { errEl.textContent = 'שגיאה: ' + e.message; errEl.classList.add('show'); }
  }
}

async function resendVerificationEmail() {
  try {
    await auth.currentUser.sendEmailVerification();
    toast('✉️ קישור אימות נשלח שוב לדואר שלך', 'info');
  } catch (e) {
    toast('שגיאה בשליחת מייל: ' + e.message, 'error');
  }
}

// Dev-only: directly mark emailVerified=true via Firebase Auth emulator REST API
async function devEmulatorVerifyEmail() {
  try {
    const user = auth.currentUser;
    if (!user) { toast('אין משתמש מחובר', 'error'); return; }
    const idToken = await user.getIdToken();
    const res = await fetch(
      'http://localhost:9099/identitytoolkit.googleapis.com/v1/accounts:update?key=fake-api-key',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken, emailVerified: true }),
      }
    );
    if (!res.ok) throw new Error('emulator update failed: ' + res.status);
    await user.reload();
    toast('✅ מייל אומת (אמולטור)', 'success');
    location.reload();
  } catch (e) {
    toast('שגיאה: ' + e.message, 'error');
  }
}

/* ══════════════════════════════════════════════════════════
   ACCESS REQUEST FORM  — shown when isUserAuthorized → false
══════════════════════════════════════════════════════════ */

function renderAccessRequestForm(email, name = '') {
  document.getElementById('app').innerHTML = `
    <div class="auth-wrap" style="padding:1.5rem">
      <div class="auth-card" style="max-width:460px">

        <!-- Header -->
        <div class="auth-logo" style="margin-bottom:1.2rem">
          <span class="icon">🔐</span>
          <h1 style="font-size:1.2rem">בקשת גישה למאגר המבחנים</h1>
          <p style="font-size:.84rem;color:var(--muted);margin-top:.4rem;line-height:1.6">
            מייל אוניברסיטאי (<strong>@mail.tau.ac.il</strong>) מקבל גישה אוטומטית.<br>
            למייל אחר — מלא את הפרטים הבאים ומנהל יאשר את בקשתך.
          </p>
        </div>

        <!-- Success state (hidden initially) -->
        <div id="req-success" style="display:none;text-align:center;padding:1rem 0">
          <div style="font-size:2.5rem;margin-bottom:.75rem">✅</div>
          <h3 style="color:var(--success);font-size:1.05rem;margin-bottom:.5rem">בקשתך נשלחה!</h3>
          <p style="font-size:.88rem;color:var(--muted);line-height:1.7">
            המתן לאישור המנהל.<br>
            תקבל מייל ברגע שהגישה תאושר.
          </p>
          <button class="btn btn-secondary" style="margin-top:1.2rem;width:100%;justify-content:center"
            onclick="renderAuth()">חזרה לכניסה</button>
        </div>

        <!-- Form -->
        <div id="req-form">
          <div id="req-err" class="form-error"></div>

          <div class="form-group">
            <label>שם מלא</label>
            <input id="req-name" type="text" placeholder="ישראל ישראלי"
              value="${esc(name)}" autocomplete="name">
          </div>

          <div class="form-group">
            <label>אימייל</label>
            <input id="req-email" type="email" value="${esc(email)}"
              placeholder="your@email.com" autocomplete="email" readonly>
          </div>

          <div class="form-group">
            <label>תוכנית לימודים <span style="color:var(--danger)">*</span></label>
            <input id="req-program" type="text"
              placeholder="לדוגמה: מדעי המחשב, מדעי המחשב כלכלה, ביואינפורמטיקה...">
            <p style="font-size:.78rem;color:var(--muted);margin:.3rem 0 0">
              חובה — ציין את שם התוכנית שאתה לומד בה
            </p>
          </div>

          <div class="form-group">
            <label>למה אתה מבקש גישה? <span style="color:var(--danger)">*</span></label>
            <textarea id="req-reason" rows="3"
              placeholder="תאר בקצרה את הסיבה לבקשתך..."
              style="width:100%;border:1.5px solid var(--border);border-radius:8px;
                     padding:.65rem .8rem;font-family:inherit;font-size:.88rem;
                     resize:vertical;line-height:1.6;color:var(--text);box-sizing:border-box"></textarea>
            <p style="font-size:.78rem;color:var(--muted);margin:.3rem 0 0">
              חובה — תיאור קצר יעזור לנו לאשר את בקשתך מהר יותר
            </p>
          </div>

          <button id="req-submit-btn" class="btn btn-primary"
            style="width:100%;justify-content:center;margin-top:.5rem;height:42px"
            onclick="submitAccessRequest()">
            <span id="req-btn-text">שלח בקשת גישה ←</span>
            <span id="req-btn-spin" style="display:none">
              <span class="spinner"
                style="width:18px;height:18px;border-width:2.5px;
                       border-color:rgba(255,255,255,.35);border-top-color:#fff;
                       display:inline-block;margin:0"></span>
            </span>
          </button>

          <button class="btn"
            style="width:100%;justify-content:center;margin-top:.55rem;
                   color:var(--muted);background:transparent;border-color:transparent;font-size:.82rem"
            onclick="auth.signOut().catch(()=>{}).finally(()=>renderAuth())">← חזרה לכניסה</button>
        </div>

      </div>
    </div>`;

  document.getElementById('req-name')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('req-lecturer')?.focus();
  });
}

async function submitAccessRequest() {
  const name    = (document.getElementById('req-name')?.value    || '').trim();
  const email   = (document.getElementById('req-email')?.value   || '').trim().toLowerCase();
  const program = (document.getElementById('req-program')?.value || '').trim();
  const reason  = (document.getElementById('req-reason')?.value  || '').trim();

  const errEl = document.getElementById('req-err');
  function showErr(msg) {
    if (!errEl) return;
    errEl.textContent = msg;
    errEl.classList.add('show');
  }
  if (errEl) errEl.classList.remove('show');

  if (!name)    return showErr('נא להזין שם מלא');
  if (!email)   return showErr('לא ניתן לזהות את האימייל');
  if (!program) return showErr('נא להקליד את תוכנית הלימודים שלך');
  if (!reason)  return showErr('נא לציין למה אתה מבקש גישה');

  // Rate limit: max 3 access requests per 30 minutes per browser
  if (!_rateCheck('rl_access_req', 3, 30 * 60 * 1000)) {
    return showErr('שלחת יותר מדי בקשות — המתן חצי שעה ונסה שוב');
  }

  // ── Loading state ────────────────────────────────────────
  const btn     = document.getElementById('req-submit-btn');
  const btnText = document.getElementById('req-btn-text');
  const btnSpin = document.getElementById('req-btn-spin');
  if (btn)     btn.disabled          = true;
  if (btnText) btnText.style.display = 'none';
  if (btnSpin) btnSpin.style.display = 'inline-flex';

  // Keep a reference to the current user NOW, before any async operations
  // that might change auth state.
  const currentUser = auth.currentUser;

  try {
    // ── Write to Firestore ───────────────────────────────
    // rule: allow create: if true — works even when signed out
    await db.collection('access_requests').add({
      name,
      email,
      program,
      reason,
      timestamp: firebase.firestore.FieldValue.serverTimestamp(),
      status: 'pending',
    });

    // ── Show success ─────────────────────────────────────
    document.getElementById('req-form').style.display    = 'none';
    document.getElementById('req-success').style.display = 'block';

  } catch (err) {
    console.error('submitAccessRequest error:', err);
    showErr('אירעה שגיאה בשליחת הבקשה. נסה שוב.');
    if (btn)     btn.disabled          = false;
    if (btnText) btnText.style.display = 'inline';
    if (btnSpin) btnSpin.style.display = 'none';
  }
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

  // Rate limit: max 10 login attempts per 15 minutes per browser
  if (!_rateCheck('rl_login', 10, 15 * 60 * 1000)) {
    return authErr('יותר מדי ניסיונות כניסה — המתן מספר דקות ונסה שוב');
  }

  authBusy(true);
  try {
    const cred = await auth.signInWithEmailAndPassword(email, pass);

    // ── Email verification check ────────────────────────────────
    if (!cred.user.emailVerified) {
      authBusy(false);
      STATE._blockNextAuthRender = true;
      renderEmailVerificationScreen(cred.user);
      return;
    }

    // ── Authorization check after successful Firebase sign-in ──
    const authorized = await isUserAuthorized(cred.user.email || email);
    if (!authorized) {
      authBusy(false);
      STATE._blockNextAuthRender = true;
      renderAccessRequestForm(cred.user.email || email, cred.user.displayName || '');
      return;
    }

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

/* ── Rate limiting (localStorage) ──────────────────────────
 * _rateCheck(key, max, windowMs) — returns true if allowed.
 * Stores timestamps of recent attempts; blocks if over max in window.
 */
function _rateCheck(key, max, windowMs) {
  const now      = Date.now();
  const attempts = JSON.parse(localStorage.getItem(key) || '[]')
    .filter(t => now - t < windowMs);
  if (attempts.length >= max) return false;
  attempts.push(now);
  localStorage.setItem(key, JSON.stringify(attempts));
  return true;
}

function _rateReset(key) {
  localStorage.removeItem(key);
}

async function doSignup() {
  const name    = document.getElementById('s-name').value.trim();
  const email   = document.getElementById('s-email').value.trim().toLowerCase();
  const pass    = document.getElementById('s-pass').value;
  const program = (document.getElementById('s-program')?.value || '').trim();
  if (!name || !email || !pass) return authErr('נא למלא את כל השדות');
  if (!program) return authErr('נא לציין את תוכנית הלימודים שלך');
  if (pass.length < 6) return authErr('סיסמה חייבת להכיל לפחות 6 תווים');

  // Rate limit: max 5 signup attempts per 10 minutes per browser
  if (!_rateCheck('rl_signup', 5, 10 * 60 * 1000)) {
    return authErr('יותר מדי ניסיונות הרשמה — המתן מספר דקות ונסה שוב');
  }

  authBusy(true);
  try {
    // Create the account — onAuthStateChanged will run isUserAuthorized
    // and handle both the authorized (→ app) and unauthorized (→ request form)
    // paths. This avoids all anonymous-auth timing issues.
    const cred = await auth.createUserWithEmailAndPassword(email, pass);
    await cred.user.updateProfile({ displayName: name });
    // Save study program immediately so it's available on first sign-in
    try {
      await db.collection('users').doc(cred.user.uid).set(
        { studyProgram: program },
        { merge: true }
      );
    } catch (_) {}
    // Send verification email — onAuthStateChanged will check emailVerified
    try { await cred.user.sendEmailVerification(); } catch (_) {}
    // onAuthStateChanged will handle the rest (save user data + route)
  } catch (e) {
    const messages = {
      'auth/email-already-in-use': 'אימייל כבר קיים במערכת — נסה להתחבר במקום להירשם',
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
            fireUser: null, userData: null, courses: null, exams: {}, examVotes: {},
            doneExams: [], inProgressExams: [], savedFilters: {} };
  renderAuth();
}

/* ══════════════════════════════════════════════════════════
   FORGOT PASSWORD
══════════════════════════════════════════════════════════ */

function renderForgotPassword() {
  const prefill = document.getElementById('l-email')?.value?.trim() || '';
  document.getElementById('app').innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="auth-logo">
          <span class="icon">🔑</span>
          <h1>איפוס סיסמה</h1>
          <p>נשלח אליך קישור לאיפוס הסיסמה</p>
        </div>

        <div id="fp-success" style="display:none;text-align:center;padding:1rem 0">
          <div style="font-size:2.5rem;margin-bottom:.75rem">✉️</div>
          <h3 style="color:var(--success);font-size:1.05rem;margin-bottom:.5rem">המייל נשלח!</h3>
          <p style="font-size:.88rem;color:var(--muted);line-height:1.7">
            בדוק את תיבת הדואר שלך ולחץ על הקישור לאיפוס הסיסמה.
          </p>
          ${(location.hostname === 'localhost' || location.hostname === '127.0.0.1') ? `
          <p style="font-size:.78rem;color:#d97706;background:#fefce8;border:1px solid #fde047;
            border-radius:6px;padding:.5rem .75rem;margin-top:.75rem">
            🔧 אמולטור: קישור האיפוס זמין ב-<br>
            <a href="http://localhost:4000/auth" target="_blank" style="color:#d97706">
              localhost:4000/auth
            </a>
          </p>` : ''}
          <button class="btn btn-secondary" style="margin-top:1.2rem;width:100%;justify-content:center"
            onclick="renderAuth()">חזרה לכניסה</button>
        </div>

        <div id="fp-form">
          <div id="fp-err" class="form-error"></div>
          <div class="form-group">
            <label>אימייל</label>
            <input id="fp-email" type="email" placeholder="your@email.com"
              value="${esc(prefill)}" autocomplete="email">
          </div>
          <button id="fp-btn" class="btn btn-primary" style="width:100%;justify-content:center"
            onclick="sendPasswordReset()">שלח קישור לאיפוס ←</button>
          <button type="button" style="width:100%;background:none;border:none;cursor:pointer;
            color:var(--muted);font-size:.82rem;margin-top:.55rem;padding:.3rem;text-align:center"
            onclick="renderAuth()">← חזרה לכניסה</button>
        </div>
      </div>
    </div>`;

  document.getElementById('fp-email')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') sendPasswordReset();
  });
  document.getElementById('fp-email')?.focus();
}

async function sendPasswordReset() {
  const email = (document.getElementById('fp-email')?.value || '').trim().toLowerCase();
  const errEl = document.getElementById('fp-err');
  if (errEl) errEl.classList.remove('show');

  if (!email) {
    if (errEl) { errEl.textContent = 'נא להזין כתובת אימייל'; errEl.classList.add('show'); }
    return;
  }

  const btn = document.getElementById('fp-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'שולח...'; }

  try {
    await auth.sendPasswordResetEmail(email);
    document.getElementById('fp-form').style.display    = 'none';
    document.getElementById('fp-success').style.display = 'block';
  } catch (e) {
    const messages = {
      'auth/user-not-found':  'אימייל לא קיים במערכת',
      'auth/invalid-email':   'פורמט אימייל לא תקין',
      'auth/too-many-requests': 'יותר מדי ניסיונות — נסה שוב מאוחר יותר',
    };
    if (errEl) {
      errEl.textContent = messages[e.code] || 'שגיאה: ' + e.message;
      errEl.classList.add('show');
    }
    if (btn) { btn.disabled = false; btn.textContent = 'שלח קישור לאיפוס ←'; }
  }
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
          <p style="margin:0 0 .6rem">
            אני מצהיר/ה כי אני סטודנט/ית רשום/ה <strong>באוניברסיטת תל אביב</strong>.
          </p>
          <p style="margin:0">
            ידוע לי שכל התכנים המופיעים באתר זה — שאלות מבחן, פתרונות וחומרי לימוד —
            <strong>מוגנים בזכויות יוצרים</strong> ומיועדים לשימוש אישי בלבד.
            אני מתחייב/ת <strong>לא להפיץ, לשתף, להעתיק או לפרסם</strong> תכנים אלו
            בכל אמצעי שהוא ללא אישור מפורש.
          </p>
        </div>

        <!-- Checkbox confirmation -->
        <label class="terms-check-label" id="terms-check-label">
          <input type="checkbox" id="terms-check" onchange="onTermsCheckChange()">
          <span class="terms-check-text">
            קראתי והבנתי את ההצהרה לעיל, ואני מסכים/ה לשמור על זכויות היוצרים
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
          <div class="cc">פנייה לצוות</div>
          <div class="cm">הוספת קורס, משוב ועוד</div>
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
      <button class="qv-btn" onclick="event.stopPropagation(); openExamBugModal('${e.id}','${STATE.courseId}',${JSON.stringify(e.title || e.id)})" title="בעיה במבחן" style="margin-left:.25rem">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      </button>
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
    logUserEvent(uid, 'exam_complete', { examId, courseId: STATE.courseId });
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
    logUserEvent(uid, 'exam_in_progress', { examId, courseId: STATE.courseId });
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

        <div class="ev-banner" style="position:relative">
          <h1 class="ev-banner-title">${esc(examTitle)}</h1>
          ${metaLine ? `<p class="ev-banner-meta">${esc(metaLine)}</p>` : ''}
          <button onclick="openExamBugModal('${STATE.examId}','${STATE.courseId}',${JSON.stringify(examTitle)})"
            title="בעיה במבחן"
            style="position:absolute;bottom:0;left:0;background:none;border:1.5px solid #cbd5e1;border-radius:8px;
                   padding:.35rem .7rem;font-size:.78rem;color:#64748b;cursor:pointer;
                   display:inline-flex;align-items:center;gap:.35rem;white-space:nowrap;
                   transition:border-color .15s,color .15s"
            onmouseover="this.style.borderColor='#ef4444';this.style.color='#ef4444'"
            onmouseout="this.style.borderColor='#cbd5e1';this.style.color='#64748b'">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            בעיה במבחן
          </button>
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
    const update = { starredQuestions: starred };
    if (adding) update.starCount = firebase.firestore.FieldValue.increment(1);
    await saveUserData(uid, update);
    if (adding) logUserEvent(uid, 'star_question', { questionId: id, examId: STATE.examId });
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
    const userUpdate = { difficultyVotes: userVotes };
    // Track new vote (not removal)
    if (prev !== level) {
      userUpdate.diffVoteCount = firebase.firestore.FieldValue.increment(1);
      logUserEvent(uid, 'vote_difficulty', { questionId: qid, level, examId: STATE.examId });
    }
    await saveUserData(uid, userUpdate);
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
      logUserEvent(uid, 'copy_question', { examId: STATE.examId, courseId: STATE.courseId });
    }
  }).catch(() => toast('העתקה נכשלה', 'error'));
}


/* ══════════════════════════════════════════════════════════
   GENERATE SIMILAR QUESTION (tracking only)
══════════════════════════════════════════════════════════ */

async function trackGenerateSimilar(questionId, questionNum) {
  toast('✨ פיצ\'ר "ג\'נרט שאלה דומה" בפיתוח — בקרוב!', 'info');
  const uid = STATE.fireUser?.uid;
  if (!uid) return;
  try {
    await db.collection('users').doc(uid).set(
      { generateSimilarCount: firebase.firestore.FieldValue.increment(1) },
      { merge: true }
    );
    logUserEvent(uid, 'generate_similar', { questionId, questionNum, examId: STATE.examId });
  } catch (e) { console.warn('trackGenerateSimilar:', e.message); }
}

/* ══════════════════════════════════════════════════════════
   CONTACT US MODAL
══════════════════════════════════════════════════════════ */

function openContactModal() {
  document.getElementById('contact-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'contact-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:10000;padding:1rem;backdrop-filter:blur(2px)';
  modal.innerHTML = `
    <div style="background:#fff;border-radius:16px;width:min(92vw,460px);padding:1.75rem;
      box-shadow:0 24px 60px rgba(0,0,0,.3);direction:rtl;max-height:90vh;overflow-y:auto">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.1rem">
        <div>
          <h3 style="margin:0 0 .2rem;font-size:1.05rem;font-weight:700;color:#1e293b">✉️ צור איתנו קשר</h3>
          <p style="margin:0;font-size:.78rem;color:#64748b">נשמח לשמוע ממך</p>
        </div>
        <button onclick="document.getElementById('contact-modal').remove()"
          style="background:none;border:none;font-size:1.4rem;cursor:pointer;color:#9ca3af;line-height:1;padding:.2rem">✕</button>
      </div>

      <div class="form-group" style="margin-bottom:.75rem">
        <label style="font-size:.85rem;font-weight:600">נושא הפנייה</label>
        <select id="contact-topic" style="width:100%;padding:.55rem .75rem;border:1.5px solid var(--border);border-radius:8px;font-size:.88rem;color:var(--text)">
          <option value="add_course">בקשה להוספת קורס</option>
          <option value="feedback">חוות דעת על האתר</option>
          <option value="bug">דיווח על תקלה טכנית</option>
          <option value="other">אחר</option>
        </select>
      </div>

      <div class="form-group" style="margin-bottom:1rem">
        <label style="font-size:.85rem;font-weight:600">הודעה <span style="color:var(--danger)">*</span></label>
        <textarea id="contact-text" rows="4" placeholder="כתוב את פנייתך כאן..."
          style="width:100%;padding:.65rem .75rem;border:1.5px solid var(--border);border-radius:8px;
            font-size:.88rem;resize:vertical;box-sizing:border-box;font-family:inherit;
            color:var(--text);line-height:1.6"></textarea>
      </div>

      <div id="contact-err" class="form-error"></div>
      <div style="display:flex;gap:.75rem;justify-content:flex-end">
        <button class="btn btn-secondary btn-sm" onclick="document.getElementById('contact-modal').remove()">ביטול</button>
        <button class="btn btn-primary btn-sm" onclick="submitContactForm()">שלח ←</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  document.getElementById('contact-text')?.focus();
}

async function submitContactForm() {
  const errEl = document.getElementById('contact-err');
  if (errEl) errEl.classList.remove('show');
  const topic = document.getElementById('contact-topic')?.value || 'other';
  const text  = (document.getElementById('contact-text')?.value || '').trim();
  if (!text) {
    if (errEl) { errEl.textContent = 'נא לכתוב הודעה'; errEl.classList.add('show'); }
    return;
  }
  const uid   = STATE.fireUser?.uid || null;
  const email = STATE.fireUser?.email || '';
  try {
    await db.collection('bug_reports').add({
      bugType:      'contact_' + topic,
      bugText:      text,
      questionId:   null,
      questionNum:  null,
      examId:       '',
      courseId:     '',
      reportedBy:   uid,
      reporterEmail: email,
      status:       'open',
      createdAt:    firebase.firestore.FieldValue.serverTimestamp(),
    });
    document.getElementById('contact-modal')?.remove();
    toast('✅ פנייתך נשלחה — תודה!', 'success');
  } catch (e) {
    if (errEl) { errEl.textContent = 'שגיאה בשליחה: ' + e.message; errEl.classList.add('show'); }
  }
}

/* ══════════════════════════════════════════════════════════
   EXAM BUG REPORT MODAL
══════════════════════════════════════════════════════════ */

function openExamBugModal(examId, courseId, examTitle) {
  document.getElementById('exam-bug-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'exam-bug-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:10000;padding:1rem;backdrop-filter:blur(2px)';
  modal.innerHTML = `
    <div style="background:#fff;border-radius:16px;width:min(92vw,460px);padding:1.75rem;
      box-shadow:0 24px 60px rgba(0,0,0,.3);direction:rtl;max-height:90vh;overflow-y:auto">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.1rem">
        <div>
          <h3 style="margin:0 0 .2rem;font-size:1.05rem;font-weight:700;color:#1e293b">🐛 בעיה במבחן</h3>
          <p style="margin:0;font-size:.78rem;color:#64748b">${esc(examTitle)}</p>
        </div>
        <button onclick="document.getElementById('exam-bug-modal').remove()"
          style="background:none;border:none;font-size:1.4rem;cursor:pointer;color:#9ca3af;line-height:1;padding:.2rem">✕</button>
      </div>

      <div class="form-group" style="margin-bottom:.75rem">
        <label style="font-size:.85rem;font-weight:600">מספר שאלה (אופציונלי)</label>
        <input id="exam-bug-qnum" type="number" min="1" placeholder="השאר ריק אם הבעיה כללית"
          style="width:100%;padding:.55rem .75rem;border:1.5px solid var(--border);border-radius:8px;font-size:.88rem;color:var(--text);box-sizing:border-box">
      </div>

      <div class="form-group" style="margin-bottom:.75rem">
        <label style="font-size:.85rem;font-weight:600">סוג הבעיה</label>
        <select id="exam-bug-type" style="width:100%;padding:.55rem .75rem;border:1.5px solid var(--border);border-radius:8px;font-size:.88rem;color:var(--text)">
          <option value="wrong_lecturer">שם מרצה שגוי</option>
          <option value="wrong_pdf">PDF שגוי / לא נפתח</option>
          <option value="wrong_meta">פרטי מבחן שגויים (שנה / סמסטר / מועד)</option>
          <option value="unclear">שאלה לא ברורה / טקסט חסר</option>
          <option value="other">אחר</option>
        </select>
      </div>

      <div class="form-group" style="margin-bottom:1rem">
        <label style="font-size:.85rem;font-weight:600">תיאור הבעיה <span style="color:var(--danger)">*</span></label>
        <textarea id="exam-bug-text" rows="3" placeholder="תאר את הבעיה בקצרה..."
          style="width:100%;padding:.65rem .75rem;border:1.5px solid var(--border);border-radius:8px;
            font-size:.88rem;resize:vertical;box-sizing:border-box;font-family:inherit;
            color:var(--text);line-height:1.6"></textarea>
      </div>

      <div id="exam-bug-err" class="form-error"></div>
      <div style="display:flex;gap:.75rem;justify-content:flex-end">
        <button class="btn btn-secondary btn-sm" onclick="document.getElementById('exam-bug-modal').remove()">ביטול</button>
        <button class="btn btn-primary btn-sm" onclick="submitExamBugReport('${examId}','${courseId}')">שלח דיווח ←</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  document.getElementById('exam-bug-text')?.focus();
}

async function submitExamBugReport(examId, courseId) {
  const errEl = document.getElementById('exam-bug-err');
  if (errEl) errEl.classList.remove('show');
  const bugText = (document.getElementById('exam-bug-text')?.value || '').trim();
  if (!bugText) {
    if (errEl) { errEl.textContent = 'נא לתאר את הבעיה'; errEl.classList.add('show'); }
    return;
  }
  const bugType    = document.getElementById('exam-bug-type')?.value || 'other';
  const questionNum = parseInt(document.getElementById('exam-bug-qnum')?.value, 10) || null;
  const uid   = STATE.fireUser?.uid || null;
  const email = STATE.fireUser?.email || '';
  try {
    await db.collection('bug_reports').add({
      bugType,
      bugText,
      questionId:   null,
      questionNum,
      examId:       examId || '',
      courseId:     courseId || '',
      reportedBy:   uid,
      reporterEmail: email,
      status:       'open',
      createdAt:    firebase.firestore.FieldValue.serverTimestamp(),
    });
    document.getElementById('exam-bug-modal')?.remove();
    toast('✅ הדיווח נשלח — תודה!', 'success');
    if (uid) {
      db.collection('users').doc(uid).set(
        { bugReportCount: firebase.firestore.FieldValue.increment(1) },
        { merge: true }
      ).catch(() => {});
    }
  } catch (e) {
    if (errEl) { errEl.textContent = 'שגיאה בשליחת הדיווח: ' + e.message; errEl.classList.add('show'); }
  }
}

/* ══════════════════════════════════════════════════════════
   BUG REPORT MODAL
══════════════════════════════════════════════════════════ */

function openBugReportModal(questionId, questionNum) {
  document.getElementById('bug-modal')?.remove();

  const isGeneral = questionId === null;
  const exam      = STATE.examId ? STATE.examId : '';
  const questions = STATE.examVotes ? Object.keys(STATE.examVotes) : [];

  // Build question selector for general reports
  const qSelector = isGeneral ? `
    <div class="form-group" style="margin-bottom:.75rem">
      <label style="font-size:.85rem;font-weight:600">על מה הדיווח?</label>
      <select id="bug-scope" style="width:100%;padding:.55rem .75rem;border:1.5px solid var(--border);border-radius:8px;font-size:.88rem;color:var(--text)"
        onchange="
          const v=this.value;
          const qRow=document.getElementById('bug-qnum-row');
          const qTypes=document.getElementById('bug-types-question');
          const gTypes=document.getElementById('bug-types-general');
          if(v==='question'){qRow.style.display='';qTypes.style.display='';gTypes.style.display='none';}
          else{qRow.style.display='none';qTypes.style.display='none';gTypes.style.display='';}
        ">
        <option value="general">בעיה כללית במבחן</option>
        <option value="question">בעיה בשאלה ספציפית</option>
      </select>
    </div>
    <div id="bug-qnum-row" style="margin-bottom:.75rem;display:none">
      <label style="font-size:.85rem;font-weight:600;display:block;margin-bottom:.35rem">מספר שאלה</label>
      <input id="bug-qnum-input" type="number" min="1" placeholder="למשל: 3"
        style="width:100%;padding:.55rem .75rem;border:1.5px solid var(--border);border-radius:8px;font-size:.88rem;color:var(--text);box-sizing:border-box">
    </div>` : '';

  const generalTypeOptions = `
    <option value="missing_exam">מבחן חסר לחלוטין</option>
    <option value="wrong_pdf">PDF שגוי / לא נפתח</option>
    <option value="wrong_lecturer">שם מרצה שגוי</option>
    <option value="wrong_meta">פרטי מבחן שגויים (שנה / סמסטר / מועד)</option>
    <option value="other">אחר</option>`;

  const questionTypeOptions = `
    <option value="unclear">שאלה לא ברורה / מנוסחת בצורה גרועה</option>
    <option value="missing">חסר טקסט / שאלה חסרה</option>
    <option value="wrong_answer">תשובה שגויה</option>
    <option value="typo">שגיאת כתיב / פורמט</option>
    <option value="math">בעיה בנוסחה מתמטית</option>
    <option value="other">אחר</option>`;

  const modal = document.createElement('div');
  modal.id = 'bug-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:10000;padding:1rem;backdrop-filter:blur(2px)';
  modal.innerHTML = `
    <div style="background:#fff;border-radius:16px;width:min(92vw,480px);padding:1.75rem;
      box-shadow:0 24px 60px rgba(0,0,0,.3);direction:rtl;max-height:90vh;overflow-y:auto">

      <!-- Header -->
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.1rem">
        <div>
          <h3 style="margin:0 0 .2rem;font-size:1.05rem;font-weight:700;color:#1e293b">
            🐛 דיווח על תקלה
          </h3>
          <p style="margin:0;font-size:.78rem;color:#64748b">
            ${isGeneral ? 'ניתן לדווח על כל בעיה — חסר מבחן, פרטים שגויים, בעיה בשאלה ועוד' : `שאלה ${questionNum}`}
          </p>
        </div>
        <button onclick="document.getElementById('bug-modal').remove()"
          style="background:none;border:none;font-size:1.4rem;cursor:pointer;color:#9ca3af;line-height:1;padding:.2rem">✕</button>
      </div>

      ${qSelector}

      <!-- Type selector — general -->
      <div id="bug-types-general" class="form-group" style="margin-bottom:.75rem;${isGeneral ? '' : 'display:none'}">
        <label style="font-size:.85rem;font-weight:600">סוג הבעיה</label>
        <select id="bug-type-general" style="width:100%;padding:.55rem .75rem;border:1.5px solid var(--border);border-radius:8px;font-size:.88rem;color:var(--text)">
          ${generalTypeOptions}
        </select>
      </div>

      <!-- Type selector — question-specific -->
      <div id="bug-types-question" class="form-group" style="margin-bottom:.75rem;${isGeneral ? 'display:none' : ''}">
        <label style="font-size:.85rem;font-weight:600">סוג הבעיה</label>
        <select id="bug-type-question" style="width:100%;padding:.55rem .75rem;border:1.5px solid var(--border);border-radius:8px;font-size:.88rem;color:var(--text)">
          ${questionTypeOptions}
        </select>
      </div>

      <!-- Description -->
      <div class="form-group" style="margin-bottom:1rem">
        <label style="font-size:.85rem;font-weight:600">תיאור הבעיה <span style="color:var(--danger)">*</span></label>
        <textarea id="bug-text" rows="3" placeholder="תאר את הבעיה בקצרה..."
          style="width:100%;padding:.65rem .75rem;border:1.5px solid var(--border);border-radius:8px;
            font-size:.88rem;resize:vertical;box-sizing:border-box;font-family:inherit;
            color:var(--text);line-height:1.6"></textarea>
      </div>

      <div id="bug-err" class="form-error"></div>
      <div style="display:flex;gap:.75rem;justify-content:flex-end">
        <button class="btn btn-secondary btn-sm" onclick="document.getElementById('bug-modal').remove()">ביטול</button>
        <button class="btn btn-primary btn-sm"
          onclick="submitBugReport(${JSON.stringify(questionId)},${JSON.stringify(questionNum)},${isGeneral})">
          שלח דיווח ←
        </button>
      </div>
    </div>`;

  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  document.getElementById('bug-text')?.focus();
}

async function submitBugReport(questionId, questionNum, isGeneral) {
  const errEl = document.getElementById('bug-err');
  if (errEl) errEl.classList.remove('show');

  // Resolve scope + type
  let resolvedQuestionId  = questionId;
  let resolvedQuestionNum = questionNum;
  let bugType;

  if (isGeneral) {
    const scope = document.getElementById('bug-scope')?.value || 'general';
    if (scope === 'question') {
      bugType = document.getElementById('bug-type-question')?.value || 'other';
      resolvedQuestionNum = parseInt(document.getElementById('bug-qnum-input')?.value, 10) || null;
    } else {
      bugType = document.getElementById('bug-type-general')?.value || 'other';
    }
  } else {
    bugType = document.getElementById('bug-type-question')?.value || 'other';
  }

  const bugText = (document.getElementById('bug-text')?.value || '').trim();
  if (!bugText) {
    if (errEl) { errEl.textContent = 'נא לתאר את הבעיה'; errEl.classList.add('show'); }
    return;
  }

  const uid   = STATE.fireUser?.uid;
  const email = STATE.fireUser?.email || '';

  try {
    await db.collection('bug_reports').add({
      questionId:  resolvedQuestionId  || null,
      questionNum: resolvedQuestionNum || null,
      examId:    STATE.examId   || '',
      courseId:  STATE.courseId || '',
      bugType,
      bugText,
      reportedBy: uid,
      reporterEmail: email,
      status:    'open',
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });

    document.getElementById('bug-modal')?.remove();
    toast('✅ הדיווח נשלח — תודה!', 'success');

    // Track event
    if (uid) {
      db.collection('users').doc(uid).set(
        { bugReportCount: firebase.firestore.FieldValue.increment(1) },
        { merge: true }
      ).catch(() => {});
    }
  } catch (e) {
    if (errEl) { errEl.textContent = 'שגיאה בשליחת הדיווח: ' + e.message; errEl.classList.add('show'); }
  }
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
