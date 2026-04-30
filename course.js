function nl2br(html){if(!html)return '';return html.replace(/\n/g,'<br>');}

/**
 * Format question/sub text for display:
 * - Splits at display math ($$...$$  or  \[...\])
 * - Wraps display math in a centered block div
 * - Converts newlines to <br> only in text segments
 * - Trims blank lines immediately adjacent to display math blocks
 */
function formatMathText(text, inlineImages = null) {
  if (!text) return '';

  // Split preserving the delimiter (display math blocks)
  const DISPLAY_RE = /(\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\])/g;
  const parts = text.split(DISPLAY_RE);

  return parts.map(part => {
    if (part.startsWith('$$') || part.startsWith('\\[')) {
      // Display math — HTML-escape & and < so the browser doesn't corrupt
      // LaTeX matrix separators before MathJax processes them
      const safe = part.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      return `<div class="math-display">${safe}</div>`;
    }
    // Regular text — trim blank lines adjacent to display blocks
    let trimmed = part.replace(/^\s*\n/, '').replace(/\n\s*$/, '');
    if (!trimmed) return '';
    // Convert markdown image syntax to HTML image blocks.
    trimmed = trimmed.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, rawRef) => {
      const ref = String(rawRef || '').trim();
      let resolved = '';
      if (ref.startsWith('img:')) {
        const key = ref.slice(4);
        const map = inlineImages && typeof inlineImages === 'object' ? inlineImages : {};
        resolved = String(map[key] || '').trim();
      } else {
        resolved = ref;
      }
      const safe = safeUrl(resolved);
      if (!safe) return '';
      return `<div class="qv-inline-image align-center"><img class="qv-image" src="${safe}" alt="${esc(alt || 'image')}" loading="lazy" referrerpolicy="no-referrer"></div>`;
    });
    // Convert markdown bold **text** to <strong>
    trimmed = trimmed.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Escape & in inline math ($...$) so matrices render correctly
    trimmed = trimmed.replace(/(\$[^$]+?\$)/g, (m) => m.replace(/&/g, '&amp;').replace(/</g, '&lt;'));
    return nl2br(trimmed);
  }).join('');
}
/* ============================================================
   EXAM BANK  —  course.js  (Firebase edition)
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

function toast(msg, type = '') {
  const c = document.getElementById('toast-wrap');
  if (!c) return;
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.remove(), 2500);
}

/* ── GEMINI – environment detection ────────────────────────── */
const _isLocalDev = location.hostname === 'localhost' || location.hostname === '127.0.0.1';

/* ── AI Generate – client-side quota & state tracking ──────── */
const AI_DAILY_QUOTA = 10;           // must match QUOTA_DAILY in edge function
let _aiGenerateInProgress = false;   // prevent concurrent requests
let _aiStreamAbort = null;           // AbortController for active stream
let _aiQuotaRemaining = null;        // populated from response headers
let _aiQuotaLimit = null;

function _updateQuotaBadge() {
  const badge = document.getElementById('gemini-quota-badge');
  if (badge && _aiQuotaRemaining !== null && _aiQuotaLimit !== null) {
    badge.textContent = `${_aiQuotaRemaining}/${_aiQuotaLimit}`;
    const pct = _aiQuotaRemaining / _aiQuotaLimit;
    if (pct <= 0) {
      badge.style.background = 'rgba(239,68,68,.15)'; badge.style.color = '#ef4444';
    } else if (pct <= 0.2) {
      badge.style.background = 'rgba(245,158,11,.15)'; badge.style.color = '#f59e0b';
    } else {
      badge.style.background = 'rgba(99,102,241,.12)'; badge.style.color = '#6366f1';
    }
  }
  _updateNavbarQuotaBadge();
}

/** Update the navbar quota badge (shown near username) */
function _updateNavbarQuotaBadge() {
  const badge = document.getElementById('navbar-quota-badge');
  if (!badge) return;
  if (_aiQuotaRemaining === null || _aiQuotaLimit === null) {
    badge.textContent = '';
    return;
  }
  badge.textContent = `✨ ${_aiQuotaRemaining}/${_aiQuotaLimit}`;
  const pct = _aiQuotaRemaining / _aiQuotaLimit;
  if (pct <= 0) {
    badge.style.background = 'rgba(239,68,68,.25)'; badge.style.color = '#fca5a5';
  } else if (pct <= 0.2) {
    badge.style.background = 'rgba(245,158,11,.25)'; badge.style.color = '#fde68a';
  } else {
    badge.style.background = 'rgba(255,255,255,.2)'; badge.style.color = '#fff';
  }
}

/** Fetch quota from Firestore on page load */
async function _fetchInitialQuota() {
  const uid = STATE.fireUser?.uid;
  if (!uid) return;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const snap = await db.collection('user_quotas').doc(uid).get();
    if (snap.exists) {
      const data = snap.data();
      const dailyUsed = (data.date_key === today) ? (data.requests_today || 0) : 0;
      _aiQuotaLimit = AI_DAILY_QUOTA;
      _aiQuotaRemaining = Math.max(0, AI_DAILY_QUOTA - dailyUsed);
    } else {
      _aiQuotaLimit = AI_DAILY_QUOTA;
      _aiQuotaRemaining = AI_DAILY_QUOTA;
    }
    _updateNavbarQuotaBadge();
  } catch (e) {
    console.warn('Failed to fetch quota:', e.message);
  }
}

/** One-shot cleanup: delete orphaned cache docs from old key format (no difficulty suffix) */
async function _cleanupOrphanedCache() {
  const flag = 'vaultau_cache_cleanup_done';
  if (localStorage.getItem(flag)) return;
  try {
    const snap = await db.collection('ai_questions_cache').get();
    const batch = db.batch();
    let count = 0;
    snap.docs.forEach(doc => {
      // New keys contain '_' (e.g. "questionId_hard"). Old keys don't.
      if (!doc.id.includes('_')) {
        batch.delete(doc.ref);
        count++;
      }
    });
    if (count > 0) {
      await batch.commit();
      console.log(`Cleaned up ${count} orphaned cache docs`);
    }
    localStorage.setItem(flag, '1');
  } catch (e) {
    console.warn('Cache cleanup failed:', e.message);
  }
}

/** Persist quota usage to Firestore so it survives page refresh (local dev + production fallback) */
async function _persistQuotaToFirestore() {
  const uid = STATE.fireUser?.uid;
  if (!uid) return;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const ref = db.collection('user_quotas').doc(uid);
    const snap = await ref.get();
    let currentDaily = 0;
    if (snap.exists && snap.data().date_key === today) {
      currentDaily = snap.data().requests_today || 0;
    }
    await ref.set({
      date_key: today,
      requests_today: currentDaily + 1,
      last_request: new Date().toISOString(),
    }, { merge: true });
  } catch (e) {
    console.warn('Failed to persist quota:', e.message);
  }
}

let _geminiKey = null;
async function _loadGeminiKey() {
  if (_geminiKey) return _geminiKey;
  try {
    const doc = await db.collection('settings').doc('api_keys').get();
    if (doc.exists && doc.data().gemini) {
      _geminiKey = doc.data().gemini;
      console.log('✅ Gemini API key loaded');
    }
  } catch (e) { console.warn('Could not load Gemini key:', e); }
  return _geminiKey;
}

/* ── LTI entry bootstrap (feature-gated server-side) ───────── */
const LTI_HANDOFF_PARAM = 'lti_handoff';
let _ltiBootstrapResult = { attempted: false, success: false, error: '' };

function consumeLtiHandoffFromUrl() {
  const currentUrl = new URL(window.location.href);
  const handoffToken = currentUrl.searchParams.get(LTI_HANDOFF_PARAM);
  if (!handoffToken) return '';

  // Strip one-time token from the address bar immediately to avoid leaking it.
  currentUrl.searchParams.delete(LTI_HANDOFF_PARAM);
  window.history.replaceState(window.history.state, '', currentUrl.pathname + currentUrl.search + currentUrl.hash);
  return handoffToken;
}

function mapLtiErrorMessage(errorCode) {
  if (errorCode === 'lti_entry_disabled') {
    return 'אנחנו כרגע לא תומכים בהתחברות דרך המודל - הנושא נמצא בטיפול';
  }
  return errorCode || 'LTI exchange failed';
}

async function maybeBootstrapLtiSession() {
  const handoffToken = consumeLtiHandoffFromUrl();
  if (!handoffToken) return { attempted: false, success: false, error: '' };

  try {
    const res = await fetch('/.netlify/functions/lti-session-exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handoffToken })
    });

    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = mapLtiErrorMessage(payload?.error);
      return { attempted: true, success: false, error };
    }
    if (!payload?.customToken) {
      return { attempted: true, success: false, error: 'Missing Firebase custom token from LTI exchange' };
    }

    await auth.signInWithCustomToken(payload.customToken);
    _gaLogin('lti');
    if (payload.isNewUser) _ga('sign_up', { method: 'lti' });

    return { attempted: true, success: true, error: '' };
  } catch (err) {
    console.error('LTI bootstrap failed:', err);
    return { attempted: true, success: false, error: 'Network error while bootstrapping LTI session' };
  }
}

function renderLtiFirstTimePasswordSetup() {
  const displayName = esc(STATE.fireUser?.displayName || STATE.userData?.displayName || '');
  document.getElementById('app').innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="auth-logo">
          <span class="icon">🔑</span>
          <h1>VaultAU</h1>
          <p>ברוך הבא${displayName ? ', ' + displayName : ''}!</p>
        </div>
        <p style="color:var(--fg);font-size:.95rem;text-align:center;line-height:1.6;margin-bottom:1.5rem">
          הגדר סיסמה כדי שתוכל להיכנס לאתר גם ישירות,<br>ללא Moodle.
        </p>
        <div id="lti-first-err" class="form-error"></div>
        <div class="form-group">
          <label>סיסמה</label>
          <div class="pass-wrap">
            <input id="lti-first-pass" type="password" placeholder="לפחות 6 תווים">
            <button type="button" class="pass-eye" onclick="togglePassVis('lti-first-pass','lti-first-eye')"
              id="lti-first-eye" aria-label="הצג סיסמה">${_eyeIcon(false)}</button>
          </div>
        </div>
        <div class="form-group">
          <label>אימות סיסמה</label>
          <div class="pass-wrap">
            <input id="lti-first-pass2" type="password" placeholder="הזן שוב את הסיסמה">
            <button type="button" class="pass-eye" onclick="togglePassVis('lti-first-pass2','lti-first-eye2')"
              id="lti-first-eye2" aria-label="הצג סיסמה">${_eyeIcon(false)}</button>
          </div>
        </div>
        <button id="lti-first-btn" class="btn btn-primary" style="width:100%;justify-content:center"
          onclick="doLtiFirstTimePasswordSetup()">שמור סיסמה והמשך ←</button>
      </div>
    </div>
  `;
  document.getElementById('lti-first-pass2')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') doLtiFirstTimePasswordSetup();
  });
  document.getElementById('lti-first-pass')?.focus();
}

async function doLtiFirstTimePasswordSetup() {
  const pass  = document.getElementById('lti-first-pass').value;
  const pass2 = document.getElementById('lti-first-pass2').value;
  const errEl = document.getElementById('lti-first-err');
  errEl.classList.remove('show');
  errEl.textContent = '';

  if (!pass || !pass2) {
    errEl.textContent = 'נא למלא את כל השדות';
    errEl.classList.add('show');
    return;
  }
  if (pass.length < 6) {
    errEl.textContent = 'סיסמה חייבת להכיל לפחות 6 תווים';
    errEl.classList.add('show');
    return;
  }
  if (pass !== pass2) {
    errEl.textContent = 'הסיסמאות לא תואמות';
    errEl.classList.add('show');
    return;
  }

  const btn = document.getElementById('lti-first-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'שומר...'; }

  try {
    await auth.currentUser.updatePassword(pass);

    // Continue to normal app flow
    if (needsConsentGate(STATE.userData)) {
      renderConsentModal();
      return;
    }
    checkAndShowSurvey();
    renderNavbar();
    _fetchInitialQuota();
    _cleanupOrphanedCache();
    history.replaceState({ page: 'home', courseId: null, examId: null }, '');
    renderPage();
  } catch (e) {
    const messages = {
      'auth/weak-password':        'הסיסמה חלשה מדי — נסה סיסמה חזקה יותר',
      'auth/requires-recent-login': 'תוקף הסשן פג — נסה שוב מ-Moodle',
    };
    errEl.textContent = messages[e.code] || ('שגיאה: ' + e.message);
    errEl.classList.add('show');
    if (btn) { btn.disabled = false; btn.textContent = 'שמור סיסמה והמשך ←'; }
  }
}

function needsConsentGate(userData) {
  return !userData?.acceptedTerms || userData?.analyticsConsent === undefined;
}

/* ============================================================
   Admin-forced password change (no email flow)
   Triggered when users/{uid}.mustChangePassword === true.
   ============================================================ */
function renderForcedPasswordChange() {
  const displayName = esc(STATE.fireUser?.displayName || STATE.userData?.displayName || '');
  document.getElementById('app').innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="auth-logo">
          <span class="icon">🔑</span>
          <h1>VaultAU</h1>
          <p>מנהל המערכת דורש ממך להגדיר סיסמה חדשה${displayName ? ', ' + displayName : ''}</p>
        </div>
        <p style="color:var(--fg);font-size:.92rem;text-align:center;line-height:1.6;margin-bottom:1.2rem">
          לפני שתוכל להמשיך, עליך להגדיר סיסמה חדשה ובטוחה לחשבון שלך.
        </p>
        <div id="fpc-err" class="form-error"></div>
        <div class="form-group">
          <label>סיסמה נוכחית</label>
          <div class="pass-wrap">
            <input id="fpc-current" type="password" placeholder="הסיסמה שהתחברת איתה">
            <button type="button" class="pass-eye" onclick="togglePassVis('fpc-current','fpc-eye0')"
              id="fpc-eye0" aria-label="הצג סיסמה">${_eyeIcon(false)}</button>
          </div>
        </div>
        <div class="form-group">
          <label>סיסמה חדשה</label>
          <div class="pass-wrap">
            <input id="fpc-new" type="password" placeholder="לפחות 6 תווים">
            <button type="button" class="pass-eye" onclick="togglePassVis('fpc-new','fpc-eye1')"
              id="fpc-eye1" aria-label="הצג סיסמה">${_eyeIcon(false)}</button>
          </div>
        </div>
        <div class="form-group">
          <label>אימות סיסמה</label>
          <div class="pass-wrap">
            <input id="fpc-new2" type="password" placeholder="הזן שוב את הסיסמה">
            <button type="button" class="pass-eye" onclick="togglePassVis('fpc-new2','fpc-eye2')"
              id="fpc-eye2" aria-label="הצג סיסמה">${_eyeIcon(false)}</button>
          </div>
        </div>
        <button id="fpc-btn" class="btn btn-primary" style="width:100%;justify-content:center"
          onclick="doForcedPasswordChange()">שמור והמשך ←</button>
        <button type="button" class="btn btn-secondary" style="width:100%;justify-content:center;margin-top:.6rem"
          onclick="auth.signOut()">יציאה</button>
      </div>
    </div>
  `;
  document.getElementById('fpc-new2')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') doForcedPasswordChange();
  });
  document.getElementById('fpc-current')?.focus();
}

async function doForcedPasswordChange() {
  const currentPwd = document.getElementById('fpc-current').value;
  const pass  = document.getElementById('fpc-new').value;
  const pass2 = document.getElementById('fpc-new2').value;
  const errEl = document.getElementById('fpc-err');
  errEl.classList.remove('show');
  errEl.textContent = '';

  if (!currentPwd || !pass || !pass2) {
    errEl.textContent = 'נא למלא את כל השדות';
    errEl.classList.add('show');
    return;
  }
  if (pass.length < 6) {
    errEl.textContent = 'סיסמה חייבת להכיל לפחות 6 תווים';
    errEl.classList.add('show');
    return;
  }
  if (pass !== pass2) {
    errEl.textContent = 'הסיסמאות לא תואמות';
    errEl.classList.add('show');
    return;
  }
  if (pass === currentPwd) {
    errEl.textContent = 'הסיסמה החדשה חייבת להיות שונה מהנוכחית';
    errEl.classList.add('show');
    return;
  }

  const btn = document.getElementById('fpc-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'שומר...'; }

  try {
    const user = auth.currentUser;
    // Re-authenticate to satisfy Firebase's recent-login requirement
    const cred = firebase.auth.EmailAuthProvider.credential(user.email, currentPwd);
    await user.reauthenticateWithCredential(cred);
    await user.updatePassword(pass);

    // Clear the flag
    await db.collection('users').doc(user.uid).update({
      mustChangePassword: false,
      passwordChangedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    if (STATE.userData) STATE.userData.mustChangePassword = false;

    // Continue normal flow
    if (needsConsentGate(STATE.userData)) {
      renderConsentModal();
      return;
    }
    checkAndShowSurvey();
    renderNavbar();
    _fetchInitialQuota();
    _cleanupOrphanedCache();
    history.replaceState({ page: 'home', courseId: null, examId: null }, '');
    renderPage();
  } catch (e) {
    const messages = {
      'auth/wrong-password':        'הסיסמה הנוכחית שגויה',
      'auth/invalid-credential':    'הסיסמה הנוכחית שגויה',
      'auth/weak-password':         'הסיסמה חלשה מדי — נסה סיסמה חזקה יותר',
      'auth/too-many-requests':     'יותר מדי ניסיונות — נסה שוב מאוחר יותר',
      'auth/requires-recent-login': 'תוקף הסשן פג — התחבר מחדש ונסה שוב',
    };
    errEl.textContent = messages[e.code] || ('שגיאה: ' + e.message);
    errEl.classList.add('show');
    if (btn) { btn.disabled = false; btn.textContent = 'שמור והמשך ←'; }
  }
}

function renderLtiFallback(message) {
  const safeMessage = esc(message || 'LTI launch could not be completed.');
  document.getElementById('app').innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card" style="max-width:520px">
        <div class="auth-logo">
          <span class="icon">⚠️</span>
          <h1>VaultAU</h1>
          <p>ההתחברות דרך LTI נכשלה</p>
        </div>
        <div class="form-error" style="display:block">${safeMessage}</div>
        <button class="btn btn-primary" style="width:100%;justify-content:center" onclick="renderAuth()">
          המשך להתחברות רגילה ←
        </button>
      </div>
    </div>
  `;
}

async function initAppBootstrap() {
  _ltiBootstrapResult = await maybeBootstrapLtiSession();

  auth.onAuthStateChanged(async (user) => {
    if (user) {
      // Anonymous users shouldn't reach here anymore, but clean up just in case
      if (user.isAnonymous) {
        auth.signOut().catch(() => {});
        return;
      }

      const email = (user.email || '').toLowerCase().trim();

      STATE.fireUser = user;
      // Save user data on first sign-in — only create if doc doesn't exist yet.
      // Must include role:'student' to satisfy Firestore create rule.
      if (!STATE.userData) {
        try {
          const docSnap = await db.collection('users').doc(user.uid).get();
          if (!docSnap.exists) {
            await db.collection('users').doc(user.uid).set({
              uid:         user.uid,
              email:       email,
              displayName: user.displayName || '',
              authOrigin:  'web',
              authMethods: ['web'],
              lastSignInMethod: 'web',
              createdAt:   firebase.firestore.FieldValue.serverTimestamp(),
              role:        'student',
            });
          } else {
            // User doc exists (possibly from LTI), update to track web login
            const existingData = docSnap.data();
            const rawAuthMethods = Array.isArray(existingData.authMethods) ? existingData.authMethods : [];
            const newAuthMethods = rawAuthMethods
              .flatMap((m) => Array.isArray(m) ? m : [m])
              .filter((m) => typeof m === 'string');
            if (!newAuthMethods.includes('web')) {
              newAuthMethods.push('web');
            }
            const newAuthOrigin = newAuthMethods.includes('lti') && newAuthMethods.includes('web') 
              ? 'both' 
              : (newAuthMethods.includes('lti') ? 'lti' : 'web');
            
            await db.collection('users').doc(user.uid).update({
              authMethods: newAuthMethods,
              authOrigin: newAuthOrigin,
              lastSignInMethod: 'web',
              lastSignInAt: new Date(),
            });
          }
        } catch (e) {
          console.error('Failed to create/update user document on login:', e);
        }
      }
      STATE.userData = await fetchUserData(user.uid, user.email);
      STATE.doneExams       = STATE.userData?.doneExams       || [];
      STATE.inProgressExams = STATE.userData?.inProgressExams || [];

      // ── Analytics kill switch ──────────────────────────────
      try {
        const globalSnap = await db.collection('settings').doc('global').get();
        STATE.isAnalyticsOn = globalSnap.data()?.isAnalyticsOn ?? true;
      } catch (_e) { STATE.isAnalyticsOn = true; }
      // ── 0. First-time LTI password setup ───────────────────
      // Show password setup if: user arrived via LTI this session AND has no password yet
      const hasPasswordProvider = user.providerData.some(p => p.providerId === 'password');
      if (_ltiBootstrapResult.attempted && _ltiBootstrapResult.success && !hasPasswordProvider) {
        renderLtiFirstTimePasswordSetup();
        return;
      }

      // ── 0.5 Admin-forced password change ───────────────────
      // Show forced reset UI if an admin flagged this user via מעקב/ניהול משתמשים.
      // Only applies to users with a password provider — LTI-only users above.
      if (STATE.userData?.mustChangePassword === true && hasPasswordProvider) {
        renderForcedPasswordChange();
        return;
      }

      // ── 1. Consent check ───────────────────────────────────
      // Show if: new user (no terms) OR legacy user (terms accepted but
      // analyticsConsent not yet recorded — undefined means never shown modal)
      if (needsConsentGate(STATE.userData)) {
        renderConsentModal();
        return; // block until consent is submitted
      }

      // ── 2. Survey check ────────────────────────────────────
      // Run in background — don't block initial render
      checkAndShowSurvey();
      _getOrCreateSession();
      _gaIdentify();

      // ── 2.5 Broadcast messages ────────────────────────────
      checkAndShowBroadcasts();

      // ── 3. Normal load ─────────────────────────────────────
      renderNavbar();
      _fetchInitialQuota();
      _cleanupOrphanedCache();
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
      // Check if URL has password reset params
      const urlParams = new URLSearchParams(window.location.search);
      if (urlParams.get('mode') === 'resetPassword' && urlParams.get('oobCode')) {
        renderResetPassword(urlParams.get('oobCode'));
      } else if (_ltiBootstrapResult.attempted && !_ltiBootstrapResult.success) {
        renderLtiFallback(_ltiBootstrapResult.error);
      } else {
        renderAuth();
      }
    }
  });
}

/* ── APP STATE ──────────────────────────────────────────────── */
let STATE = {
  page:     'home',   // home | course | exam
  courseId: null,
  examId:   null,
  tab:      'exams',  // exams | starred | ai-questions
  fireUser: null,     // Firebase Auth user
  userData: null,     // Firestore user doc { starredQuestions: [] }

  // Local caches to avoid re-fetching
  courses:  null,     // Array<Course>
  exams:    {},       // { [courseId]: Array<Exam> }
  examVotes: {},     // { [questionId]: { easy, medium, hard, unsolved } }
  doneExams: [],     // Array<examId> — exams marked as done by user
  inProgressExams: [], // Array<examId> — exams marked as in-progress by user
  savedFilters: {},    // { [courseId]: { fy, fs, fm, fl } } — persists across exam navigation
  isAnalyticsOn: true,  // kill switch loaded from settings/global.isAnalyticsOn
  courseCode:    '',    // official university course code (course.code) — set on course/exam load
  examLabel:     '',    // courseCode_year_sem_moed — set on exam load, cleared on course load
  examQuestions:  [],   // question array snapshot for _questionRef() — set after const questions in renderExam
};

let _userInboxUnsub = null;
let _userInboxReports = [];
let _userInboxUnread = 0;
let _userInboxBroadcasts = [];

function _tsToMillis(ts) {
  return ts?.toMillis?.() || 0;
}

function _hasAdminResponse(report) {
  return Boolean(String(report?.adminResponseText || '').trim()) && !!report?.adminResponseAt;
}

function _isUnreadAdminResponse(report) {
  if (!_hasAdminResponse(report)) return false;
  return _tsToMillis(report.adminResponseAt) > _tsToMillis(report.userLastReadAt);
}

function _isUnreadBroadcast(b) {
  const read = STATE.userData?.readBroadcasts;
  if (Array.isArray(read) && read.includes(b.id)) return false;
  return true;
}

function _updateInboxBadge() {
  const badge = document.getElementById('navbar-msg-badge');
  if (!badge) return;
  if (_userInboxUnread > 0) {
    badge.style.display = 'inline-flex';
    badge.textContent = _userInboxUnread > 99 ? '99+' : String(_userInboxUnread);
  } else {
    badge.style.display = 'none';
    badge.textContent = '';
  }
}

function _recomputeInboxUnread() {
  const reportsUnread = _userInboxReports.filter(_isUnreadAdminResponse).length;
  const broadcastsUnread = _userInboxBroadcasts.filter(_isUnreadBroadcast).length;
  _userInboxUnread = reportsUnread + broadcastsUnread;
  _updateInboxBadge();
}

function _stopUserInboxListener() {
  if (_userInboxUnsub) {
    _userInboxUnsub();
    _userInboxUnsub = null;
  }
  _userInboxReports = [];
  _userInboxBroadcasts = [];
  _userInboxUnread = 0;
  _updateInboxBadge();
}

function _startUserInboxListener() {
  const uid = STATE.fireUser?.uid;
  if (!uid) return;

  if (_userInboxUnsub) _userInboxUnsub();
  _userInboxUnsub = db.collection('reports')
    .where('userId', '==', uid)
    .onSnapshot((snap) => {
      _userInboxReports = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(r => !r.userDeletedAt);
      _recomputeInboxUnread();
    }, (err) => {
      console.warn('User inbox listener failed:', err.message);
    });
}

function _formatInboxDate(ts) {
  const d = ts?.toDate?.();
  if (!d) return '—';
  return d.toLocaleDateString('he-IL', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

async function _markInboxAsRead() {
  const unread = _userInboxReports.filter(_isUnreadAdminResponse);
  if (unread.length) {
    const batch = db.batch();
    unread.forEach(r => {
      batch.update(db.collection('reports').doc(r.id), {
        userLastReadAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    });
    try { await batch.commit(); } catch (e) { console.warn('mark reports read failed:', e.message); }
  }

  // Mark broadcasts as read on user doc
  const unreadBroadcasts = _userInboxBroadcasts.filter(_isUnreadBroadcast);
  if (unreadBroadcasts.length) {
    const uid = STATE.fireUser?.uid;
    if (uid) {
      const ud = STATE.userData || {};
      const existing = Array.isArray(ud.readBroadcasts) ? ud.readBroadcasts.slice() : [];
      unreadBroadcasts.forEach(b => { if (!existing.includes(b.id)) existing.push(b.id); });
      const trimmed = existing.slice(-200);
      STATE.userData = { ...ud, readBroadcasts: trimmed };
      try { await saveUserData(uid, { readBroadcasts: trimmed }); }
      catch (e) { console.warn('mark broadcasts read failed:', e.message); }
    }
  }

  _userInboxUnread = 0;
  _updateInboxBadge();
}

function closeUserInboxModal() {
  document.getElementById('user-inbox-modal')?.remove();
  document.body.style.overflow = '';
}

async function userDeleteInboxMessage(reportId) {
  try {
    const ref = db.collection('reports').doc(reportId);
    const report = _userInboxReports.find(r => r.id === reportId) || null;
    const update = {
      userDeletedAt: firebase.firestore.FieldValue.serverTimestamp(),
    };
    if (report?.adminDeletedAt && !report?.bothDeletedAt) {
      update.bothDeletedAt = firebase.firestore.FieldValue.serverTimestamp();
    }
    await ref.update(update);
    _userInboxReports = _userInboxReports.filter(r => r.id !== reportId);
    _recomputeInboxUnread();
    openUserInboxModal();
  } catch (err) {
    toast('שגיאה במחיקה: ' + err.message, 'error');
  }
}

function openUserInboxModal() {
  document.getElementById('user-inbox-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'user-inbox-modal';
  modal.className = 'modal-overlay';

  // Build a unified, date-sorted list of inbox items (admin replies + broadcasts).
  const reportItems = _userInboxReports
    .filter(_hasAdminResponse)
    .map(r => ({
      kind: 'report',
      id: r.id,
      ts: _tsToMillis(r.adminResponseAt),
      unread: _isUnreadAdminResponse(r),
      data: r,
    }));
  const broadcastItems = _userInboxBroadcasts.map(b => ({
    kind: 'broadcast',
    id: b.id,
    ts: _tsToMillis(b.createdAt),
    unread: _isUnreadBroadcast(b),
    data: b,
  }));
  const rows = [...reportItems, ...broadcastItems].sort((a, b) => b.ts - a.ts);

  const renderRow = (it) => {
    const unreadBadge = it.unread ? '<span class="user-inbox-unread-dot">חדש</span>' : '';
    if (it.kind === 'broadcast') {
      const b = it.data;
      const audienceLabel = b.audience === 'course'
        ? `📣 הודעה למשתתפי ${esc(b.courseName || 'הקורס')}`
        : '📣 הודעה כללית';
      const dateStr = b.createdAt ? _formatInboxDate(b.createdAt) : '';
      return `
        <div class="user-inbox-item">
          <div class="user-inbox-item-head">
            <span>${audienceLabel}</span>
            ${unreadBadge}
            <span style="margin-right:auto;color:var(--muted);font-size:.76rem">${dateStr}</span>
          </div>
          <div style="font-weight:700;font-size:.92rem;color:var(--text)">${esc(b.title || '')}</div>
          <div class="user-inbox-reply">${esc(b.body || '')}</div>
          <div style="display:flex;justify-content:flex-end">
            <button class="btn btn-secondary btn-sm" onclick="userDeleteInboxBroadcast('${esc(b.id)}')">הסר מהתיבה שלי</button>
          </div>
        </div>`;
    }
    const r = it.data;
    const category = r.category === 'bug' ? '⚠ תקלה' : '✉ פנייה';
    return `
      <div class="user-inbox-item">
        <div class="user-inbox-item-head">
          <span>${category}</span>
          ${unreadBadge}
          <span style="margin-right:auto;color:var(--muted);font-size:.76rem">${_formatInboxDate(r.adminResponseAt)}</span>
        </div>
        <div class="user-inbox-orig">הפנייה שלך: ${esc(r.message || '')}</div>
        <div class="user-inbox-reply">${esc(r.adminResponseText || '')}</div>
        <div style="display:flex;justify-content:flex-end">
          <button class="btn btn-secondary btn-sm" onclick="userDeleteInboxMessage('${esc(r.id)}')">הסר מהתיבה שלי</button>
        </div>
      </div>`;
  };

  modal.innerHTML = `
    <div class="modal-card user-inbox-card">
      <div class="modal-header">
        <h3 style="margin:0;font-size:1.1rem">📩 הודעות מהמנהל</h3>
        <button class="modal-close" onclick="closeUserInboxModal()">✕</button>
      </div>
      <div class="user-inbox-body">
        ${rows.length ? rows.map(renderRow).join('') : '<div class="empty" style="padding:2rem 1rem"><span class="ei">📭</span><h3>אין הודעות חדשות</h3><p>כאן יופיעו תגובות מהמנהל לפניות שלך</p></div>'}
      </div>
      <div style="padding:0 1.25rem 1.1rem;display:flex;justify-content:flex-end">
        <button class="btn btn-secondary" onclick="closeUserInboxModal()">סגור</button>
      </div>
    </div>`;

  document.body.appendChild(modal);
  document.body.style.overflow = 'hidden';
  modal.addEventListener('click', e => { if (e.target === modal) closeUserInboxModal(); });

  _markInboxAsRead().catch(err => console.warn('Failed to mark inbox read:', err.message));
}

async function userDeleteInboxBroadcast(broadcastId) {
  try {
    const uid = STATE.fireUser?.uid;
    if (!uid) return;
    const ud = STATE.userData || {};
    const dismissed = Array.isArray(ud.dismissedBroadcasts) ? ud.dismissedBroadcasts.slice() : [];
    if (!dismissed.includes(broadcastId)) dismissed.push(broadcastId);
    const trimmed = dismissed.slice(-200);
    STATE.userData = { ...ud, dismissedBroadcasts: trimmed };
    await saveUserData(uid, { dismissedBroadcasts: trimmed });
    _userInboxBroadcasts = _userInboxBroadcasts.filter(b => b.id !== broadcastId);
    _recomputeInboxUnread();
    openUserInboxModal();
  } catch (err) {
    toast('שגיאה במחיקה: ' + err.message, 'error');
  }
}
window.userDeleteInboxBroadcast = userDeleteInboxBroadcast;

/* ── ANALYTICS ─────────────────────────────────────────────── */
const SESSION_TIMEOUT_MS  = 4 * 60 * 60 * 1000;  // 4 hours
const LOG_THROTTLE_MS     = 1_000;           // 1 s minimum between same event type
const _lastLogTime        = {};
let   _filterDebounceTimer = null;
const _difficultyDebounceTimers = {};        // per-question 10 s debounce for difficulty_voted

function _getOrCreateSession() {
  // GDPR/CCPA: never write a tracking identifier to the device without consent.
  if (!STATE.isAnalyticsOn || !STATE.userData?.analyticsConsent) {
    localStorage.removeItem('vaultau_session'); // purge any previously stored session
    return null;
  }
  try {
    const uid = STATE.fireUser?.uid;
    if (!uid) return null;
    const stored = JSON.parse(localStorage.getItem('vaultau_session') || 'null');
    const now = Date.now();
    // Reuse session only if same user, not timed out
    if (stored?.id && stored?.uid === uid && stored?.lastActivity && (now - stored.lastActivity) < SESSION_TIMEOUT_MS) {
      localStorage.setItem('vaultau_session', JSON.stringify({ ...stored, lastActivity: now }));
      return stored.id;
    }
    const sessionId = genId();
    localStorage.setItem('vaultau_session', JSON.stringify({ id: sessionId, uid, createdAt: now, lastActivity: now }));
    if (STATE.isAnalyticsOn && STATE.userData?.analyticsConsent) {
      db.collection('analytics_events').add({
        uid,
        sessionId,
        role:      _role(),
        event:     'session_start',
        payload:   {},
        timestamp: firebase.firestore.FieldValue.serverTimestamp(),
        expiresAt: firebase.firestore.Timestamp.fromMillis(now + 60 * 24 * 60 * 60 * 1000),
      }).catch(e => console.warn('session_start log failed:', e));
    }
    return sessionId;
  } catch (e) {
    console.warn('_getOrCreateSession error:', e);
    return null;
  }
}

function _logEvent(name, payload = {}) {
  if (!STATE.isAnalyticsOn) return;
  if (!STATE.userData?.analyticsConsent) return;
  const now = Date.now();
  if ((now - (_lastLogTime[name] || 0)) < LOG_THROTTLE_MS) return;
  _lastLogTime[name] = now;
  const uid = STATE.fireUser?.uid;
  if (!uid) return;
  const sessionId = _getOrCreateSession();
  db.collection('analytics_events').add({
    uid,
    sessionId,
    role:      _role(),
    event:     name,
    payload,
    timestamp: firebase.firestore.FieldValue.serverTimestamp(),
    expiresAt: firebase.firestore.Timestamp.fromMillis(now + 60 * 24 * 60 * 60 * 1000),
  }).catch(e => console.warn(`_logEvent(${name}) failed:`, e));
}

/* ── GA4 AGGREGATE ANALYTICS ───────────────────────────────── */
function _ga(eventName, params = {}) {
  if (typeof gtag !== 'function') return;
  const safe = { ...params };
  delete safe.uid; delete safe.email; delete safe.name; delete safe.displayName;
  gtag('event', eventName, safe);
}
function _cc()  { return STATE.courseCode || STATE.courseId || ''; }
function _eid() { return STATE.examLabel  || STATE.examId  || ''; }
function _role() {
  if (STATE.userData?.role === 'admin') return 'admin';
  if (STATE.userData?.ltiRole) return STATE.userData.ltiRole;
  return STATE.userData?.role || 'student';
}
function _gaIdentify() {
  if (typeof gtag !== 'function') return;
  gtag('set', 'user_properties', { user_role: _role() });
}

// Fires _ga('login') — placed in doLogin()/maybeBootstrapLtiSession() only,
// never in onAuthStateChanged, so no refresh inflation.
function _gaLogin(method) {
  _ga('login', { method });
}

/* ── BOOTSTRAP ─────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  initAppBootstrap();

  // Browser Back / Forward
  window.addEventListener('popstate', async (e) => {
    if (!STATE.fireUser) return;
    const hs = e.state || { page: 'home', courseId: null, examId: null };
    STATE.page          = hs.page     || 'home';
    STATE.courseId      = hs.courseId || null;
    STATE.examId        = hs.examId   || null;
    // Guard: if consent is missing, block navigation and re-show modal
    if (needsConsentGate(STATE.userData)) {
      document.getElementById('app').innerHTML = '';
      renderConsentModal();
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
          <div style="text-align:center;margin-top:.7rem">
            <a href="#" onclick="showForgotPassword();return false"
               style="color:var(--muted);font-size:.82rem;text-decoration:underline;cursor:pointer">שכחתי סיסמה</a>
          </div>
        </div>

        <!-- Forgot password form -->
        <div id="f-forgot" style="display:none">
          <div style="text-align:center;margin-bottom:1.2rem">
            <div style="font-size:2.2rem;margin-bottom:.5rem">🔑</div>
            <h2 style="font-size:1.15rem;color:var(--fg);margin:0 0 .3rem">שכחתי סיסמה</h2>
            <p style="color:var(--muted);font-size:.85rem;line-height:1.5;margin:0">
              הזן את כתובת האימייל שלך ונשלח לך לינק לאיפוס הסיסמה
            </p>
          </div>
          <div id="forgot-success" class="form-error" style="background:#d1fae5;color:#065f46;border-color:#10b981;display:none">
            אם האימייל קיים במערכת, נשלח אליך לינק לאיפוס הסיסמה. בדוק את תיבת הדואר שלך.
          </div>
          <div class="form-group">
            <label>אימייל</label>
            <input id="forgot-email" type="email" placeholder="your@email.com">
          </div>
          <button id="forgot-btn" class="btn btn-primary" style="width:100%;justify-content:center"
            onclick="doForgotPassword()">שלח לינק לאיפוס ←</button>
          <button class="btn" style="width:100%;justify-content:center;margin-top:.5rem;
                 color:var(--muted);background:transparent;border-color:transparent;font-size:.82rem"
            onclick="backToLogin()">← חזרה לכניסה</button>
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
  document.getElementById('forgot-email')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') doForgotPassword();
  });
}


function switchTab(t) {
  document.querySelectorAll('.auth-tab').forEach((el, i) =>
    el.classList.toggle('active', (i === 0) === (t === 'login'))
  );
  document.getElementById('f-login').style.display  = t === 'login'  ? 'block' : 'none';
  document.getElementById('f-signup').style.display = t === 'signup' ? 'block' : 'none';
  const fForgot = document.getElementById('f-forgot');
  if (fForgot) fForgot.style.display = 'none';
  document.querySelectorAll('.auth-tabs').forEach(el => el.style.display = '');
  document.getElementById('auth-err').classList.remove('show');
}

/* ── Forgot password ─────────────────────────────────────── */
function showForgotPassword() {
  document.getElementById('f-login').style.display  = 'none';
  document.getElementById('f-signup').style.display = 'none';
  document.getElementById('f-forgot').style.display = 'block';
  document.querySelectorAll('.auth-tabs').forEach(el => el.style.display = 'none');
  document.getElementById('auth-err').classList.remove('show');
  document.getElementById('forgot-success').style.display = 'none';
  document.getElementById('forgot-email').value = '';
  document.getElementById('forgot-email').focus();
}

function backToLogin() {
  document.getElementById('f-forgot').style.display = 'none';
  document.getElementById('f-login').style.display  = 'block';
  document.querySelectorAll('.auth-tabs').forEach(el => el.style.display = '');
  document.getElementById('auth-err').classList.remove('show');
}

async function doForgotPassword() {
  const email = document.getElementById('forgot-email').value.trim().toLowerCase();
  const errEl = document.getElementById('auth-err');
  const successEl = document.getElementById('forgot-success');
  errEl.classList.remove('show');
  successEl.style.display = 'none';

  if (!email) {
    authErr('נא להזין כתובת אימייל');
    return;
  }

  const btn = document.getElementById('forgot-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'שולח...'; }

  try {
    const res = await fetch('/.netlify/functions/send-reset-password-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });

    if (res.status === 429) {
      authErr('יותר מדי בקשות — נסה שוב מאוחר יותר');
      return;
    }

    // Always show success (server returns 200 even if email doesn't exist)
    successEl.style.display = 'block';
  } catch {
    authErr('שגיאת רשת — בדוק חיבור לאינטרנט');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'שלח לינק לאיפוס ←'; }
  }
}

/* ── Reset password (landing from email link) ──────────── */
function renderResetPassword(oobCode) {
  // Sanitize oobCode to prevent XSS (only allow alphanumeric, hyphens, underscores)
  const safeCode = oobCode.replace(/[^a-zA-Z0-9_\-]/g, '');
  document.getElementById('app').innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="auth-logo">
          <span class="icon">🔑</span>
          <h1>VaultAU</h1>
          <p>בחירת סיסמה חדשה</p>
        </div>
        <div id="auth-err" class="form-error"></div>
        <div id="reset-success" style="display:none;text-align:center;padding:1rem 0">
          <div style="font-size:2.2rem;margin-bottom:.5rem">✅</div>
          <p style="color:var(--fg);font-size:1rem;font-weight:600;margin:0 0 .5rem">הסיסמה שונתה בהצלחה!</p>
          <p style="color:var(--muted);font-size:.88rem;margin:0 0 1rem">ניתן להתחבר עם הסיסמה החדשה</p>
          <button class="btn btn-primary" style="width:100%;justify-content:center"
            onclick="window.location.href='/'">כניסה ←</button>
        </div>
        <div id="reset-form">
          <div class="form-group">
            <label>סיסמה חדשה</label>
            <div class="pass-wrap">
              <input id="r-pass" type="password" placeholder="לפחות 6 תווים">
              <button type="button" class="pass-eye" onclick="togglePassVis('r-pass','r-eye')"
                title="הצג / הסתר סיסמה" id="r-eye" aria-label="הצג סיסמה">
                ${_eyeIcon(false)}
              </button>
            </div>
          </div>
          <div class="form-group">
            <label>אימות סיסמה</label>
            <div class="pass-wrap">
              <input id="r-pass2" type="password" placeholder="הזן שוב את הסיסמה">
              <button type="button" class="pass-eye" onclick="togglePassVis('r-pass2','r-eye2')"
                title="הצג / הסתר סיסמה" id="r-eye2" aria-label="הצג סיסמה">
                ${_eyeIcon(false)}
              </button>
            </div>
          </div>
          <button id="reset-btn" class="btn btn-primary" style="width:100%;justify-content:center">שמור סיסמה חדשה ←</button>
        </div>
      </div>
    </div>`;

  document.getElementById('reset-btn')?.addEventListener('click', () => doResetPassword(safeCode));
  document.getElementById('r-pass2')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') doResetPassword(safeCode);
  });
}

async function doResetPassword(oobCode) {
  const pass  = document.getElementById('r-pass').value;
  const pass2 = document.getElementById('r-pass2').value;
  const errEl = document.getElementById('auth-err');
  errEl.classList.remove('show');

  if (!pass || !pass2) {
    authErr('נא למלא את כל השדות');
    return;
  }
  if (pass.length < 6) {
    authErr('סיסמה חייבת להכיל לפחות 6 תווים');
    return;
  }
  if (pass !== pass2) {
    authErr('הסיסמאות לא תואמות');
    return;
  }

  const btn = document.getElementById('reset-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'שומר...'; }

  try {
    // Verify the code is valid, then set new password
    await auth.verifyPasswordResetCode(oobCode);
    await auth.confirmPasswordReset(oobCode, pass);

    // Show success, hide form
    document.getElementById('reset-form').style.display = 'none';
    document.getElementById('reset-success').style.display = 'block';

    // Clean URL params
    history.replaceState({}, '', '/');
  } catch (e) {
    const messages = {
      'auth/expired-action-code':  'הלינק פג תוקף — יש לבקש איפוס סיסמה מחדש',
      'auth/invalid-action-code':  'הלינק אינו תקין או שכבר נעשה בו שימוש',
      'auth/weak-password':        'הסיסמה חלשה מדי — נסה סיסמה חזקה יותר',
    };
    authErr(messages[e.code] || 'שגיאה באיפוס הסיסמה: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = 'שמור סיסמה חדשה ←'; }
  }
}

function authErr(msg) {
  const e = document.getElementById('auth-err');
  if (!e) return;
  e.textContent = msg;
  e.classList.add('show');
}

/* ── LTI Password Setup Modal ──────────────────────────── */
function renderLtiPasswordSetupModal() {
  const container = document.getElementById('app');
  if (!container) return;
  
  const modalHtml = `
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="auth-logo">
          <span class="icon">🔗</span>
          <h1>VaultAU</h1>
          <p>קישור חשבון Moodle לאתר</p>
        </div>
        <div id="lti-auth-err" class="form-error"></div>
        <div id="lti-setup-form">
          <p style="color:var(--fg);font-size:.95rem;margin-bottom:1.5rem;text-align:center;line-height:1.5">
            נמצא חשבון Moodle עם הכתובת <strong>${esc(_ltiLinkingState.email)}</strong>.<br>
            הגדר סיסמה כדי להתחבר דרך האתר.
          </p>
          <div class="form-group">
            <label>סיסמה חדשה</label>
            <div class="pass-wrap">
              <input id="lti-pass" type="password" placeholder="לפחות 6 תווים">
              <button type="button" class="pass-eye" onclick="togglePassVis('lti-pass','lti-eye')"
                title="הצג / הסתר סיסמה" id="lti-eye" aria-label="הצג סיסמה">
                ${_eyeIcon(false)}
              </button>
            </div>
          </div>
          <div class="form-group">
            <label>אימות סיסמה</label>
            <div class="pass-wrap">
              <input id="lti-pass2" type="password" placeholder="הזן שוב את הסיסמה">
              <button type="button" class="pass-eye" onclick="togglePassVis('lti-pass2','lti-eye2')"
                title="הצג / הסתר סיסמה" id="lti-eye2" aria-label="הצג סיסמה">
                ${_eyeIcon(false)}
              </button>
            </div>
          </div>
          <button id="lti-setup-btn" class="btn btn-primary" style="width:100%;justify-content:center">קישור חשבון ←</button>
          <button id="lti-cancel-btn" class="btn" style="width:100%;justify-content:center;margin-top:.5rem">ביטול</button>
        </div>
      </div>
    </div>
  `;
  
  container.innerHTML = modalHtml;
  document.getElementById('lti-setup-btn')?.addEventListener('click', () => doLtiPasswordSetup());
  document.getElementById('lti-cancel-btn')?.addEventListener('click', () => {
    window.location.reload();
  });
  document.getElementById('lti-pass2')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') doLtiPasswordSetup();
  });
}

async function doLtiPasswordSetup() {
  const pass  = document.getElementById('lti-pass').value;
  const pass2 = document.getElementById('lti-pass2').value;
  const errEl = document.getElementById('lti-auth-err');
  errEl.classList.remove('show');
  errEl.textContent = '';

  if (!pass || !pass2) {
    errEl.textContent = 'נא למלא את כל השדות';
    errEl.classList.add('show');
    return;
  }
  if (pass.length < 6) {
    errEl.textContent = 'סיסמה חייבת להכיל לפחות 6 תווים';
    errEl.classList.add('show');
    return;
  }
  if (pass !== pass2) {
    errEl.textContent = 'הסיסמאות לא תואמות';
    errEl.classList.add('show');
    return;
  }

  const btn = document.getElementById('lti-setup-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'קושר...'; }
  authBusy(true);

  try {
    // Create a new Firebase auth account with email+password
    const cred = await auth.createUserWithEmailAndPassword(
      _ltiLinkingState.email,
      pass
    );
    const newUid = cred.user.uid;

    // ── Update the Firestore user doc to link both auth methods ──
    const ltiUid = _ltiLinkingState.ltiUid;
    
    // Fetch existing doc data
    const existingDocSnap = await db.collection('users').doc(ltiUid).get();
    if (existingDocSnap.exists) {
      const existingData = existingDocSnap.data();
      const rawAuthMethods = Array.isArray(existingData.authMethods) ? existingData.authMethods : [];
      const newAuthMethods = rawAuthMethods
        .flatMap((m) => Array.isArray(m) ? m : [m])
        .filter((m) => typeof m === 'string');
      if (!newAuthMethods.includes('web')) {
        newAuthMethods.push('web');
      }
      const newAuthOrigin = newAuthMethods.length > 1 ? 'both' : 'lti';

      // Update the doc with new auth tracking
      await db.collection('users').doc(ltiUid).update({
        authMethods: newAuthMethods,
        authOrigin: newAuthOrigin,
        lastSignInMethod: 'web',
        lastSignInAt: new Date(),
      });
    }

    // Clear state
    _ltiLinkingState.email = null;
    _ltiLinkingState.pass = null;
    _ltiLinkingState.ltiUid = null;

    // User is authenticated via onAuthStateChanged
    authBusy(false);

  } catch (e) {
    const messages = {
      'auth/email-already-in-use': 'אימייל כבר קיים בחשבון אחר',
      'auth/invalid-email':        'פורמט אימייל לא תקין',
      'auth/weak-password':        'הסיסמה חלשה מדי',
    };
    errEl.textContent = messages[e.code] || ('שגיאה בקישור החשבון: ' + e.message);
    errEl.classList.add('show');
    if (btn) { btn.disabled = false; btn.textContent = 'קישור חשבון ←'; }
    authBusy(false);
  }
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
    _gaLogin('email');
    // onAuthStateChanged will handle the authorized flow
  } catch (e) {
    // Check if this is an email-not-found scenario and a Moodle account exists
    if (['auth/user-not-found', 'auth/invalid-login-credentials', 'auth/invalid-credential'].includes(e.code)) {
      try {
        // Query for existing user doc by email (could be from Moodle)
        const usersSnap = await db.collection('users').where('email', '==', email).limit(1).get();
        if (!usersSnap.empty) {
          const ltiUserDoc = usersSnap.docs[0];
          const ltiUserData = ltiUserDoc.data();
          // If user has LTI auth, offer to set password for web access
          if (Array.isArray(ltiUserData.authMethods) && ltiUserData.authMethods.includes('lti')) {
            authBusy(false);
            _ltiLinkingState.email = email;
            _ltiLinkingState.pass = pass;
            _ltiLinkingState.ltiUid = ltiUserDoc.id;
            renderLtiPasswordSetupModal();
            return;
          }
        }
      } catch (queryErr) {
        console.warn('Failed to check for existing email:', queryErr);
      }
    }

    const messages = {
      // auth/user-not-found is no longer emitted by newer Firebase SDK versions.
      // Kept here for emulator / legacy SDK compatibility only.
      'auth/user-not-found':     'אימייל לא קיים במערכת',
      'auth/wrong-password':     'סיסמה שגויה',
      // auth/invalid-login-credentials replaces both auth/wrong-password and
      // auth/user-not-found in newer SDK versions — use a generic message to
      // avoid leaking whether the email or password is incorrect (user enumeration).
      'auth/invalid-login-credentials': 'אימייל או סיסמה שגויים',
      'auth/invalid-credential': 'אימייל או סיסמה שגויים',
      'auth/invalid-email':      'פורמט אימייל לא תקין',
      'auth/too-many-requests':  'יותר מדי ניסיונות — נסה שוב מאוחר יותר',
    };
    authErr(messages[e.code] || 'שגיאת התחברות — נסה שוב');
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

/* ── LTI account linking state ──────────────────────────── */
const _ltiLinkingState = {
  email: null,
  pass: null,
  ltiUid: null,
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
    _ga('sign_up', { method: 'email' });

    // onAuthStateChanged will handle user-doc creation + terms modal

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
  _stopUserInboxListener();
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
      <div class="navbar-actions">
        <button class="btn btn-ghost btn-sm nav-menu-btn" id="nav-menu-btn"
          onclick="_openNavMenu()" aria-label="תפריט">
          <svg width="18" height="14" viewBox="0 0 18 14" fill="none">
            <rect y="0" width="18" height="2" rx="1" fill="currentColor"/>
            <rect y="6" width="18" height="2" rx="1" fill="currentColor"/>
            <rect y="12" width="18" height="2" rx="1" fill="currentColor"/>
          </svg>
        </button>
        <button class="navbar-message-btn" onclick="openUserInboxModal()" title="הודעות מנהל" aria-label="הודעות מנהל">
          <svg class="navbar-message-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="3.5" y="5.5" width="17" height="13" rx="2.4"></rect>
            <path d="M4.6 7.2L12 13.2l7.4-6"></path>
          </svg>
          <span id="navbar-msg-badge" class="navbar-message-badge" style="display:none"></span>
        </button>
        <div class="navbar-user">
          <div class="av">${displayName[0].toUpperCase()}</div>
          <span>${esc(displayName)}</span>
        </div>
        <span id="navbar-quota-badge" style="font-size:.72rem;padding:2px 8px;border-radius:12px;background:rgba(255,255,255,.2);color:#fff;white-space:nowrap;cursor:default" title="מכסת יצירת שאלות יומית"></span>
      </div>
      <span class="navbar-brand" onclick="goHome()">
        <span class="ni">📚</span> VaultAU
      </span>
    </nav>
    <div id="page"></div>
    <div class="toast-wrap" id="toast-wrap"></div>
    <div class="copy-tip" id="copy-tip">הועתק!</div>`;

  _updateInboxBadge();
  _startUserInboxListener();
}

/* ── NAV MENU ────────────────────────────────────────────── */
let _navMenuClickOutside = null;

function _openNavMenu() {
  if (document.getElementById('nav-dropdown')) { _closeNavMenu(); return; }
  const dropdown = document.createElement('div');
  dropdown.id        = 'nav-dropdown';
  dropdown.className = 'nav-dropdown';
  dropdown.innerHTML = `
    <button class="nav-dropdown-item" onclick="goPrivacy()">
      <span>פרטיות</span>
    </button>
    <div class="nav-dropdown-divider"></div>
    <button class="nav-dropdown-item danger" onclick="doLogout()">
      <span>יציאה</span>
    </button>`;

  // Anchor dropdown directly below the hamburger button
  const btn = document.getElementById('nav-menu-btn');
  btn.style.position = 'relative';
  btn.appendChild(dropdown);
  _navMenuClickOutside = (e) => {
    const btn = document.getElementById('nav-menu-btn');
    if (!btn?.contains(e.target)) _closeNavMenu();
  };
  setTimeout(() => document.addEventListener('mousedown', _navMenuClickOutside), 0);
}

function _closeNavMenu() {
  const btn = document.getElementById('nav-menu-btn');
  const dropdown = btn?.querySelector('#nav-dropdown');
  if (dropdown) {
    dropdown.style.animation = 'nav-dropdown-out .14s ease-in forwards';
    setTimeout(() => dropdown.remove(), 130);
  }
  if (_navMenuClickOutside) {
    document.removeEventListener('mousedown', _navMenuClickOutside);
    _navMenuClickOutside = null;
  }
}

/* ── ROUTING ─────────────────────────────────────────────────── */
function requireTermsAccepted() {
  // Central gate — called before ANY page render.
  // If consent is missing, wipe the app and show the consent modal.
  // Returns true if access is allowed, false if blocked.
  if (!STATE.fireUser) return false;          // not logged in — auth handles this
  if (!needsConsentGate(STATE.userData)) return true;
  // Either terms not accepted or research consent not yet recorded
  document.getElementById('app').innerHTML = '';
  renderConsentModal();
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
  if (STATE.page === 'home')           renderHome();
  else if (STATE.page === 'course')    renderCourse();
  else if (STATE.page === 'exam')      renderExam();
  else if (STATE.page === 'privacy')   renderPrivacy();
  else if (STATE.page === 'my-exams')  renderLecturerExams();
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

function goPrivacy() {
  _closeNavMenu();
  STATE.page = 'privacy';
  history.pushState({ page: 'privacy', courseId: null, examId: null }, '');
  renderPrivacy();
}

/* ══════════════════════════════════════════════════════════
   CONSENT MODAL  (two-tier: Terms required + Research opt-in)
══════════════════════════════════════════════════════════ */

async function renderConsentModal() {
  // Render modal immediately — terms link starts as plain bold text placeholder
  document.getElementById('app').innerHTML = `
    <div id="consent-overlay" style="
      position:fixed;inset:0;background:rgba(0,0,0,.6);
      display:flex;align-items:center;justify-content:center;
      z-index:9999;padding:1rem">
      <div class="consent-card">

        <div style="text-align:center;margin-bottom:1.4rem">
          <span style="font-size:2.2rem">🛡️</span>
          <h2 style="margin:.5rem 0 .2rem;font-size:1.2rem;color:#1e293b">פרטיות ותנאי שימוש</h2>
          <p style="font-size:.82rem;color:#64748b;margin:0">אנא קרא/י ואשר/י לפני הכניסה למערכת</p>
        </div>

        <label class="consent-check-label" id="consent-terms-label">
          <input type="checkbox" id="cb-terms" onchange="onConsentChange()">
          <span class="consent-check-text">
            אני מסכים/ה ל<span id="consent-terms-link" style="font-weight:600">תנאי השימוש</span><span style="color:#dc2626;font-weight:700;margin-right:.15rem">*</span>
          </span>
        </label>
        <div id="consent-terms-error" style="display:none;color:#dc2626;font-size:.78rem;margin-top:-.2rem;margin-bottom:.4rem;padding-right:.4rem">⚠️ חייב לאשר תנאי שימוש לפני הכניסה</div>

        <div style="border-top:1px dashed #e2e8f0;margin:.75rem 0"></div>

        <label class="consent-check-label" id="consent-research-label">
          <input type="checkbox" id="cb-research" onchange="onConsentChange()">
          <span class="consent-check-text">
            אני מאשר/ת שיתוף של נתוני שימוש אנונימיים לטובת מחקר אקדמי ושיפור המערכת 🚀
          </span>
        </label>
       
        <button id="consent-submit-btn" class="btn btn-primary"
          style="width:100%;justify-content:center;font-size:.95rem;padding:.75rem;margin-top:1.4rem"
          onclick="submitConsent()">
          המשך ✓
        </button>

      </div>
    </div>`;

  // Fetch termsUrl in background — upgrade plain-text link to clickable anchor
  try {
    const doc = await db.collection('settings').doc('global').get();
    const termsUrl = doc.exists ? (doc.data()?.termsUrl || null) : null;
    if (termsUrl) {
      const el = document.getElementById('consent-terms-link');
      if (el) el.outerHTML = `<a id="consent-terms-link" href="${termsUrl}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" style="color:#3b82f6;text-decoration:underline;font-weight:600">תנאי השימוש</a>`;
    }
  } catch (_) { /* link stays as plain bold text — graceful fallback */ }
}

function onConsentChange() {
  const cbTerms = document.getElementById('cb-terms');
  if (!cbTerms) return;
  // Hide error message once user checks the box
  if (cbTerms.checked) {
    const errEl = document.getElementById('consent-terms-error');
    if (errEl) errEl.style.display = 'none';
    document.getElementById('consent-terms-label')?.classList.remove('consent-check-label--error');
  }
}

async function submitConsent() {
  const cbTerms    = document.getElementById('cb-terms');
  const cbResearch = document.getElementById('cb-research');
  const termsOk    = cbTerms?.checked;
  if (!termsOk) {
    document.getElementById('consent-terms-label')?.classList.add('consent-check-label--error');
    const errEl = document.getElementById('consent-terms-error');
    if (errEl) errEl.style.display = 'block';
    document.getElementById('consent-terms-label')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }

  const btn = document.getElementById('consent-submit-btn');
  if (btn) { btn.disabled = true; btn.textContent = '💾 שומר...'; }

  try {
    const uid = STATE.fireUser?.uid;
    if (!uid) throw new Error('לא מחובר');

    const now         = firebase.firestore.FieldValue.serverTimestamp();
    const nowISO       = new Date().toISOString(); // for arrayUnion — serverTimestamp() can't be nested
    const consentValue = cbResearch?.checked === true;
    const updates = {
      analyticsConsent: consentValue,
      consentDate:      consentValue ? now : firebase.firestore.FieldValue.delete(),
      consentAuditLog:  firebase.firestore.FieldValue.arrayUnion({
        status: consentValue ? 'enabled' : 'disabled',
        at:     nowISO,
      }),
    };
    // Only write acceptedTerms/acceptedTermsAt if not already set (legacy users)
    if (!STATE.userData?.acceptedTerms) {
      updates.acceptedTerms   = true;
      updates.acceptedTermsAt = now;
    }

    await db.collection('users').doc(uid).update(updates).catch(async (err) => {
      if (err?.code === 'not-found') {
        await db.collection('users').doc(uid).set({
          uid,
          email:            (STATE.fireUser.email || '').toLowerCase().trim(),
          displayName:      STATE.fireUser.displayName || '',
          role:             'student',
          acceptedTerms:    true,
          acceptedTermsAt:  now,
          analyticsConsent: consentValue,
          ...(consentValue ? { consentDate: now } : {}),
          consentAuditLog:  [{ status: consentValue ? 'enabled' : 'disabled', at: nowISO }],
          createdAt:        now,
        });
        return;
      }
      throw err;
    });

    STATE.userData = {
      ...STATE.userData,
      acceptedTerms:    true,
      analyticsConsent: consentValue,
    };

    _getOrCreateSession();
    renderNavbar();
    history.replaceState({ page: 'home', courseId: null, examId: null }, '');
    renderPage();

  } catch (e) {
    console.error('submitConsent error:', e);
    if (btn) { btn.disabled = false; btn.textContent = 'המשך ✓'; }
    alert('שגיאה בשמירת האישור: ' + e.message + '\nנסה שוב.');
  }
}

/* ══════════════════════════════════════════════════════════
   PRIVACY PAGE
══════════════════════════════════════════════════════════ */

function renderPrivacy() {
  const page = document.getElementById('page');
  const currentConsent = STATE.userData?.analyticsConsent === true;
  page.innerHTML = `
    <div class="container" style="max-width:600px">
      <div class="breadcrumb">
        <a onclick="goHome()" style="cursor:pointer">🏠 ראשי</a>
        <span>›</span><span>פרטיות</span>
      </div>
      <div class="page-header">
        <h1 class="page-title">🔒 פרטיות ומחקר</h1>
      </div>

      <div class="privacy-section">
        <h2>תנאי שימוש ומדיניות פרטיות</h2>
        <p>המערכת מאחסנת את המידע שלך בצורה מאובטחת. לצפייה במסמך תנאי השימוש המלא:</p>
        <a id="privacy-terms-link" href="#" target="_blank" rel="noopener noreferrer"
           class="btn btn-secondary" style="display:inline-flex">
          📄 תנאי שימוש מלאים ←
        </a>
      </div>

      <div class="privacy-section">
        <h2>השתתפות במחקר</h2>
        <p>נתוני השימוש האנונימיים משמשים לצורך מחקר אקדמי ושיפור המערכת.</p>
        <p>ניתן לשנות הסכמה זו בכל עת.</p>
        <label class="consent-check-label">
          <input type="checkbox" id="privacy-consent-cb" ${currentConsent ? 'checked' : ''}
                 onchange="onPrivacyConsentChange()">
          <span class="consent-check-text">
            אני מסכים/ה שנתוני השימוש שלי ישמשו למחקר אקדמי אנונימי
          </span>
        </label>
      </div>

      <div id="privacy-confirm-block"></div>

      <button id="privacy-save-btn" class="btn btn-primary"
              onclick="savePrivacyConsent()" disabled>
        שמור שינויים
      </button>
    </div>`;

  db.collection('settings').doc('global').get().then(doc => {
    const url = doc.exists ? doc.data()?.termsUrl : null;
    const el  = document.getElementById('privacy-terms-link');
    if (el && url) el.href = url;
  }).catch(() => {});
}

function onPrivacyConsentChange() {
  const cb = document.getElementById('privacy-consent-cb');
  const currentConsent = STATE.userData?.analyticsConsent === true;
  const confirmBlock = document.getElementById('privacy-confirm-block');
  const saveBtn = document.getElementById('privacy-save-btn');

  if (currentConsent && !cb.checked) {
    // Opting OUT — show confirm immediately, keep save disabled until confirmed
    saveBtn.disabled = true;
    _showPrivacyConfirm();
  } else if (!currentConsent && cb.checked) {
    // Opting IN — no confirm needed, enable save
    confirmBlock.innerHTML = '';
    saveBtn.disabled = false;
  } else {
    // Back to original state
    confirmBlock.innerHTML = '';
    saveBtn.disabled = true;
  }
}

let _privacyConfirmResolve = null;

function _showPrivacyConfirm() {
  return new Promise(resolve => {
    _privacyConfirmResolve = resolve;
    document.getElementById('privacy-confirm-block').innerHTML = `
      <div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;
                  padding:1rem;margin-bottom:1rem">
        <p style="color:#7f1d1d;font-size:.88rem;margin:0 0 .75rem;font-weight:600">
          האם אתה בטוח? ביטול ההסכמה יפסיק את איסוף הנתונים מעכשיו.
        </p>
        <div style="display:flex;gap:.5rem;flex-wrap:wrap">
          <button class="btn btn-sm" style="background:#dc2626;color:#fff;border-color:#dc2626"
            onclick="_resolvePrivacyConfirm(true)">בטוח</button>
          <button class="btn btn-sm" onclick="_resolvePrivacyConfirm(false)">ביטול</button>
        </div>
      </div>`;
  });
}

function _resolvePrivacyConfirm(confirmed) {
  document.getElementById('privacy-confirm-block').innerHTML = '';
  const cb  = document.getElementById('privacy-consent-cb');
  const btn = document.getElementById('privacy-save-btn');
  if (confirmed) {
    // User confirmed opt-out — keep unchecked, enable save
    if (btn) btn.disabled = false;
  } else {
    // User cancelled — restore checkbox, keep save disabled
    if (cb)  cb.checked   = true;
    if (btn) btn.disabled = true;
  }
  if (_privacyConfirmResolve) {
    _privacyConfirmResolve(confirmed);
    _privacyConfirmResolve = null;
  }
}

async function savePrivacyConsent() {
  const cb         = document.getElementById('privacy-consent-cb');
  const newConsent = cb.checked;
  const oldConsent = STATE.userData?.analyticsConsent === true;
  if (newConsent === oldConsent) return;

  const btn = document.getElementById('privacy-save-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'שומר...'; }

  try {
    const uid    = STATE.fireUser?.uid;
    if (!uid) throw new Error('לא מחובר');
    const nowISO = new Date().toISOString(); // arrayUnion can't contain serverTimestamp()
    await db.collection('users').doc(uid).update({
      analyticsConsent: newConsent,
      consentDate:      newConsent ? firebase.firestore.FieldValue.serverTimestamp() : firebase.firestore.FieldValue.delete(),
      consentAuditLog:  firebase.firestore.FieldValue.arrayUnion({
        status: newConsent ? 'enabled' : 'disabled',
        at:     nowISO,
      }),
    });
    STATE.userData = { ...STATE.userData, analyticsConsent: newConsent };
    _getOrCreateSession();
    toast(newConsent ? '✅ ההסכמה נשמרה' : '✅ ההסכמה בוטלה — הנתונים לא יאספו יותר');
    goHome();
  } catch (e) {
    toast('שגיאה בשמירה — נסה שוב', 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'שמור שינויים'; }
  }
}

/* ══════════════════════════════════════════════════════════
   HOME
══════════════════════════════════════════════════════════ */

async function renderHome() {
  const page = document.getElementById('page');
  page.innerHTML = `<div class="container"><div class="spinner" style="margin-top:3rem"></div></div>`;

  try {
    const isAdmin = STATE.userData?.role === 'admin';

    const courseSnap = await (isAdmin
      ? db.collection('courses').where('status', 'in', ['published', 'admin']).get()
      : db.collection('courses').where('status', '==', 'published').get());

    STATE.courses = courseSnap.docs
      .map(d => ({ ...d.data(), id: d.id }))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    page.innerHTML = `<div class="container home-container">
      <div class="page-header">
        <div>
          <h1 class="page-title">הקורסים שלי</h1>
          <p class="page-sub">הקורסים שבחרת להוסיף לאזור האישי שלך</p>
        </div>
        <button class="btn btn-primary" onclick="openCoursePicker()" style="gap:.4rem;display:flex;align-items:center">
          <span style="font-size:1.1rem;line-height:1">+</span> הוסף קורס
        </button>
      </div>
      <div class="courses-grid" id="courses-grid"></div>
      <div class="home-extras-row" id="home-extras-row"></div>
    </div>`;

    _renderCourseCards();
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

function _isSaved(courseId) {
  return (STATE.userData?.savedCourses || []).includes(courseId);
}

async function _persistSavedCourses(savedCourses) {
  STATE.userData = { ...STATE.userData, savedCourses };
  const uid = STATE.fireUser?.uid;
  if (!uid) return;
  try {
    await db.collection('users').doc(uid).set({ savedCourses }, { merge: true });
  } catch (e) {
    console.warn('_persistSavedCourses:', e.message);
  }
}

async function removeSavedCourse(courseId, event) {
  event.stopPropagation();
  if (!confirm('האם אתה בטוח שברצונך להסיר קורס זה?')) return;
  const saved = [...(STATE.userData?.savedCourses || [])];
  const idx = saved.indexOf(courseId);
  if (idx !== -1) saved.splice(idx, 1);
  await _persistSavedCourses(saved);
  _ga('manage_course', { course_code: (STATE.courses || []).find(c => c.id === courseId)?.code || courseId, action: 'remove' });
  _renderCourseCards();
}

function _renderCourseCards() {
  const grid = document.getElementById('courses-grid');
  if (!grid) return;
  const saved = STATE.userData?.savedCourses || [];
  const courses = STATE.courses || [];
  const visible = courses.filter(c => saved.includes(c.id));

  const role = STATE.userData?.role;
  const showAnalytics = role === 'instructor' || role === 'admin';
  const analyticsEnabled = role === 'admin' || saved.length > 0;
  const analyticsCard = showAnalytics ? `
    <div class="course-card analytics-card${analyticsEnabled ? '' : ' disabled'}"
      ${analyticsEnabled ? 'onclick="goLecturerAnalytics()"' : ''}
      title="${analyticsEnabled ? 'פתח לוח ניתוח קורסים' : 'הוסף קורס כדי לפתוח ניתוח'}">
      <span class="ci">📊</span>
      <div class="cn">ניתוח קורסים</div>
      <div class="cc">${role === 'admin' ? 'כל הקורסים' : 'הקורסים שלי'}</div>
      <div class="cm">${analyticsEnabled ? 'לחץ לפתיחת הדשבורד' : 'אין קורסים שמורים'}</div>
    </div>` : '';

  // Lecturer-only "My Exams" card
  const myExamsCard = (role === 'instructor' || role === 'admin') ? `
    <div class="course-card analytics-card" onclick="goLecturerExams()"
      title="המבחנים ששויכו אליך">
      <span class="ci">📝</span>
      <div class="cn">המבחנים שלי</div>
      <div class="cc">${role === 'admin' ? 'כל המבחנים' : 'מבחנים ששויכו'}</div>
      <div class="cm">לחץ לצפייה</div>
    </div>` : '';

  const contactCard = `
    <div class="course-card" onclick="openContactModal()">
      <span class="ci">✉️</span>
      <div class="cn">צור איתנו קשר</div>
      <div class="cc">שתף חוויה · בקש קורס</div>
      <div class="cm">לחץ לפנייה</div>
    </div>`;

  // Bottom row: My Exams (rightmost in RTL) + analytics + contact
  const extras = document.getElementById('home-extras-row');
  if (extras) extras.innerHTML = myExamsCard + analyticsCard + contactCard;

  if (!visible.length) {
    grid.innerHTML = `
      <div class="empty" style="grid-column:1/-1;padding:2.5rem;text-align:center">
        <span class="ei">📚</span>
        <h3>אין קורסים באזור האישי שלך</h3>
        <p>לחץ על <strong>+ הוסף קורס</strong> כדי לבחור קורסים מהמאגר</p>
        <button class="btn btn-primary" style="margin-top:1rem" onclick="openCoursePicker()">+ הוסף קורס</button>
      </div>`;
    return;
  }

  grid.innerHTML = visible.map(c => `
    <div class="course-card" onclick="goCourse('${c.id}')">
      <button class="save-course-btn saved"
        onclick="removeSavedCourse('${c.id}', event)"
        title="הסר מהאזור האישי">✕</button>
      <span class="ci">${esc(c.icon || '📚')}</span>
      <div class="cn">${esc(c.name)}</div>
      <div class="cc">${esc(c.code)}</div>
      <div class="cm">לחץ לצפייה במבחנים</div>
    </div>`).join('');
}

function goLecturerAnalytics() {
  const role = STATE.userData?.role;
  if (role !== 'instructor' && role !== 'admin') return;
  try { sessionStorage.setItem('vaultau:research-scope', role === 'instructor' ? 'mine' : 'all'); } catch (_) {}
  location.href = 'research.html?from=courses';
}

/* ── LECTURER: MY EXAMS ───────────────────────────────────── */

function goLecturerExams() {
  const role = STATE.userData?.role;
  if (role !== 'instructor' && role !== 'admin') return;
  STATE.page = 'my-exams';
  STATE.lecturerExamsCourseFilter = '';
  history.pushState({ page: 'my-exams' }, '');
  renderLecturerExams();
}

async function _fetchLecturerAssignedExams() {
  const role = STATE.userData?.role;
  const uid = STATE.fireUser?.uid;
  if (!uid) return [];
  // Admin → all exams. Instructor → only those where assignedLecturers contains uid.
  let snap;
  try {
    if (role === 'admin') {
      snap = await db.collection('exams').get();
    } else {
      snap = await db.collection('exams')
        .where('assignedLecturers', 'array-contains', uid)
        .get();
    }
  } catch (e) {
    console.error('fetch lecturer exams failed:', e);
    return [];
  }
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function renderLecturerExams() {
  const role = STATE.userData?.role;
  if (role !== 'instructor' && role !== 'admin') {
    STATE.page = 'home';
    renderHome();
    return;
  }
  const page = document.getElementById('app');
  page.innerHTML = `
    <div class="container">
      <div class="breadcrumb">
        <a onclick="goHome()">🏠 ראשי</a><span>›</span><span>המבחנים שלי</span>
      </div>
      <div class="page-header">
        <div>
          <h1 class="page-title">📝 המבחנים שלי</h1>
          <p class="page-sub">המבחנים ש${role === 'admin' ? 'במערכת' : 'שויכו אליך'}</p>
        </div>
      </div>
      <div id="my-exams-content"><div class="spinner" style="margin:2rem auto"></div></div>
    </div>`;

  const [exams, courses] = await Promise.all([
    _fetchLecturerAssignedExams(),
    (STATE.courses && STATE.courses.length) ? Promise.resolve(STATE.courses) : fetchCourses().then(c => { STATE.courses = c; return c; })
  ]);

  const courseById = Object.fromEntries((courses || []).map(c => [c.id, c]));
  // Only show courses that actually appear in this lecturer's exams
  const courseOpts = [...new Set(exams.map(e => e.courseId).filter(Boolean))]
    .map(cid => ({ id: cid, name: courseById[cid]?.name || cid, code: courseById[cid]?.code || '' }))
    .sort((a, b) => a.name.localeCompare(b.name, 'he'));

  const wrap = document.getElementById('my-exams-content');
  if (!wrap) return;

  if (!exams.length) {
    wrap.innerHTML = `
      <div class="empty" style="padding:2.5rem;text-align:center">
        <span class="ei">📭</span>
        <h3>אין מבחנים ששויכו אליך</h3>
        <p style="color:var(--muted);font-size:.9rem">פנה למנהל כדי לשייך אליך מבחנים</p>
      </div>`;
    return;
  }

  wrap.innerHTML = `
    <div class="filters-bar" style="margin-bottom:1rem">
      <div class="form-group" style="min-width:240px">
        <label>קורס</label>
        <select id="my-exams-course-filter" onchange="_applyLecturerExamsFilter()">
          <option value="">כל הקורסים</option>
          ${courseOpts.map(c => `<option value="${esc(c.id)}">${esc(c.name)}${c.code ? ' (' + esc(c.code) + ')' : ''}</option>`).join('')}
        </select>
      </div>
    </div>
    <div id="my-exams-list" style="display:flex;flex-direction:column;gap:.7rem">
      ${exams.map(e => _lecturerExamRowHtml(e, courseById[e.courseId])).join('')}
    </div>`;

  // Cache for filter
  STATE._lecturerExamsCache = exams;
  STATE._lecturerExamsCourseById = courseById;
}

function _lecturerExamRowHtml(exam, course) {
  const hidden = exam.hiddenFromStudents === true;
  const courseLabel = course ? `${course.name}${course.code ? ' (' + course.code + ')' : ''}` : (exam.courseId || '');
  const meta = [exam.year, exam.semester, exam.moed].filter(Boolean).join(' · ');
  const isAdmin = STATE.userData?.role === 'admin';
  return `
    <div class="ac" data-course="${esc(exam.courseId || '')}"
      style="padding:.9rem 1.1rem;display:flex;align-items:center;gap:.8rem;flex-wrap:wrap;
             ${hidden ? 'opacity:.7;background:#fef9c3' : ''}">
      <div style="flex:1;min-width:200px">
        <div style="font-weight:700;font-size:.98rem;display:flex;align-items:center;gap:.5rem;flex-wrap:wrap">
          ${esc(exam.title || exam.id)}
          ${hidden ? '<span class="badge" style="background:#fde68a;color:#92400e;border:1px solid #fbbf24">מוסתר</span>' : ''}
        </div>
        <div style="font-size:.8rem;color:var(--muted);margin-top:.2rem">${esc(courseLabel)}${meta ? ' · ' + esc(meta) : ''}</div>
      </div>
      <div style="display:flex;gap:.4rem;flex-wrap:wrap">
        <button class="btn btn-sm btn-secondary" onclick="goExam('${esc(exam.courseId)}','${esc(exam.id)}')" title="פתח מבחן">📖 פתח</button>
        <button class="btn btn-sm" onclick="toggleExamHidden('${esc(exam.id)}')"
          title="${hidden ? 'הצג לסטודנטים' : 'הסתר מסטודנטים'}"
          style="background:${hidden ? '#dcfce7' : '#fef3c7'};color:${hidden ? '#166534' : '#92400e'};border:1px solid ${hidden ? '#86efac' : '#fcd34d'}">
          ${hidden ? '👁️ הצג' : '🙈 הסתר'}
        </button>
        ${isAdmin ? '' : `<button class="btn btn-sm" onclick="requestExamDeletion('${esc(exam.id)}','${esc((exam.title || '').replace(/'/g, "\\'"))}','${esc(exam.courseId || '')}')"
          title="שלח בקשת מחיקה למנהל"
          style="background:#fee2e2;color:#b91c1c;border:1px solid #fca5a5">🗑️ בקש מחיקה</button>`}
      </div>
    </div>`;
}

function _applyLecturerExamsFilter() {
  const cid = document.getElementById('my-exams-course-filter')?.value || '';
  document.querySelectorAll('#my-exams-list > .ac').forEach(row => {
    row.style.display = (!cid || row.dataset.course === cid) ? '' : 'none';
  });
}

async function toggleExamHidden(examId) {
  const exam = (STATE._lecturerExamsCache || []).find(e => e.id === examId);
  if (!exam) return;
  const willHide = !(exam.hiddenFromStudents === true);
  const msg = willHide
    ? `להסתיר את המבחן "${exam.title}" מהסטודנטים?\n\nהסטודנטים לא יראו את המבחן בקורס.`
    : `להציג שוב את המבחן "${exam.title}" לסטודנטים?`;
  if (!confirm(msg)) return;
  try {
    await db.collection('exams').doc(examId).update({ hiddenFromStudents: willHide });
    exam.hiddenFromStudents = willHide;
    renderLecturerExams();
    toast(willHide ? 'המבחן הוסתר מהסטודנטים' : 'המבחן נראה שוב לסטודנטים', 'info');
  } catch (e) {
    console.error('toggleExamHidden:', e);
    alert('שגיאה: ' + (e.message || e));
  }
}

async function requestExamDeletion(examId, examTitle, courseId) {
  const reason = prompt(
    `שלח בקשה למנהל למחוק את המבחן "${examTitle}".\n\nסיבה (לא חובה):`,
    ''
  );
  if (reason === null) return; // cancelled
  try {
    await db.collection('reports').add({
      category:  'lecturer_delete_request',
      examId:    examId,
      examTitle: examTitle || '',
      courseId:  courseId || '',
      message:   (reason || '').trim() || '(ללא סיבה)',
      userId:    STATE.fireUser?.uid   || '',
      userEmail: STATE.fireUser?.email || '',
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      status:    'open',
      adminResponseText: '',
      adminResponseAt: null,
      userLastReadAt: null,
      adminDeletedAt: null,
      userDeletedAt: null,
      bothDeletedAt: null,
    });
    toast('בקשת המחיקה נשלחה למנהל', 'info');
  } catch (e) {
    console.error('requestExamDeletion:', e);
    alert('שגיאה בשליחת הבקשה: ' + (e.message || e));
  }
}

/* ── COURSE PICKER MODAL ──────────────────────────────────── */

function openCoursePicker() {
  document.getElementById('course-picker-modal')?.remove();
  const courses = STATE.courses || [];
  const overlay = document.createElement('div');
  overlay.id = 'course-picker-modal';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-card" style="width:min(94vw,520px);max-height:80vh;display:flex;flex-direction:column">
      <div class="modal-header">
        <span style="font-weight:700;font-size:1rem">בחר קורסים להוסיף</span>
        <button class="modal-close" onclick="closeCoursePicker()">✕</button>
      </div>
      <div style="padding:.75rem 1.25rem;border-bottom:1px solid var(--border)">
        <input id="picker-search" type="text" placeholder="חיפוש קורס..."
          style="width:100%;border:1.5px solid var(--border);border-radius:8px;padding:.5rem .75rem;
                 font-family:inherit;font-size:.9rem;box-sizing:border-box"
          oninput="_filterPicker(this.value)">
      </div>
      <div id="picker-list" style="overflow-y:auto;flex:1;padding:.75rem 1.25rem;display:flex;flex-direction:column;gap:.5rem">
        ${_buildPickerItems(courses)}
      </div>
      <div style="padding:.85rem 1.25rem;border-top:1px solid var(--border);text-align:left">
        <button class="btn btn-primary" onclick="closeCoursePicker()">סיום</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeCoursePicker(); });
  document.getElementById('picker-search')?.focus();
}

function _buildPickerItems(courses) {
  if (!courses.length) return `<div style="text-align:center;color:var(--muted);padding:1.5rem">אין קורסים זמינים</div>`;
  return courses.map(c => {
    const added = _isSaved(c.id);
    return `
      <div class="picker-item${added ? ' added' : ''}" id="picker-item-${c.id}"
        onclick="togglePickerCourse('${c.id}')">
        <span style="font-size:1.4rem">${esc(c.icon || '📚')}</span>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:.9rem">${esc(c.name)}</div>
          <div style="font-size:.78rem;color:var(--muted)">${esc(c.code)}</div>
        </div>
        <span class="picker-check">${added ? '✓' : '+'}</span>
      </div>`;
  }).join('');
}

function _filterPicker(query) {
  const q = query.trim().toLowerCase();
  const courses = STATE.courses || [];
  const filtered = q ? courses.filter(c =>
    (c.name || '').toLowerCase().includes(q) || (c.code || '').toLowerCase().includes(q)
  ) : courses;
  const list = document.getElementById('picker-list');
  if (list) list.innerHTML = _buildPickerItems(filtered);
}

async function togglePickerCourse(courseId) {
  const saved = [...(STATE.userData?.savedCourses || [])];
  const idx = saved.indexOf(courseId);
  if (idx !== -1) {
    saved.splice(idx, 1);
  } else {
    saved.push(courseId);
  }
  await _persistSavedCourses(saved);
  _ga('manage_course', { course_code: (STATE.courses || []).find(c => c.id === courseId)?.code || courseId, action: idx !== -1 ? 'remove' : 'add' });

  // Update picker item UI without re-rendering the whole list
  const item = document.getElementById(`picker-item-${courseId}`);
  if (item) {
    const added = _isSaved(courseId);
    item.classList.toggle('added', added);
    const check = item.querySelector('.picker-check');
    if (check) check.textContent = added ? '✓' : '+';
  }
  // Refresh the main grid in background
  _renderCourseCards();
}

function closeCoursePicker() {
  document.getElementById('course-picker-modal')?.remove();
}

/* ── CONTACT MODAL ────────────────────────────────────────── */

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
      adminResponseText: '',
      adminResponseAt: null,
      userLastReadAt: null,
      adminDeletedAt: null,
      userDeletedAt: null,
      bothDeletedAt: null,
    });
    closeContactModal();
    _ga('submit_feedback', { feedback_type: type });
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
   COURSE PAGE
══════════════════════════════════════════════════════════ */

async function renderCourse() {
  const page = document.getElementById('page');
  page.innerHTML = `<div class="container"><div class="spinner" style="margin-top:3rem"></div></div>`;
  STATE.examLabel = ''; // clear exam context when navigating to course page
  STATE.examQuestions = [];

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
    const _isFirstCourseRender = STATE.courseCode !== (course.code || '');
    STATE.courseCode = course.code || '';
    if (_isFirstCourseRender) {
      _logEvent('course_open', { courseCode: course.code || '' });
      _ga('view_course', { course_code: _cc() });
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

    // If user landed on the now-removed AI tab, fall back to exams
    if (STATE.tab === 'ai-questions') STATE.tab = 'exams';

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
          <button class="tab-btn ${STATE.tab === 'videos' ? 'active' : ''}" onclick="setTab('videos')">
            🎬 סרטונים
          </button>
        </div>
        <div id="tab-content"></div>
      </div>`;

    if (STATE.tab === 'starred') renderStarredTab(exams, starred);
    else if (STATE.tab === 'videos') renderVideosTab(exams);
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

function setTab(t) { STATE.tab = t; _ga('switch_tab', { course_code: _cc(), tab_name: t }); renderCourse(); }

function renderExamsTab(course, exams, years, sems, moeds, lecturers) {
  const tc = document.getElementById('tab-content');
  const opts = arr => arr.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');

  tc.innerHTML = `
    <div class="filters-bar">
      <div class="form-group">
        <label>שנה</label>
        <select id="f-y" onchange="applyFilters(true)"><option value="">הכל</option>${opts(years)}</select>
      </div>
      <div class="form-group">
        <label>סמסטר</label>
        <select id="f-s" onchange="applyFilters(true)"><option value="">הכל</option>${opts(sems)}</select>
      </div>
      <div class="form-group">
        <label>מועד</label>
        <select id="f-m" onchange="applyFilters(true)"><option value="">הכל</option>${opts(moeds)}</select>
      </div>
      ${lecturers.length ? `<div class="form-group">
        <label>מרצה</label>
        <select id="f-l" onchange="applyFilters(true)"><option value="">הכל</option>${opts(lecturers)}</select>
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

function applyFilters(fromUser = false) {
  const exams = STATE.exams[STATE.courseId] || [];
  const fyEl = document.getElementById('f-y');
  const fsEl = document.getElementById('f-s');
  const fmEl = document.getElementById('f-m');
  const flEl = document.getElementById('f-l');

  // If the filter UI isn't mounted (e.g. called from the exam page after
  // toggling done/in-progress), fall back to the saved values so we don't
  // wipe them with empty DOM reads.
  const saved = STATE.savedFilters[STATE.courseId] || {};
  const uiMounted = !!(fyEl || fsEl || fmEl || flEl);
  const fy = uiMounted ? (fyEl?.value || '') : (saved.fy || '');
  const fs = uiMounted ? (fsEl?.value || '') : (saved.fs || '');
  const fm = uiMounted ? (fmEl?.value || '') : (saved.fm || '');
  const fl = uiMounted ? (flEl?.value || '') : (saved.fl || '');

  // Persist current filter values so they survive exam navigation.
  // Only write when the UI is mounted — otherwise we'd just rewrite
  // the same saved values (or worse, blank them out).
  if (STATE.courseId && uiMounted) {
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

  // Analytics — exam_filtered (debounced 20s, only on real user interaction)
  if (fromUser) {
    clearTimeout(_filterDebounceTimer);
    _filterDebounceTimer = setTimeout(() => {
      _logEvent('exam_filtered', {
        courseCode:  STATE.courseCode || STATE.courseId || '',
        filters: {
          year:      fy || null,
          semester:  fs || null,
          moed:      fm || null,
          lecturer:  fl || null,
        },
        resultCount: filtered.length,
      });
      _ga('filter_exams', {
        course_code:     _cc(),
        filter_year:     fy || '',
        filter_semester: fs || '',
        filter_moed:     fm || '',
        filter_lecturer: fl || '',
        results_count:   filtered.length,
      });
    }, 20_000);
  }

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
      ${e.solutionPdfUrl ? `<a class="sol-download-btn" href="${safeUrl(e.solutionPdfUrl)}" target="_blank" rel="noopener"
        data-exam-id="${e.id}" data-exam-year="${e.year||''}" data-exam-sem="${e.semester||''}" data-exam-moed="${e.moed||''}" onclick="event.stopPropagation()" title="הורד פתרון">SOL</a>` : ''}
      ${e.pdfUrl ? `<a class="pdf-download-btn" href="${safeUrl(e.pdfUrl)}" target="_blank" rel="noopener"
        data-exam-id="${e.id}" data-exam-year="${e.year||''}" data-exam-sem="${e.semester||''}" data-exam-moed="${e.moed||''}" onclick="event.stopPropagation()" title="הורד טופס מבחן">
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
      <span class="exam-arrow">←</span>
    </div>`;
  }).join('');

  // Analytics — pdf_download event delegation
  el.querySelectorAll('[data-exam-id]').forEach(a => {
    a.addEventListener('click', function () {
      const _he = s => ({ 'א':'A','ב':'B','ג':'C','ד':'D' }[s] || (s||'').toString().toUpperCase());
      const cc   = STATE.courseCode || STATE.courseId || '';
      const year = this.dataset.examYear  || '';
      const sem  = _he(this.dataset.examSem  || '');
      const moed = _he(this.dataset.examMoed || '');
      const examLabel = [cc, year, sem, moed].filter(Boolean).join('_');
      _logEvent('pdf_download', {
        examId:     examLabel || this.dataset.examId,
        courseCode: STATE.courseCode || STATE.courseId || '',
        type:       this.classList.contains('sol-download-btn') ? 'solution' : 'exam',
      });
      _ga('download_file', {
        course_code: STATE.courseCode || STATE.courseId || '',
        exam_id:     examLabel || this.dataset.examId,
        file_type:   this.classList.contains('sol-download-btn') ? 'solution' : 'exam',
      });
    });
  });
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
    _logEvent('exam_status_changed', { examId: _examRef(examId), status: adding ? 'done' : 'undone', courseCode: STATE.courseCode || STATE.courseId });
    _ga('mark_status', { course_code: _cc(), exam_id: _examRef(examId) || _eid(), status_type: 'done', action: adding ? 'add' : 'remove' });
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
    _logEvent('exam_status_changed', { examId: _examRef(examId), status: adding ? 'in_progress' : 'removed', courseCode: STATE.courseCode || STATE.courseId });
    _ga('mark_status', { course_code: _cc(), exam_id: _examRef(examId) || _eid(), status_type: 'in_progress', action: adding ? 'add' : 'remove' });
  } catch (e) {
    console.error('Failed to save inProgressExams:', e);
    toast('שגיאה בשמירת הסימון', 'error');
  }
}

/* ── Exam-page wrappers: same toggles + refresh banner buttons ── */
function _refreshExamBannerStatus(examId) {
  const ipBtn   = document.getElementById('ev-inprogress-btn');
  const doneBtn = document.getElementById('ev-done-btn');
  if (!ipBtn || !doneBtn) return;

  const isIP   = STATE.inProgressExams.includes(examId);
  const isDone = STATE.doneExams.includes(examId);

  ipBtn.classList.toggle('inprogress-active', isIP);
  ipBtn.title = isIP ? 'בטל בתהליך' : 'סמן כבתהליך';
  ipBtn.textContent = isIP ? '⏳' : '◑';

  doneBtn.classList.toggle('done-active', isDone);
  doneBtn.title = isDone ? 'בטל סימון בוצע' : 'סמן כבוצע';
  doneBtn.textContent = isDone ? '✓' : '○';
}

async function toggleInProgressFromExam(examId) {
  await toggleInProgress(examId);
  _refreshExamBannerStatus(examId);
}

async function toggleDoneFromExam(examId) {
  await toggleDone(examId);
  _refreshExamBannerStatus(examId);
}
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
    const qImage = safeUrl(q.imageUrl || '');
    const qAlign = normalizeImageAlign(q.imageAlign || 'center');
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
      const sImage   = safeUrl(s.imageUrl || '');
      const sAlign   = normalizeImageAlign(s.imageAlign || 'center');
      COPY_MAP.set(sCopyId, s.text || '');
      return `<div class="qv-part" id="sc-si-${s.id}">
        <div class="qv-part-head">
          <span class="qv-part-lbl">${rawLabel}</span>
          <div class="qv-actions">
            <button class="qv-btn" onclick="copyById('${sCopyId}',event)" title="העתק LaTeX">${copySVG}</button>
          </div>
        </div>
        <div class="qv-part-text"></div>
        ${sImage ? `<div class="qv-image-wrap qv-image-wrap-sub align-${sAlign}"><img class="qv-image" src="${sImage}" alt="תמונה לסעיף" loading="lazy" referrerpolicy="no-referrer"></div>` : ''}
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
      ${qImage ? `<div class="qv-image-wrap align-${qAlign}"><img class="qv-image" src="${qImage}" alt="תמונה לשאלה ${qi + 1}" loading="lazy" referrerpolicy="no-referrer"></div>` : ''}
      ${partsHtml}
    </div>`;
  }).join('');

  // Set text content safely
  items.forEach(it => {
    const { q } = it;
    const subs  = q.subs || q.parts || [];
    const qEl   = tc.querySelector(`#sc-${q.id} .qv-text`);
    if (qEl) qEl.innerHTML = formatMathText(q.text || '', q.inlineImages || null);
    subs.forEach(s => {
      const sEl = tc.querySelector(`#sc-si-${s.id} .qv-part-text`);
      if (sEl) sEl.innerHTML = formatMathText(s.text || '', s.inlineImages || null);
    });
  });

  if (window.MathJax) MathJax.typesetPromise([tc]);
}

/* ══════════════════════════════════════════════════════════
   VIDEOS TAB — list all questions/sub-parts that have videos
══════════════════════════════════════════════════════════ */

async function renderVideosTab(exams) {
  const tc = document.getElementById('tab-content');
  if (!tc) return;
  tc.innerHTML = '<div class="container"><div class="spinner" style="margin:2rem auto"></div></div>';

  // Collect every question id + sub id, plus a parent map from sub-id -> question.
  const allIds = [];
  const qIndex = {}; // questionId -> { exam, q, qi, examLabel }
  const subToQid = {}; // subId -> questionId
  exams.forEach(exam => {
    const examLabel = [exam.year, _heToLat(exam.semester), _heToLat(exam.moed)].filter(Boolean).join('');
    (exam.questions || []).forEach((q, qi) => {
      qIndex[q.id] = { exam, q, qi, examLabel };
      allIds.push(q.id);
      (q.subs || q.parts || []).forEach(s => {
        subToQid[s.id] = q.id;
        allIds.push(s.id);
      });
    });
  });

  if (!allIds.length) {
    tc.innerHTML = '<div class="empty"><span class="ei">🎬</span><h3>אין שאלות בקורס</h3></div>';
    return;
  }

  // Fetch question_videos in chunks of 30 (Firestore "in" limit)
  const videoMap = {}; // entityId -> { libraryId, videoId, title }
  try {
    const chunks = [];
    for (let i = 0; i < allIds.length; i += 30) chunks.push(allIds.slice(i, i + 30));
    await Promise.all(chunks.map(async chunk => {
      try {
        const snap = await db.collection('question_videos')
          .where(firebase.firestore.FieldPath.documentId(), 'in', chunk).get();
        snap.forEach(doc => {
          const data = doc.data() || {};
          if (!data.libraryId || !data.videoId) return;
          videoMap[doc.id] = data;
        });
      } catch (e) { console.warn('renderVideosTab chunk error:', e); }
    }));
  } catch (e) {
    tc.innerHTML = `<div class="empty"><span class="ei">⚠️</span><h3>שגיאת טעינה</h3><p>${esc(e.message)}</p></div>`;
    return;
  }

  // Group videos by parent question id
  const qIdsWithVideo = new Set();
  Object.keys(videoMap).forEach(id => {
    if (qIndex[id]) qIdsWithVideo.add(id);
    else if (subToQid[id]) qIdsWithVideo.add(subToQid[id]);
  });

  if (!qIdsWithVideo.size) {
    tc.innerHTML = '<div class="empty"><span class="ei">🎬</span><h3>אין סרטונים בקורס זה עדיין</h3><p>סרטוני פתרון יוצגו כאן כשיתווספו</p></div>';
    return;
  }

  // Sort entries: year DESC, then semester+moed ASC (AA before AB), then question number ASC
  const entries = [...qIdsWithVideo].map(qid => qIndex[qid]).filter(Boolean);
  entries.sort((a, b) => {
    const ya = Number(a.exam.year) || 0;
    const yb = Number(b.exam.year) || 0;
    if (ya !== yb) return yb - ya;
    const sa = (_heToLat(a.exam.semester) || '') + (_heToLat(a.exam.moed) || '');
    const sb = (_heToLat(b.exam.semester) || '') + (_heToLat(b.exam.moed) || '');
    if (sa !== sb) return sa.localeCompare(sb);
    return a.qi - b.qi;
  });

  const starred   = STATE.userData?.starredQuestions || [];
  const userVotes = STATE.userData?.difficultyVotes  || {};
  const isAdmin   = STATE.userData?.role === 'admin';

  const html = entries.map((entry, idx) => {
    const { q, qi, examLabel } = entry;
    const title = `${examLabel} שאלה ${qi + 1}`;
    return `<details class="vt-item" data-qid="${esc(q.id)}" data-idx="${idx}">
      <summary class="vt-summary">
        <span class="vt-title">${esc(title)}</span>
        <span class="vt-chev">▾</span>
      </summary>
      <div class="vt-body"></div>
    </details>`;
  }).join('');

  tc.innerHTML = `
    <div class="vt-toolbar">
      <button class="btn vt-toggle-all" id="vt-toggle-all" data-state="collapsed">פתח הכל</button>
    </div>
    <div class="vt-list">${html}</div>`;

  const toggleAllBtn = document.getElementById('vt-toggle-all');
  if (toggleAllBtn) {
    toggleAllBtn.addEventListener('click', () => {
      const expand = toggleAllBtn.dataset.state !== 'expanded';
      tc.querySelectorAll('details.vt-item').forEach(d => { d.open = expand; });
      toggleAllBtn.dataset.state = expand ? 'expanded' : 'collapsed';
      toggleAllBtn.textContent = expand ? 'סגור הכל' : 'פתח הכל';
    });
  }

  // Lazy-render the question card on first open
  tc.querySelectorAll('details.vt-item').forEach(d => {
    d.addEventListener('toggle', () => {
      if (!d.open) return;
      const body = d.querySelector('.vt-body');
      if (!body || body.dataset.loaded === '1') return;
      const idx = Number(d.dataset.idx);
      const entry = entries[idx];
      if (!entry) return;
      const { q, qi } = entry;
      body.innerHTML = renderQuestionCard(q, qi, starred, userVotes, videoMap, isAdmin);

      // Set HTML content for question/subs (same pattern as renderExam)
      const subs = q.subs || q.parts || [];
      const textEl = body.querySelector(`#qc-${q.id} .qv-text`);
      if (textEl) textEl.innerHTML = formatMathText(q.text || '', q.inlineImages || null);
      subs.forEach(s => {
        const subEl = body.querySelector(`#si-${s.id} .qv-part-text`);
        if (subEl) subEl.innerHTML = formatMathText(s.text || '', s.inlineImages || null);
      });
      if (window.MathJax) MathJax.typesetPromise([body]);

      body.dataset.loaded = '1';
    });
  });
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
    STATE.courseCode = course.code || '';

    const exam = await fetchExam(STATE.examId);
    if (!exam) return goCourse(STATE.courseId);
    STATE.examLabel = [STATE.courseCode, exam.year, _heToLat(exam.semester), _heToLat(exam.moed)].filter(Boolean).join('_');

    _ga('view_exam', { course_code: _cc(), exam_id: _eid() });
    _logEvent('exam_open', { examId: STATE.examLabel || STATE.examId, courseCode: STATE.courseCode || STATE.courseId });

    // Fetch userData only if not cached; fetch votes and video map in parallel
    const [_, votes, videoMap] = await Promise.all([
      STATE.userData ? Promise.resolve() : fetchUserData(STATE.fireUser.uid, STATE.fireUser.email).then(d => { STATE.userData = d; }),
      fetchExamVotes(exam.questions || []),
      fetchExamVideoMap(exam.questions || []),
    ]);
    STATE.examVotes = votes;
    const starred   = STATE.userData?.starredQuestions || [];
    const questions = exam.questions || [];
    STATE.examQuestions = questions;
    const userVotes   = STATE.userData?.difficultyVotes || {};
    const isAdminNow  = STATE.userData?.role === 'admin';

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
          <button class="report-exam-btn" style="border-radius:8px;width:auto;padding:.35rem .75rem;font-size:.8rem;gap:.3rem;display:inline-flex;align-items:center"
            onclick="openReportBugModal('${exam.id}','${esc(examTitle)}','${course.id}')"
            title="דווח על תקלה">
            ⚠ דווח על תקלה
          </button>
        </div>

        <div class="ev-banner">
          <div class="ev-banner-status" id="ev-banner-status">
            <button class="inprogress-toggle-btn ${STATE.inProgressExams.includes(exam.id) ? 'inprogress-active' : ''}"
              id="ev-inprogress-btn"
              onclick="toggleInProgressFromExam('${exam.id}')"
              title="${STATE.inProgressExams.includes(exam.id) ? 'בטל בתהליך' : 'סמן כבתהליך'}">
              ${STATE.inProgressExams.includes(exam.id) ? '⏳' : '◑'}
            </button>
            <button class="done-toggle-btn ${STATE.doneExams.includes(exam.id) ? 'done-active' : ''}"
              id="ev-done-btn"
              onclick="toggleDoneFromExam('${exam.id}')"
              title="${STATE.doneExams.includes(exam.id) ? 'בטל סימון בוצע' : 'סמן כבוצע'}">
              ${STATE.doneExams.includes(exam.id) ? '✓' : '○'}
            </button>
          </div>
          <div class="ev-banner-text">
            <h1 class="ev-banner-title">${esc(examTitle)}</h1>
            ${metaLine ? `<p class="ev-banner-meta">${esc(metaLine)}</p>` : ''}
          </div>
        </div>

        <div class="ev-body" id="ev-questions-body">
          ${!questions.length
            ? `<div class="empty"><span class="ei">📝</span><h3>אין שאלות עדיין</h3></div>`
            : questions.map((q, qi) => renderQuestionCard(q, qi, starred, userVotes, videoMap, isAdminNow)).join('')}
        </div>
      </div>`;

    // Set text via innerHTML after DOM is built (safe for LaTeX/HTML)
    questions.forEach(q => {
      const subs   = q.subs || q.parts || [];
      const textEl = page.querySelector(`#qc-${q.id} .qv-text`);
      if (textEl) textEl.innerHTML = formatMathText(q.text || '', q.inlineImages || null);
      subs.forEach(s => {
        const subEl = page.querySelector(`#si-${s.id} .qv-part-text`);
        if (subEl) subEl.innerHTML = formatMathText(s.text || '', s.inlineImages || null);
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

function renderQuestionCard(q, qi, starred, userVotes = {}, videoMap = {}, isAdmin = false) {
  const isStarredQ = starred.includes(q.id);
  const isBonus    = q.isBonus === true;
  const subs       = q.subs || q.parts || [];
  const hasSubs    = subs.length > 0;
  const qText      = q.text || '';
  const qImage     = safeUrl(q.imageUrl || '');
  const qAlign     = normalizeImageAlign(q.imageAlign || 'center');
  const qCopyId    = 'copy-q-' + q.id;
  const _role      = STATE.userData?.role;
  const canGenerate = _role === 'instructor' || _role === 'admin';

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
  const videoSVG = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="14" height="14" rx="2.5" ry="2.5"/><polygon points="16 8 22 12 16 16"/></svg>`;

  const points = q.points ? `<span class="qv-pts">(${q.points} נקודות)</span>` : '';
  const bonusBadge = isBonus
    ? `<span class="qv-bonus-badge">⭐ שאלת בונוס לקבוצות B ו-C</span>`
    : '';

  let partsHtml = '';
  if (hasSubs) {
    partsHtml = subs.map((s, si) => {
      const rawLabel   = s.label || (s.letter ? '(' + s.letter + ')' : '(' + String.fromCharCode(0x05D0 + si) + ')');
      const sText      = s.text || '';
      const sImage     = safeUrl(s.imageUrl || '');
      const sAlign     = normalizeImageAlign(s.imageAlign || 'center');
      const sCopyId    = 'copy-s-' + s.id;
      COPY_MAP.set(sCopyId, sText);
      const sAllowAI = s.allowAIGen === true;
      const sIsBonus = s.isBonus === true;
      return `<div class="qv-part${sIsBonus ? ' qv-part-bonus' : ''}" id="si-${s.id}">
        <div class="qv-part-head">
          <span class="qv-part-lbl">${sIsBonus ? '⭐ ' : ''}${rawLabel}</span>
          <div class="qv-actions">
            ${sIsBonus ? `<span class="qv-bonus-badge" style="font-size:.7rem;padding:.15rem .5rem">⭐ סעיף בונוס</span>` : ''}
            <button class="qv-btn" onclick="copyById('${sCopyId}',event)" title="העתק LaTeX">${copySVG}</button>
            ${sAllowAI && canGenerate ? `<button class="qv-btn" onclick="openGeminiModal('${s.id}','sub')" title="צור סעיף דומה">✨</button>` : ''}
            ${videoMap[s.id] ? `<button class="qv-btn qv-video-btn" data-lib="${esc(videoMap[s.id].libraryId)}" data-vid="${esc(videoMap[s.id].videoId)}" data-title="${esc(videoMap[s.id].title || 'פתרון מוצג')}" data-entity-id="${esc(s.id)}" data-entity-label="${esc('שאלה ' + (qi + 1) + ' ' + rawLabel)}" onclick="openVideoModalFromBtn(this)" title="צפה בסרטון פתרון">${videoSVG}</button>` : ''}
          </div>
        </div>
        <div class="qv-part-text"></div>
        ${sImage ? `<div class="qv-image-wrap qv-image-wrap-sub align-${sAlign}"><img class="qv-image" src="${sImage}" alt="תמונה לסעיף" loading="lazy" referrerpolicy="no-referrer"></div>` : ''}
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
        ${q.allowAIGen === true && canGenerate ? `<button class="qv-btn" onclick="openGeminiModal('${q.id}','question')" title="צור שאלה דומה">✨</button>` : ''}
        ${videoMap[q.id] ? `<button class="qv-btn qv-video-btn" data-lib="${esc(videoMap[q.id].libraryId)}" data-vid="${esc(videoMap[q.id].videoId)}" data-title="${esc(videoMap[q.id].title || 'פתרון מוצג')}" data-entity-id="${esc(q.id)}" data-entity-label="${esc('שאלה ' + (qi + 1))}" onclick="openVideoModalFromBtn(this)" title="צפה בסרטון פתרון">${videoSVG}</button>` : ''}
      </div>
    </div>
    <div class="qv-text"></div>
    ${qImage ? `<div class="qv-image-wrap align-${qAlign}"><img class="qv-image" src="${qImage}" alt="תמונה לשאלה ${qi + 1}" loading="lazy" referrerpolicy="no-referrer"></div>` : ''}
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
    _logEvent('star_toggled', { questionId: _questionRef(id), starred: adding, courseCode: STATE.courseCode || STATE.courseId, examId: STATE.examLabel || STATE.examId || '' });
    _ga('mark_status', { course_code: _cc(), exam_id: _eid(), question_id: _questionRef(id), status_type: 'star', action: adding ? 'add' : 'remove' });
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

  _ga('rate_content', { course_code: _cc(), exam_id: _eid(), question_id: _questionRef(qid), rating_category: 'difficulty', rating_value: userVotes[qid] || 'removed' });

  // Debounce difficulty_voted: cancel any pending timer for this question.
  // If the user toggled their vote off, cancel and log nothing.
  // Otherwise, (re)start a 10 s timer that reads the *final* state at fire-time.
  clearTimeout(_difficultyDebounceTimers[qid]);
  if (prev === level) {
    // toggled off — no vote to log
    delete _difficultyDebounceTimers[qid];
  } else {
    _difficultyDebounceTimers[qid] = setTimeout(() => {
      delete _difficultyDebounceTimers[qid];
      const finalLevel = STATE.userData?.difficultyVotes?.[qid];
      if (!finalLevel) return; // vote was removed in a later click
      _logEvent('difficulty_voted', {
        questionId: _questionRef(qid),
        level:      finalLevel,
        courseCode: STATE.courseCode || STATE.courseId,
        examId:     STATE.examLabel || STATE.examId || '',
      });
    }, 10_000);
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

const _heToLat = s => ({'א':'A','ב':'B','ג':'C','ד':'D'}[s] || (s||'').toString().toUpperCase());

function _examRef(examId) {
  const e = (STATE.exams[STATE.courseId] || []).find(x => x.id === examId);
  if (!e) return STATE.examLabel || examId;
  return [STATE.courseCode, e.year, _heToLat(e.semester), _heToLat(e.moed)].filter(Boolean).join('_');
}

function _questionRef(qid) {
  if (!qid) return '';
  // strip DOM copy-map prefix (copy-q- or copy-s-) to get the real question/sub id
  const rawId = qid.replace(/^copy-[qs]-/, '');
  const qs = STATE.examQuestions || [];
  for (let i = 0; i < qs.length; i++) {
    if (qs[i].id === rawId) return 'Q' + (i + 1);
    const subs = qs[i].subs || qs[i].parts || [];
    for (let j = 0; j < subs.length; j++) {
      if (subs[j].id === rawId) return 'Q' + (i + 1) + String.fromCharCode(97 + j);
    }
  }
  return rawId; // fallback
}

function copyById(id, event) {
  const text  = COPY_MAP.get(id) || '';
  const latex = htmlToLatex(text);
  _doCopy(latex, event, id);
}

function _doCopy(text, event, qid = '') {
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
    _ga('copy_content', { course_code: _cc(), exam_id: _eid(), question_id: _questionRef(qid), content_type: 'original_question' });
    _logEvent('question_copied', { questionId: _questionRef(qid), courseCode: STATE.courseCode || STATE.courseId, examId: STATE.examLabel || STATE.examId || '' });
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
   BROADCAST MESSAGES (admin → users)
   - audience='all'    → show to every logged-in user
   - audience='course' → only if courseId is in user's savedCourses
   - dismissedBroadcasts[] persists per user so we don't repeat
══════════════════════════════════════════════════════════ */

async function checkAndShowBroadcasts() {
  try {
    const ud = STATE.userData || {};
    const dismissed = Array.isArray(ud.dismissedBroadcasts) ? ud.dismissedBroadcasts : [];
    const savedCourses = Array.isArray(ud.savedCourses) ? ud.savedCourses : [];

    const snap = await db.collection('broadcasts')
      .orderBy('createdAt', 'desc')
      .limit(30)
      .get();
    if (snap.empty) {
      _userInboxBroadcasts = [];
      _recomputeInboxUnread();
      return;
    }

    const eligible = [];
    snap.forEach(doc => {
      const x = doc.data();
      if (x.active === false) return;
      if (dismissed.includes(doc.id)) return;
      if (x.audience === 'course') {
        if (!x.courseId || !savedCourses.includes(x.courseId)) return;
      }
      eligible.push({ id: doc.id, ...x });
    });

    // Split by priority. Urgent → modal. Regular → inbox.
    const urgent  = eligible.filter(b => b.priority === 'urgent');
    const regular = eligible.filter(b => b.priority !== 'urgent');

    _userInboxBroadcasts = regular;
    _recomputeInboxUnread();

    if (urgent.length) showBroadcastModal(urgent[0]);
  } catch (e) {
    console.warn('checkAndShowBroadcasts error:', e);
  }
}

function showBroadcastModal(bc) {
  document.getElementById('broadcast-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'broadcast-modal';
  modal.className = 'modal-overlay';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.55);' +
    'display:flex;align-items:center;justify-content:center;z-index:9999;padding:1rem';

  const title = (bc.title || '').toString();
  const body  = (bc.body  || '').toString();
  const audienceLabel = bc.audience === 'course'
    ? `הודעה למשתתפי ${bc.courseName || 'הקורס שלך'}`
    : 'הודעה לכלל המשתמשים';

  modal.innerHTML = `
    <div style="background:#fff;border-radius:14px;max-width:520px;width:100%;
                box-shadow:0 20px 50px rgba(0,0,0,.25);overflow:hidden;direction:rtl">
      <div style="background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;
                  padding:1.1rem 1.25rem">
        <div style="font-size:.78rem;opacity:.9;margin-bottom:.25rem">📣 ${esc(audienceLabel)}</div>
        <h2 style="margin:0;font-size:1.2rem;font-weight:800">${esc(title)}</h2>
      </div>
      <div style="padding:1.25rem;font-size:.95rem;color:#1f2937;line-height:1.65;
                  white-space:pre-wrap;max-height:55vh;overflow-y:auto">${esc(body)}</div>
      <div style="padding:.85rem 1.25rem;border-top:1px solid #e5e7eb;
                  display:flex;justify-content:flex-end;gap:.5rem">
        <button class="btn btn-primary" onclick="dismissBroadcast('${bc.id}')">הבנתי</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

async function dismissBroadcast(id) {
  const modal = document.getElementById('broadcast-modal');
  if (modal) modal.remove();
  try {
    const uid = STATE.fireUser?.uid;
    if (!uid) return;
    const ud = STATE.userData || {};
    const dismissed = Array.isArray(ud.dismissedBroadcasts) ? ud.dismissedBroadcasts.slice() : [];
    if (!dismissed.includes(id)) dismissed.push(id);
    // Cap stored list to last 200 ids
    const trimmed = dismissed.slice(-200);
    STATE.userData = { ...ud, dismissedBroadcasts: trimmed };
    await saveUserData(uid, { dismissedBroadcasts: trimmed });
  } catch (e) {
    console.warn('dismissBroadcast error:', e);
  }
}
window.dismissBroadcast = dismissBroadcast;

/* ══════════════════════════════════════════════════════════
   REPORT BUG MODAL (exam page)
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
      category:  'bug',
      examId:    modal.dataset.examId    || '',
      examTitle: modal.dataset.examTitle || '',
      courseId:  modal.dataset.courseId  || '',
      message:   msg,
      userId:    STATE.fireUser?.uid   || '',
      userEmail: STATE.fireUser?.email || '',
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      status:    'open',
      adminResponseText: '',
      adminResponseAt: null,
      userLastReadAt: null,
      adminDeletedAt: null,
      userDeletedAt: null,
      bothDeletedAt: null,
    });
    closeReportBugModal();
    _ga('submit_feedback', { feedback_type: 'bug_report' });
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

/* ── GEMINI AI – Generate Similar Question ─────────────────── */

/* ── Gemini loading UI helpers ──────────────────────────────── */
let _geminiTimerInterval = null;
let _geminiMsgTimeout = null;

const _geminiLoadingMsgs = [
  'קורא ומנתח את השאלה המקורית...',
  'מזהה את עקרונות המפתח והמבנה הלוגי...',
  'מרכיב נתונים חדשים ושומר על רמת הקושי...',
  'מנסח ומעצב את השאלה מחדש...',
  'מוודא איכות ודיוק, עוד רגע מסיימים...'
];

function _startGeminiLoading(container) {
  _stopGeminiLoading();
  container.innerHTML = `<div class="gemini-loading">
    <div class="spinner"></div>
    <div style="text-align:center">
      <span id="gemini-loading-msg">${_geminiLoadingMsgs[0]}</span>
      <div id="gemini-loading-timer" style="font-size:.75rem;color:#9ca3af;margin-top:.35rem;font-variant-numeric:tabular-nums">00:00</div>
    </div>
  </div>`;

  const start = Date.now();
  let msgIdx = 0;

  _geminiTimerInterval = setInterval(() => {
    const el = document.getElementById('gemini-loading-timer');
    if (!el) { _stopGeminiLoading(); return; }
    const sec = Math.floor((Date.now() - start) / 1000);
    el.textContent = String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0');
  }, 1000);

  function scheduleNextMsg() {
    if (msgIdx >= _geminiLoadingMsgs.length - 1) return; // stay on last message — do not loop
    const delay = 8000 + Math.random() * 10000; // 8–18 seconds
    _geminiMsgTimeout = setTimeout(() => {
      msgIdx++;
      const el = document.getElementById('gemini-loading-msg');
      if (!el) { _stopGeminiLoading(); return; }
      el.textContent = _geminiLoadingMsgs[msgIdx];
      scheduleNextMsg();
    }, delay);
  }
  scheduleNextMsg();
}

function _stopGeminiLoading() {
  if (_geminiTimerInterval) { clearInterval(_geminiTimerInterval); _geminiTimerInterval = null; }
  if (_geminiMsgTimeout) { clearTimeout(_geminiMsgTimeout); _geminiMsgTimeout = null; }
}

/**
 * Open the Gemini modal. For 'question' type, pass q.id and we look up text
 * from COPY_MAP. For 'sub' type, pass the sub-part id.
 */
function openGeminiModal(qOrSubId, type) {
  const uid = STATE.fireUser?.uid;
  if (!uid) { toast('יש להתחבר כדי להשתמש בתכונה זו', 'error'); return; }
  const _role = STATE.userData?.role;
  if (_role !== 'instructor' && _role !== 'admin') {
    toast('התכונה זמינה למרצים ומנהלי מערכת בלבד', 'error');
    return;
  }

  // Resolve the source text
  let sourceText = '';
  const copyKey = type === 'question' ? 'copy-q-' + qOrSubId : 'copy-s-' + qOrSubId;
  sourceText = COPY_MAP.get(copyKey) || '';

  // Fallback: extract from DOM if COPY_MAP miss
  if (!sourceText) {
    const domId = type === 'question' ? 'qc-' + qOrSubId : 'si-' + qOrSubId;
    const el = document.getElementById(domId);
    const textEl = el?.querySelector(type === 'question' ? '.qv-text' : '.qv-part-text');
    if (textEl) sourceText = textEl.innerText.trim();
  }
  if (!sourceText) {
    toast('לא נמצא טקסט לשאלה', 'error');
    return;
  }

  // Remove any existing modal & listener
  closeGeminiModal();

  const overlay = document.createElement('div');
  overlay.id = 'gemini-modal-overlay';
  overlay.className = 'gemini-modal-overlay';
  overlay.innerHTML = `
    <div class="gemini-modal">
      <div class="gemini-modal-header">
        <button class="qv-btn" onclick="closeGeminiModal()" title="סגור"
          style="background:none;border:none;font-size:1.2rem;cursor:pointer;color:#6b7280;margin-left:0;margin-right:auto">✕</button>
        <h3 style="flex:1;text-align:center;margin:0">✨ יצירת שאלה דומה</h3>
        <div style="display:flex;align-items:center;gap:.6rem">
          <div id="gemini-rate-wrap" style="display:none;gap:.3rem;align-items:center" title="דרג את איכות השאלה">
            <button class="qv-btn" id="gemini-rate-up" onclick="_rateQuestion('up')" style="font-size:1rem;padding:2px 6px">👍</button>
            <button class="qv-btn" id="gemini-rate-down" onclick="_rateQuestion('down')" style="font-size:1rem;padding:2px 6px">👎</button>
          </div>
          <span id="gemini-quota-badge" style="font-size:.75rem;padding:2px 8px;border-radius:12px;background:rgba(99,102,241,.12);color:#6366f1;white-space:nowrap">${_aiQuotaRemaining !== null && _aiQuotaLimit !== null ? `${_aiQuotaRemaining}/${_aiQuotaLimit}` : ''}</span>
        </div>
      </div>
      <!-- Difficulty selector -->
      <div id="gemini-config-row" style="display:flex;gap:.6rem;padding:1rem 1.25rem;border-bottom:1px solid #f3f4f6;flex-wrap:wrap;align-items:center;justify-content:center">
        <label style="font-size:.9rem;color:var(--muted);font-weight:600">רמת קושי:</label>
        <select id="gemini-difficulty" style="font-size:.9rem;padding:5px 12px;border-radius:8px;border:1px solid #d1d5db">
          <option value="same">כמו המקור</option>
          <option value="easy">קלה</option>
          <option value="medium">בינונית</option>
          <option value="hard">קשה</option>
        </select>
        <button class="btn-gemini" id="gemini-start-btn" onclick="_geminiStartGenerate()" style="margin-right:1rem;padding:6px 24px;font-size:.9rem">✨ צור שאלה</button>
      </div>
      <div class="gemini-modal-body" id="gemini-body">
        <div style="text-align:center;padding:2rem;color:var(--muted);font-size:.95rem">בחר רמת קושי ולחץ על "צור שאלה"</div>
      </div>
      <div class="gemini-modal-footer" id="gemini-footer" style="display:none">
        <button class="btn-gemini" onclick="closeGeminiModal()">סגור</button>
        <button class="btn-gemini" id="gemini-regen-btn" onclick="_geminiRegenerate()">🔄 שאלה נוספת</button>
        <button class="btn-gemini" id="gemini-copy-btn" onclick="_copyGeneratedQuestion()">📋 העתק</button>
        <button class="btn-gemini" id="gemini-save-btn" onclick="_geminiSave()" style="background:linear-gradient(135deg,#059669 0%,#10b981 100%)">💾 שמור</button>
      </div>
    </div>`;

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeGeminiModal();
  });

  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden';

  // Store context on the overlay element for regenerate / save
  overlay.dataset.sourceText = sourceText;
  overlay.dataset.type = type;
  overlay.dataset.qOrSubId = qOrSubId;

  // Modal is now open — user selects difficulty and clicks generate
}

/* ── Global AI Questions Cache ─────────────────────────────── */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;  // 6 hours

/**
 * Check Firestore cache for existing AI-generated questions.
 * If found (and not expired), display immediately; otherwise call the API.
 */
async function _loadFromCacheOrGenerate(cacheKey, sourceText) {
  const bodyEl = document.getElementById('gemini-body');
  const footer = document.getElementById('gemini-footer');
  if (!bodyEl) return;

  try {
    const cacheDoc = await db.collection('ai_questions_cache').doc(cacheKey).get();
    if (cacheDoc.exists) {
      const cached = cacheDoc.data();
      const items = cached.items || [];
      // Filter out expired items (older than 6 hours)
      const now = Date.now();
      const fresh = items.filter(item => {
        if (!item.createdAt) return false;
        return (now - new Date(item.createdAt).getTime()) < CACHE_TTL_MS;
      });
      if (fresh.length) {
        // Pick a random fresh cached question
        const pick = fresh[Math.floor(Math.random() * fresh.length)];
        const text = pick.text || '';
        if (text) {
          _stopGeminiLoading();
          const overlay = document.getElementById('gemini-modal-overlay');
          if (overlay) overlay.dataset.generatedText = text;
          _renderGeminiResult(bodyEl, text);
          if (footer) footer.style.display = 'flex';
          _showRateButtons();
          _logEvent('ai_question_generated', { courseCode: STATE.courseCode || STATE.courseId, examId: STATE.examLabel || STATE.examId || '', questionId: _questionRef(overlay?.dataset?.qOrSubId), fromCache: true });
          _ga('use_ai', { course_code: _cc(), exam_id: _eid(), question_id: _questionRef(overlay?.dataset?.qOrSubId), action: 'generate', from_cache: true });
          return;
        }
      }
    }
  } catch (e) {
    console.warn('Cache lookup failed, generating fresh:', e.message);
  }

  // No cache hit (or all expired) — generate via API
  _callGeminiAPI(sourceText);
}

/**
 * Save a generated question to the global cache collection.
 * Includes TTL-aware cleanup: removes expired items on write.
 */
async function _saveToCache(cacheKey, sourceText, generatedText) {
  try {
    const ref = db.collection('ai_questions_cache').doc(cacheKey);
    const snap = await ref.get();
    const now = Date.now();
    let items = [];

    if (snap.exists) {
      // Keep only non-expired items
      items = (snap.data().items || []).filter(item =>
        item.createdAt && (now - new Date(item.createdAt).getTime()) < CACHE_TTL_MS
      );
    }

    items.push({ text: generatedText, createdAt: new Date().toISOString() });

    await ref.set({
      sourceText,
      items,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  } catch (e) {
    console.warn('Failed to save to AI cache:', e.message);
  }
}

/**
 * Call Gemini API and display the result.
 * Production: streams via Edge Function (API key stays server-side).
 * Local dev:  direct call (key from Firestore emulator).
 */
async function _callGeminiAPI(sourceText, isRegenerate = false) {
  const bodyEl = document.getElementById('gemini-body');
  const footer = document.getElementById('gemini-footer');
  if (!bodyEl) return;

  // Prevent concurrent generation requests
  if (_aiGenerateInProgress) {
    toast('יצירת שאלה כבר בתהליך, נא להמתין', 'error');
    return;
  }

  // Client-side quota pre-check (avoids round-trip if quota is known exhausted)
  if (_aiQuotaRemaining !== null && _aiQuotaRemaining <= 0) {
    _showGeminiError('מכסת השאלות היומית מוצתה. נסה שוב מחר.');
    return;
  }

  _aiGenerateInProgress = true;

  // Show loading
  _startGeminiLoading(bodyEl);
  if (footer) footer.style.display = 'none';

  try {
    const prompt = _buildGeminiPrompt(sourceText);
    let text;

    if (_isLocalDev) {
      text = await _callGeminiDirect(prompt);
    } else {
      text = await _callGeminiStream(prompt, bodyEl);
    }

    if (!text) throw new Error('תשובה ריקה מ-Gemini');

    _stopGeminiLoading();

    // Store generated text for save
    const overlay = document.getElementById('gemini-modal-overlay');
    if (overlay) overlay.dataset.generatedText = text;

    // Save to global cache for future users (keyed by question + difficulty)
    const qOrSubId = overlay?.dataset?.qOrSubId;
    const difficulty = document.getElementById('gemini-difficulty')?.value || 'same';
    const cacheKey = qOrSubId ? `${qOrSubId}_${difficulty}` : null;
    if (cacheKey) _saveToCache(cacheKey, sourceText, text);

    // Display final response
    _renderGeminiResult(bodyEl, text);
    if (footer) footer.style.display = 'flex';
    _showRateButtons();
    _logEvent('ai_question_generated', { courseCode: STATE.courseCode || STATE.courseId, examId: STATE.examLabel || STATE.examId || '', questionId: _questionRef(overlay?.dataset?.qOrSubId), fromCache: false });
    _ga('use_ai', { course_code: _cc(), exam_id: _eid(), question_id: _questionRef(overlay?.dataset?.qOrSubId), action: isRegenerate ? 'regenerate' : 'generate', from_cache: false });

    // Decrement local quota counter and persist to Firestore
    if (_isLocalDev && _aiQuotaRemaining !== null && _aiQuotaRemaining > 0) {
      _aiQuotaRemaining--;
      _persistQuotaToFirestore();
    }
    _updateQuotaBadge();
    _updateNavbarQuotaBadge();

  } catch (e) {
    _stopGeminiLoading();
    // Don't show error if user intentionally closed the modal
    if (e.name === 'AbortError') {
      // Quota already decremented by closeGeminiModal — just exit
      return;
    }
    _showGeminiError(e.message);
    // Log client-side error to Firestore so admin AI monitor can see it
    _logClientAIError(e.message).catch(() => {});
    // Decrement quota on error too — the server already consumed the request
    if (_aiQuotaRemaining !== null && _aiQuotaRemaining > 0) _aiQuotaRemaining--;
    _updateQuotaBadge();
    _updateNavbarQuotaBadge();
    _persistQuotaToFirestore();
  } finally {
    _aiGenerateInProgress = false;
    _aiStreamAbort = null;
  }
}

/** Direct Gemini API call (local dev only — key loaded from emulator) */
async function _callGeminiDirect(prompt) {
  const key = await _loadGeminiKey();
  if (!key) throw new Error('מפתח Gemini לא נטען — פנה למנהל');

  _aiStreamAbort = new AbortController();

  const GEMINI_MODEL = 'gemini-3.1-pro-preview';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.65, maxOutputTokens: 16384 },
    }),
    signal: _aiStreamAbort.signal,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Gemini API error: ${res.status}`);
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

/** Streaming call via Netlify Edge Function (production) */
async function _callGeminiStream(prompt, bodyEl) {
  const idToken = await STATE.fireUser?.getIdToken();
  if (!idToken) throw new Error('יש להתחבר כדי להשתמש בתכונה זו');

  _aiStreamAbort = new AbortController();

  const res = await fetch('/api/generate-question', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${idToken}`,
    },
    body: JSON.stringify({ prompt }),
    signal: _aiStreamAbort.signal,
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    // Surface quota info on 429
    if (res.status === 429 && errData.quota) {
      _aiQuotaRemaining = 0;
      _aiQuotaLimit = errData.quota.limit;
    }
    throw new Error(errData?.error || `Server error: ${res.status}`);
  }

  // Read quota headers from SSE response
  const qr = res.headers.get('X-Quota-Remaining');
  const ql = res.headers.get('X-Quota-Limit');
  if (qr !== null) _aiQuotaRemaining = parseInt(qr, 10);
  if (ql !== null) _aiQuotaLimit = parseInt(ql, 10);
  _updateQuotaBadge();

  // Collect full response in background — spinner stays visible until done
  let fullText = '';
  const reader = res.body.getReader();
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
      const payload = line.slice(6).trim();
      if (payload === '[DONE]') continue;

      try {
        const chunk = JSON.parse(payload);
        if (chunk.error) throw new Error(chunk.error);
        if (chunk.text) {
          fullText += chunk.text;
        }
      } catch (e) {
        if (e.message && !e.message.startsWith('Unexpected')) throw e;
      }
    }
  }

  return fullText;
}

/** Log AI generation error from client side (catches 500s, network failures, etc.) */
async function _logClientAIError(errorMessage) {
  try {
    const uid = STATE.fireUser?.uid;
    if (!uid) return;
    await db.collection('generate_usage').add({
      uid,
      api: 'none',
      status: 'error',
      errorMessage: `[client] ${errorMessage}`,
      timestamp: new Date().toISOString(),
      date_key: new Date().toISOString().slice(0, 10),
      latencyMs: 0,
      promptLength: 0,
      responseLength: 0,
      inputTokens: 0,
      outputTokens: 0,
      cached: false,
    });
  } catch { /* silently fail — don't break the user experience */ }
}

/** Render Gemini text with MathJax (shared by both paths) */
async function _renderGeminiResult(container, text) {
  const wrapper = container.querySelector('.gemini-result') || document.createElement('div');
  if (!wrapper.parentElement) {
    wrapper.className = 'qv-text gemini-result';
    wrapper.style.cssText = 'direction:rtl;line-height:1.8;';
    container.innerHTML = '';
    container.appendChild(wrapper);
  }
  wrapper.textContent = text;

  if (window.MathJax) {
    await MathJax.typesetPromise([wrapper]);
    // After MathJax, convert remaining newlines to <br> and bold in text nodes
    const walk = document.createTreeWalker(wrapper, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walk.nextNode()) textNodes.push(walk.currentNode);
    textNodes.forEach(node => {
      if (node.parentElement?.closest('mjx-container')) return;
      if (node.textContent.includes('\n') || /\*\*.+?\*\*/.test(node.textContent)) {
        const span = document.createElement('span');
        span.innerHTML = node.textContent
          .replace(/&/g, '&amp;').replace(/</g, '&lt;')
          .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
          .replace(/\n/g, '<br>');
        node.replaceWith(span);
      }
    });
  }
}

function _showGeminiError(msg) {
  const body = document.getElementById('gemini-body');
  if (!body) return;

  // Add quota info if available
  let quotaHtml = '';
  if (_aiQuotaRemaining !== null && _aiQuotaLimit !== null) {
    quotaHtml = `<p style="font-size:.8rem;color:#9ca3af;margin-top:.5rem">מכסה: ${_aiQuotaLimit - (_aiQuotaRemaining || 0)}/${_aiQuotaLimit} שאלות היום</p>`;
  }

  body.innerHTML = `<div style="text-align:center;padding:1.5rem;color:#dc2626">
    <p style="font-weight:600">שגיאה ביצירת שאלה</p>
    <p style="font-size:.85rem;color:#6b7280;margin-top:.5rem">${esc(msg)}</p>
    ${quotaHtml}
    <button class="btn-gemini" style="margin-top:1rem" onclick="_geminiRegenerate()">נסה שוב</button>
  </div>`;
}

/** Start generation after user picks difficulty and clicks the button */
function _geminiStartGenerate() {
  const overlay = document.getElementById('gemini-modal-overlay');
  if (!overlay) return;
  const sourceText = overlay.dataset.sourceText || '';
  const qOrSubId = overlay.dataset.qOrSubId || '';
  if (!sourceText) return;

  const difficulty = document.getElementById('gemini-difficulty')?.value || 'same';

  // Hide config row, start loading
  const configRow = document.getElementById('gemini-config-row');
  if (configRow) configRow.style.display = 'none';

  const cacheKey = `${qOrSubId}_${difficulty}`;
  _startGeminiLoading(document.getElementById('gemini-body'));
  _loadFromCacheOrGenerate(cacheKey, sourceText);
}

function _buildGeminiPrompt(sourceText) {
  const difficulty = document.getElementById('gemini-difficulty')?.value || 'same';
  const template   = 'similar';

  const difficultyInstructions = {
    same:   'שמור על אותה רמת קושי כמו השאלה המקורית.',
    easy:   'הפוך את השאלה לקלה יותר — שלבים פחותים, מספרים פשוטים יותר, פחות מלכודות.',
    medium: 'צור שאלה ברמת קושי בינונית — דומה למקור אך עם שינויים מתונים.',
    hard:   'הקשה את השאלה — הוסף שלבים, שילוב מושגים, או מקרי קצה מאתגרים.',
  };

  const templateInstructions = {
    similar:    'צור שאלה *אחת* חדשה שדומה לשאלה המקורית, עם אותו מבנה ומושגים אך נתונים שונים.',
    exam:       'צור שאלת בחינה פורמלית *אחת* — כתוב כאילו מדובר בבחינת אמצע/סוף סמסטר, עם ניסוח רשמי ומדויק. כלול את כל הסעיפים הנדרשים.',
    conceptual: 'צור שאלה מושגית/תיאורטית *אחת* — שאלת הבנה שבודקת את ההבנה העמוקה של המושגים, ללא חישובים כבדים. למשל: "הוכח או הפרך", "הסבר מדוע", "תן דוגמה נגדית".',
    proof:      'צור שאלת הוכחה *אחת* — שאלה שדורשת הוכחה מתמטית פורמלית, תוך שימוש באותם כלים ומושגים שמופיעים בשאלה המקורית.',
  };

  return `אתה מרצה בכיר למתמטיקה באוניברסיטה (מומחה לאלגברה לינארית, חדו"א ועוד).

${templateInstructions[template] || templateInstructions.similar}

רמת קושי: ${difficultyInstructions[difficulty] || difficultyInstructions.same}

הנחיות קריטיות:
1. אותו מבנה ואותם מושגים: שמור על אותו נושא מתמטי, אותו סוג שאלה (חישוב/הוכחה/בדיקה), אותו מספר סעיפים, ואותם מושגים בדיוק שמופיעים בשאלה המקורית. אל תכניס מושגים או כלים שלא מופיעים בשאלה המקורית.
2. שנה את הנתונים: שנה את המספרים, המטריצות, הווקטורים או הפונקציות — אבל שמור על אותו גודל ואותו סוג (למשל מטריצה 3×3 נשארת 3×3, אינטגרל מסוים נשאר אינטגרל מסוים). שנה מספיק כדי שזו תהיה שאלה שונה באמת (לא רק ±1).
3. נתונים הגיוניים: ודא מתמטית שהשאלה החדשה פתירה בצורה "נקייה" (לדוגמה: אם בשאלה המקורית הפתרון כלל מספרים שלמים, אל תיצור מטריצה שתניב שברים מסובכים).
4. ניסוח מעט שונה: נסח את השאלה במילים שונות קצת מהמקור, אבל שמור על אותה משמעות.
5. עיצוב MathJax: כל ביטוי מתמטי, משוואה, מטריצה או משתנה חייב להיות עטוף ב-LaTeX תקין. השתמש ב-$ עבור מתמטיקה בשורה (inline) וב-$$ עבור משוואות מופרדות.
6. פלט נקי: החזר *אך ורק* את הטקסט של השאלה החדשה בעברית. אל תוסיף הקדמות ("הנה השאלה שביקשת"), ואל תוסיף את הפתרון.

השאלה המקורית:
${sourceText}`;
}

function _geminiRegenerate() {
  const overlay = document.getElementById('gemini-modal-overlay');
  if (!overlay) return;
  const sourceText = overlay.dataset.sourceText || '';
  if (sourceText) _callGeminiAPI(sourceText, true);
}

async function _geminiSave() {
  const overlay = document.getElementById('gemini-modal-overlay');
  if (!overlay) return;
  const uid = STATE.fireUser?.uid;
  if (!uid) { toast('יש להתחבר כדי לשמור', 'error'); return; }

  const sourceText   = overlay.dataset.sourceText || '';
  const generatedText = overlay.dataset.generatedText || '';
  const type          = overlay.dataset.type || 'question';
  if (!generatedText) { toast('אין שאלה לשמירה', 'error'); return; }

  const saveBtn = document.getElementById('gemini-save-btn');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'שומר...'; }

  const entry = {
    id:            genId(),
    originalText:  sourceText,
    generatedText: generatedText,
    createdAt:     new Date().toISOString(),
    type:          type,
    courseId:       STATE.courseId || '',
  };

  try {
    await db.collection('users').doc(uid).update({
      aiQuestions: firebase.firestore.FieldValue.arrayUnion(entry)
    });
    // Update local state
    if (!STATE.userData.aiQuestions) STATE.userData.aiQuestions = [];
    STATE.userData.aiQuestions.push(entry);
    toast('✅ השאלה נשמרה!', 'info');
    _logEvent('ai_question_saved', { courseCode: STATE.courseCode || STATE.courseId, examId: STATE.examLabel || STATE.examId || '', questionId: _questionRef(overlay?.dataset?.qOrSubId || '') });
    _ga('use_ai', { course_code: _cc(), exam_id: _eid(), question_id: _questionRef(overlay?.dataset?.qOrSubId || ''), action: 'save' });
    // Brief visual feedback on button, keep modal open
    if (saveBtn) {
      saveBtn.textContent = '✅ נשמר!';
      saveBtn.disabled = true;
      setTimeout(() => { saveBtn.textContent = '💾 שמור'; saveBtn.disabled = false; }, 1500);
    }
  } catch (e) {
    console.error('Error saving AI question:', e);
    toast('שגיאה בשמירה — נסה שוב', 'error');
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '💾 שמור'; }
  }
}

function closeGeminiModal() {
  _stopGeminiLoading();
  // If generation is in progress, count it toward quota before aborting
  if (_aiGenerateInProgress) {
    if (_aiQuotaRemaining !== null && _aiQuotaRemaining > 0) _aiQuotaRemaining--;
    _updateQuotaBadge();
    _updateNavbarQuotaBadge();
    _persistQuotaToFirestore();
  }
  // Abort any in-flight stream and reset the generation lock
  if (_aiStreamAbort) { _aiStreamAbort.abort(); _aiStreamAbort = null; }
  _aiGenerateInProgress = false;
  document.getElementById('gemini-modal-overlay')?.remove();
  document.body.style.overflow = '';
}

/* ── AI Questions Tab ──────────────────────────────────────── */
function renderAIQuestionsTab() {
  const tc = document.getElementById('tab-content');
  if (!tc) return;

  const allItems = STATE.userData?.aiQuestions || [];
  const items = allItems.filter(q => q.courseId === STATE.courseId);

  if (!items.length) {
    tc.innerHTML = `<div class="empty" style="margin-top:2rem">
      <span class="ei">✨</span>
      <h3>אין שאלות שנוצרו</h3>
      <p>לחץ על כפתור ✨ ליד שאלה כדי ליצור שאלה דומה באמצעות AI</p>
    </div>`;
    return;
  }

  // Show newest first
  const sorted = [...items].reverse();
  const copySVG = `<svg width="15" height="15" viewBox="0 0 16 16" fill="#9ca3af">
    <path d="M4 1.5H3a2 2 0 0 0-2 2V14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V3.5a2 2 0 0 0-2-2h-1v1h1a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1h1v-1z"/>
    <path d="M9.5 1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5h3zm-3-1A1.5 1.5 0 0 0 5 1.5v1A1.5 1.5 0 0 0 6.5 4h3A1.5 1.5 0 0 0 11 2.5v-1A1.5 1.5 0 0 0 9.5 0h-3z"/></svg>`;

  tc.innerHTML = `<div style="margin-top:.5rem">
    <p style="color:var(--muted);font-size:.85rem;margin-bottom:1rem">
      ${items.length} שאלות שנוצרו באמצעות AI
    </p>
    ${sorted.map((item, idx) => {
      const realIdx = allItems.indexOf(item);
      return `<div class="ai-q-card">
        <details style="margin-bottom:.5rem">
          <summary style="cursor:pointer;font-size:.82rem;color:var(--muted);font-weight:600">📄 שאלה מקורית</summary>
          <div style="padding:.5rem .75rem;font-size:.88rem;background:#f9fafb;border-radius:8px;margin-top:.5rem;white-space:pre-wrap;direction:rtl" class="ai-q-original-${realIdx}">${esc(item.originalText || '')}</div>
        </details>
        <div class="ai-q-text ai-q-generated-${realIdx}">${esc(item.generatedText || '')}</div>
        <div class="ai-q-actions">
          <button class="qv-btn" onclick="copyAiQuestion(${realIdx})" title="העתק LaTeX">${copySVG}</button>
          <button class="btn btn-sm" style="color:#dc2626;border-color:#fecaca" onclick="deleteAiQuestion(${realIdx})">🗑️ מחק</button>
        </div>
      </div>`;
    }).join('')}
  </div>`;

  // Render MathJax for all generated/original texts (safe: textContent + MathJax)
  sorted.forEach((item, idx) => {
    const realIdx = allItems.indexOf(item);
    const genEl = tc.querySelector(`.ai-q-generated-${realIdx}`);
    if (genEl) _renderGeminiResult(genEl, item.generatedText || '');
    const origEl = tc.querySelector(`.ai-q-original-${realIdx}`);
    if (origEl) _renderGeminiResult(origEl, item.originalText || '');
  });

  if (window.MathJax) MathJax.typesetPromise([tc]);
}

async function copyAiQuestion(index) {
  const items = STATE.userData?.aiQuestions || [];
  const item = items[index];
  if (!item) return;
  try {
    await navigator.clipboard.writeText(item.generatedText || '');
    toast('📋 השאלה הועתקה', 'info');
  } catch (e) {
    console.error('Copy failed:', e);
    toast('שגיאה בהעתקה', 'error');
  }
}

async function deleteAiQuestion(index) {
  if (!confirm('למחוק את השאלה?')) return;
  const uid = STATE.fireUser?.uid;
  if (!uid) return;

  const items = STATE.userData?.aiQuestions || [];
  if (index < 0 || index >= items.length) return;

  const removed = items[index];
  items.splice(index, 1);
  STATE.userData.aiQuestions = items;

  // Re-render immediately
  renderAIQuestionsTab();

  try {
    await db.collection('users').doc(uid).update({
      aiQuestions: firebase.firestore.FieldValue.arrayRemove(removed)
    });
    toast('🗑️ השאלה נמחקה', 'info');
  } catch (e) {
    console.error('Error deleting AI question:', e);
    toast('שגיאה במחיקה', 'error');
  }
}

function _showRateButtons() {
  const wrap = document.getElementById('gemini-rate-wrap');
  if (wrap) wrap.style.display = 'flex';
}

function _copyGeneratedQuestion() {
  const overlay = document.getElementById('gemini-modal-overlay');
  if (!overlay) return;
  const text = overlay.dataset.generatedText || '';
  if (!text) { toast('אין שאלה להעתקה', 'error'); return; }
  navigator.clipboard.writeText(text).then(() => {
    toast('📋 השאלה הועתקה!', 'info');
    _logEvent('ai_question_copied', { courseCode: STATE.courseCode || STATE.courseId, examId: STATE.examLabel || STATE.examId || '', questionId: _questionRef(overlay.dataset.qOrSubId || '') });
    _ga('copy_content', { course_code: _cc(), exam_id: _eid(), question_id: _questionRef(overlay.dataset.qOrSubId || ''), content_type: 'ai_generated' });
  }).catch(() => {
    toast('שגיאה בהעתקה', 'error');
  });
}

/* ── Quality Rating (thumbs up/down) ─────────────────────── */
async function _rateQuestion(rating) {
  const overlay = document.getElementById('gemini-modal-overlay');
  if (!overlay) return;
  const uid = STATE.fireUser?.uid;
  if (!uid) return;

  const qOrSubId = overlay.dataset.qOrSubId || '';
  const generatedText = overlay.dataset.generatedText || '';
  if (!generatedText) return;

  const upBtn   = document.getElementById('gemini-rate-up');
  const downBtn = document.getElementById('gemini-rate-down');

  // Visual feedback
  if (rating === 'up') {
    if (upBtn) { upBtn.style.background = '#dcfce7'; upBtn.disabled = true; }
    if (downBtn) downBtn.disabled = true;
  } else {
    if (downBtn) { downBtn.style.background = '#fef2f2'; downBtn.disabled = true; }
    if (upBtn) upBtn.disabled = true;
  }

  try {
    // Use deterministic doc ID to prevent duplicate ratings per user+question
    const ratingDocId = `${uid}_${qOrSubId}`;
    await db.collection('question_ratings').doc(ratingDocId).set({
      uid,
      questionId: qOrSubId,
      rating,
      generatedTextPreview: generatedText.slice(0, 200),
      courseId: STATE.courseId || '',
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    toast(rating === 'up' ? '👍 תודה על המשוב!' : '👎 תודה, נשתפר!', 'info');
    _logEvent('ai_question_rated', { rating, questionId: _questionRef(qOrSubId), courseCode: STATE.courseCode || STATE.courseId, examId: STATE.examLabel || STATE.examId || '' });
    _ga('rate_content', { course_code: _cc(), exam_id: _eid(), question_id: _questionRef(qOrSubId), rating_category: 'ai_quality', rating_value: rating });
  } catch (e) {
    console.warn('Failed to save rating:', e.message);
  }
}

/* ══════════════════════════════════════════════════════════
   VIDEO EXPLANATIONS — Bunny.net integration
══════════════════════════════════════════════════════════ */

/**
 * Fetch question_videos docs for all question IDs + sub-question IDs in this exam.
 * Returns a map: { [id]: { libraryId, videoId, title } }
 */
async function fetchExamVideoMap(questions) {
  const allIds = [];
  questions.forEach(q => {
    allIds.push(q.id);
    (q.subs || q.parts || []).forEach(s => allIds.push(s.id));
  });
  if (!allIds.length) return {};
  const videoMap = {};
  // Firestore 'in' supports up to 30 items per query — chunk accordingly
  const chunks = [];
  for (let i = 0; i < allIds.length; i += 30) chunks.push(allIds.slice(i, i + 30));
  await Promise.all(chunks.map(async chunk => {
    try {
      const snap = await db.collection('question_videos')
        .where(firebase.firestore.FieldPath.documentId(), 'in', chunk)
        .get();
      snap.forEach(doc => { videoMap[doc.id] = doc.data(); });
    } catch (e) {
      console.warn('fetchExamVideoMap error:', e);
    }
  }));
  return videoMap;
}

/** Open a Bunny.net video explanation in a modal overlay. */
function openVideoModalFromBtn(btn) {
  const libraryId = btn?.dataset?.lib || '';
  const videoId = btn?.dataset?.vid || '';
  const title = btn?.dataset?.title || 'סרטון פתרון';
  const entityId = btn?.dataset?.entityId || '';
  const entityLabel = btn?.dataset?.entityLabel || '';
  openVideoModal(libraryId, videoId, title, entityId, entityLabel);
}

let _videoModalEscHandler = null;

function closeVideoModal() {
  document.getElementById('video-modal')?.remove();
  if (_videoModalEscHandler) {
    document.removeEventListener('keydown', _videoModalEscHandler);
    _videoModalEscHandler = null;
  }
}

function openVideoModal(libraryId, videoId, title, entityId = '', entityLabel = '') {
  closeVideoModal();
  // Validate IDs — only allow alphanumeric + hyphens (no injection)
  const safeLib = String(libraryId).replace(/[^a-zA-Z0-9\-]/g, '');
  const safeVid = String(videoId).replace(/[^a-zA-Z0-9\-]/g, '');
  if (!safeLib || !safeVid) { toast('מזהה סרטון לא תקין', 'error'); return; }
  const embedUrl = `https://player.mediadelivery.net/embed/${safeLib}/${safeVid}?autoplay=false&preload=true&showSpeed=true&playsinline=true&rememberPosition=false`;
  const directPlayUrl = `https://video.bunnycdn.com/play/${safeLib}/${safeVid}`;

  const overlay = document.createElement('div');
  overlay.id = 'video-modal';
  overlay.className = 'video-modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', esc(title || 'סרטון פתרון'));
  overlay.innerHTML = `
    <div class="video-modal-card">
      <div class="video-modal-header">
        <span class="video-modal-title">${esc(title || 'סרטון פתרון')}</span>
        <div class="video-modal-actions">
          <a class="video-modal-open" href="${directPlayUrl}" target="_blank" rel="noopener noreferrer" title="פתח בנגן Bunny">⤢</a>
          <button class="video-modal-report"
            data-video-library-id="${esc(safeLib)}"
            data-video-id="${esc(safeVid)}"
            data-video-title="${esc(title || 'סרטון פתרון')}"
            data-entity-id="${esc(entityId)}"
            data-entity-label="${esc(entityLabel)}"
            onclick="openVideoReportFromModalBtn(this)"
            title="דווח על טעות בסרטון">⚠</button>
          <button class="video-modal-close" onclick="closeVideoModal()" aria-label="סגור">✕</button>
        </div>
      </div>
      <div class="video-modal-player">
        <iframe
          src="${embedUrl}"
          loading="eager"
          allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture"
          allowfullscreen
          title="${esc(title || 'סרטון פתרון')}"
        ></iframe>
      </div>
    </div>`;

  overlay.addEventListener('click', e => { if (e.target === overlay) closeVideoModal(); });
  _videoModalEscHandler = e => {
    if (e.key === 'Escape') closeVideoModal();
  };
  document.addEventListener('keydown', _videoModalEscHandler);
  document.body.appendChild(overlay);
}

function openVideoReportFromModalBtn(btn) {
  openVideoIssueReportModal({
    videoLibraryId: btn?.dataset?.videoLibraryId || '',
    videoId: btn?.dataset?.videoId || '',
    videoTitle: btn?.dataset?.videoTitle || 'סרטון פתרון',
    entityId: btn?.dataset?.entityId || '',
    entityLabel: btn?.dataset?.entityLabel || '',
  });
}

function openVideoIssueReportModal(ctx = {}) {
  document.getElementById('video-report-modal')?.remove();
  const examTitle = document.querySelector('.ev-banner-title')?.textContent?.trim() || '';

  const modal = document.createElement('div');
  modal.id = 'video-report-modal';
  modal.className = 'modal-overlay';
  modal.style.zIndex = '10620';
  modal.dataset.videoLibraryId = ctx.videoLibraryId || '';
  modal.dataset.videoId = ctx.videoId || '';
  modal.dataset.videoTitle = ctx.videoTitle || 'סרטון פתרון';
  modal.dataset.entityId = ctx.entityId || '';
  modal.dataset.entityLabel = ctx.entityLabel || '';
  modal.dataset.examId = STATE.examId || '';
  modal.dataset.examTitle = examTitle;
  modal.dataset.courseId = STATE.courseId || '';

  modal.innerHTML = `
    <div class="modal-card" style="max-width:500px">
      <div class="modal-header">
        <h3 style="margin:0;font-size:1.05rem">⚠ דווח על טעות בסרטון</h3>
        <button class="modal-close" onclick="closeVideoIssueReportModal()">✕</button>
      </div>
      <div style="padding:1.15rem;display:flex;flex-direction:column;gap:.9rem">
        <div style="background:var(--bg2,#f9fafb);border-radius:8px;padding:.65rem .9rem;font-size:.84rem;color:var(--muted);border:1px solid var(--border)">
          סרטון: <strong>${esc(ctx.videoTitle || 'סרטון פתרון')}</strong><br>
          ${ctx.entityLabel ? `מיקום: <strong>${esc(ctx.entityLabel)}</strong>` : ''}
        </div>
        <div class="form-group" style="margin:0">
          <label>תיאור הבעיה</label>
          <textarea id="video-report-message" rows="4" dir="rtl"
            placeholder="מה הבעיה בסרטון? (אפשר לציין גם זמן בסרטון, למשל 02:15)"
            style="width:100%;border:1.5px solid var(--border);border-radius:8px;padding:.75rem;font-family:inherit;font-size:.9rem;resize:vertical;box-sizing:border-box;color:var(--text)"></textarea>
        </div>
        <div id="video-report-err" style="color:var(--danger);font-size:.83rem;display:none"></div>
        <div style="display:flex;justify-content:flex-end;gap:.7rem">
          <button class="btn btn-secondary" onclick="closeVideoIssueReportModal()">ביטול</button>
          <button class="btn btn-primary" id="video-report-submit-btn" onclick="submitVideoIssueReport()">שלח דיווח</button>
        </div>
      </div>
    </div>`;

  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) closeVideoIssueReportModal(); });
}

async function submitVideoIssueReport() {
  const modal = document.getElementById('video-report-modal');
  const msgEl = document.getElementById('video-report-message');
  const errEl = document.getElementById('video-report-err');
  const btn = document.getElementById('video-report-submit-btn');
  const message = (msgEl?.value || '').trim();

  if (!message) {
    if (errEl) { errEl.textContent = 'אנא תאר את הבעיה בסרטון'; errEl.style.display = 'block'; }
    return;
  }
  if (!modal) return;

  if (errEl) errEl.style.display = 'none';
  if (btn) { btn.disabled = true; btn.textContent = 'שולח...'; }
  try {
    await db.collection('reports').add({
      category: 'video_bug',
      type: 'video_issue',
      message,
      courseId: modal.dataset.courseId || '',
      examId: modal.dataset.examId || '',
      examTitle: modal.dataset.examTitle || '',
      entityId: modal.dataset.entityId || '',
      entityLabel: modal.dataset.entityLabel || '',
      videoLibraryId: modal.dataset.videoLibraryId || '',
      videoId: modal.dataset.videoId || '',
      videoTitle: modal.dataset.videoTitle || '',
      userId: STATE.fireUser?.uid || '',
      userEmail: STATE.fireUser?.email || '',
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      status: 'open',
      adminResponseText: '',
      adminResponseAt: null,
      userLastReadAt: null,
      adminDeletedAt: null,
      userDeletedAt: null,
      bothDeletedAt: null,
    });
    _ga('submit_feedback', { feedback_type: 'video_report' });
    closeVideoIssueReportModal();
    toast('הדיווח נשלח — תודה! 🙏', 'info');
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = 'שלח דיווח'; }
    if (errEl) { errEl.textContent = 'שגיאה בשליחה — נסה שוב'; errEl.style.display = 'block'; }
  }
}

function closeVideoIssueReportModal() {
  document.getElementById('video-report-modal')?.remove();
}

/** Admin: open modal to attach or update a Bunny video for a question / sub-question. */
async function openVideoAttachModal(entityId, entityLabel) {
  document.getElementById('video-attach-modal')?.remove();
  let existing = {};
  try {
    const doc = await db.collection('question_videos').doc(entityId).get();
    if (doc.exists) existing = doc.data();
  } catch (e) { console.warn('openVideoAttachModal fetch:', e); }

  const overlay = document.createElement('div');
  overlay.id = 'video-attach-modal';
  overlay.className = 'video-modal-overlay';
  overlay.innerHTML = `
    <div class="video-modal-card" style="max-width:480px">
      <div class="video-modal-header">
        <span class="video-modal-title">🎬 ${esc(entityLabel)} — צרף סרטון Bunny</span>
        <button class="video-modal-close" onclick="document.getElementById('video-attach-modal').remove()" aria-label="סגור">✕</button>
      </div>
      <div style="padding:1.2rem;display:flex;flex-direction:column;gap:.85rem">
        <div>
          <label style="font-size:.85rem;color:var(--muted);display:block;margin-bottom:.3rem">Library ID</label>
          <input id="va-lib" type="text" placeholder="למשל: 123456"
            value="${esc(existing.libraryId || '')}"
            style="width:100%;box-sizing:border-box;padding:.5rem .7rem;border:1.5px solid var(--border);border-radius:8px;font-size:.9rem;font-family:inherit">
        </div>
        <div>
          <label style="font-size:.85rem;color:var(--muted);display:block;margin-bottom:.3rem">Video ID (GUID)</label>
          <input id="va-vid" type="text" placeholder="למשל: a1b2c3d4-e5f6-..."
            value="${esc(existing.videoId || '')}"
            style="width:100%;box-sizing:border-box;padding:.5rem .7rem;border:1.5px solid var(--border);border-radius:8px;font-size:.9rem;font-family:inherit">
        </div>
        <div>
          <label style="font-size:.85rem;color:var(--muted);display:block;margin-bottom:.3rem">כותרת (אופציונלי)</label>
          <input id="va-title" type="text" placeholder="פתרון לשאלה..."
            value="${esc(existing.title || '')}"
            style="width:100%;box-sizing:border-box;padding:.5rem .7rem;border:1.5px solid var(--border);border-radius:8px;font-size:.9rem;font-family:inherit">
        </div>
        <div id="va-err" style="color:#ef4444;font-size:.85rem;display:none"></div>
        <div style="display:flex;gap:.6rem;justify-content:flex-end;flex-wrap:wrap">
          ${existing.videoId ? `<button class="btn" style="color:#ef4444;border-color:#ef4444" onclick="detachQuestionVideo('${esc(entityId)}')">🗑 הסר סרטון</button>` : ''}
          <button class="btn" onclick="document.getElementById('video-attach-modal').remove()">ביטול</button>
          <button class="btn btn-primary" onclick="saveVideoAttach('${esc(entityId)}')">שמור</button>
        </div>
      </div>
    </div>`;

  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  document.getElementById('va-lib')?.focus();
}

/** Admin: persist a video mapping to Firestore. */
async function saveVideoAttach(entityId) {
  const libraryId = (document.getElementById('va-lib')?.value || '').trim();
  const videoId   = (document.getElementById('va-vid')?.value || '').trim();
  const title     = (document.getElementById('va-title')?.value || '').trim();
  const errEl     = document.getElementById('va-err');

  if (!libraryId || !videoId) {
    errEl.textContent = 'Library ID ו-Video ID הם שדות חובה';
    errEl.style.display = 'block';
    return;
  }
  if (!/^\d+$/.test(libraryId)) {
    errEl.textContent = 'Library ID חייב להיות מספר';
    errEl.style.display = 'block';
    return;
  }
  // Video ID must be a GUID-like string
  if (!/^[a-zA-Z0-9\-]{8,}$/.test(videoId)) {
    errEl.textContent = 'Video ID לא תקין — יש להזין את ה-GUID מ-Bunny';
    errEl.style.display = 'block';
    return;
  }

  const btn = document.querySelector('#video-attach-modal .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = 'שומר...'; }
  try {
    await db.collection('question_videos').doc(entityId).set({
      libraryId,
      videoId,
      title: title || '',
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    toast('✅ הסרטון נשמר בהצלחה', 'info');
    document.getElementById('video-attach-modal')?.remove();
    renderExam(); // reload to show the new play button
  } catch (e) {
    if (errEl) { errEl.textContent = 'שגיאה בשמירה: ' + e.message; errEl.style.display = 'block'; }
    if (btn) { btn.disabled = false; btn.textContent = 'שמור'; }
  }
}

/** Admin: delete a video mapping from Firestore. */
async function detachQuestionVideo(entityId) {
  if (!confirm('להסיר את הסרטון מהשאלה?')) return;
  try {
    await db.collection('question_videos').doc(entityId).delete();
    toast('סרטון הוסר', 'info');
    document.getElementById('video-attach-modal')?.remove();
    renderExam();
  } catch (e) {
    toast('שגיאה בהסרת הסרטון: ' + e.message, 'error');
  }
}
