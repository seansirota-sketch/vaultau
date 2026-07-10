/*!
 * telemetry.js — VaultAU dual-tier telemetry client SDK
 *
 * Design: docs/architecture-telemetry-difficulty-admin.md §2.3, §5
 *
 * Two exported functions:
 *   emitT1(event, { itemId, courseId, payload })
 *   emitT2(event, { itemId, courseId, payload })
 *
 * Contract:
 *   - Tier 1: NEVER carries uid/email. sessionSalt is random per-tab and
 *     rotated on login/logout (never derived from uid).
 *   - Tier 2: only emitted when the user has consented AND the auth token
 *     carries a valid consentT2 claim. Client-side check is defence-in-depth;
 *     rules are the authority.
 *   - Both are best-effort fire-and-forget writes; failures are swallowed
 *     to avoid disrupting the UI.
 *   - Simple in-memory throttle: same (event, itemId) at most once per
 *     THROTTLE_MS window.
 *
 * Depends on the compat Firebase globals already used across this repo:
 *   window.firebase, window.db, window.auth
 * (i.e. firebase-config.js has run before this module is loaded)
 *
 * Usage:
 *   import { initTelemetry, emitT1, emitT2 } from './telemetry.js';
 *   initTelemetry({ db: window.db, auth: window.auth });
 *   emitT1('exam_open', { itemId: `exam:${examId}`, courseId, payload: { examId } });
 *   emitT2('reveal_difficulty', { itemId: `q:${qid}`, payload: { source: 'exam_page' } });
 */

'use strict';

const TTL_T1_DAYS = 90;
const TTL_T2_DAYS = 365;
const THROTTLE_MS = 5000;

// ── Session salt ───────────────────────────────────────────────────────────
// Random per-tab identifier. NEVER derived from uid. Rotated on login/logout.
// Kept in sessionStorage so a page reload preserves it within the same session,
// but a new tab / new session gets a fresh one.

const SESSION_KEY = 'vaultau_t1_session_salt';

function _makeSalt() {
  const bytes = new Uint8Array(16);
  (self.crypto || window.crypto).getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function _getSalt() {
  let s = null;
  try { s = sessionStorage.getItem(SESSION_KEY); } catch (_) { /* private mode */ }
  if (!s) {
    s = _makeSalt();
    try { sessionStorage.setItem(SESSION_KEY, s); } catch (_) { /* ignore */ }
  }
  return s;
}

export function rotateSessionSalt() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch (_) { /* ignore */ }
  return _getSalt();
}

// ── SDK state ──────────────────────────────────────────────────────────────

let _db   = null;
let _auth = null;
const _lastEmit = new Map(); // key → ms

export function initTelemetry({ db, auth } = {}) {
  _db   = db   || (typeof window !== 'undefined' ? window.db   : null);
  _auth = auth || (typeof window !== 'undefined' ? window.auth : null);
  if (_auth && typeof _auth.onAuthStateChanged === 'function') {
    _auth.onAuthStateChanged(() => rotateSessionSalt());
  }
}

function _throttled(kind, event, itemId) {
  const key = `${kind}:${event}:${itemId || ''}`;
  const now = Date.now();
  const last = _lastEmit.get(key) || 0;
  if (now - last < THROTTLE_MS) return true;
  _lastEmit.set(key, now);
  return false;
}

function _ensureDb() {
  if (!_db) _db = (typeof window !== 'undefined') ? window.db : null;
  return _db;
}

function _serverTs() {
  return window.firebase.firestore.FieldValue.serverTimestamp();
}

function _expiresAt(days) {
  return window.firebase.firestore.Timestamp.fromMillis(
    Date.now() + days * 24 * 60 * 60 * 1000,
  );
}

// Guard against accidentally shipping identity in Tier-1 payloads.
const T1_FORBIDDEN_KEYS = new Set(['uid', 'email', 'userId']);

function _sanitizeT1Payload(payload) {
  const out = {};
  if (!payload || typeof payload !== 'object') return out;
  for (const k of Object.keys(payload)) {
    if (T1_FORBIDDEN_KEYS.has(k)) continue;
    out[k] = payload[k];
  }
  return out;
}

// ── Emitters ───────────────────────────────────────────────────────────────

export async function emitT1(event, { itemId = null, courseId = null, payload = {} } = {}) {
  const db = _ensureDb();
  if (!db) return;
  if (!event || typeof event !== 'string') return;
  if (_throttled('t1', event, itemId)) return;

  const doc = {
    event,
    itemId,
    courseId,
    sessionSalt: _getSalt(),
    timestamp:   _serverTs(),
    payload:     _sanitizeT1Payload(payload),
    expiresAt:   _expiresAt(TTL_T1_DAYS),
  };

  try {
    await db.collection('telemetry_t1').add(doc);
  } catch (err) {
    // never disrupt the UI over telemetry — log and move on.
    if (window.console) console.debug('emitT1 failed', event, err && err.code);
  }
}

/**
 * Returns { granted: boolean, version: string|null } derived from the
 * current auth token. Best-effort; the security rules are authoritative.
 */
export async function readConsentClaim() {
  if (!_auth || !_auth.currentUser) return { granted: false, version: null };
  try {
    const res = await _auth.currentUser.getIdTokenResult();
    const c = res.claims && res.claims.consentT2;
    if (c && typeof c.v === 'string') {
      return { granted: true, version: c.v };
    }
  } catch (_) { /* ignore */ }
  return { granted: false, version: null };
}

/**
 * Force a fresh ID token — call this from your consent-grant/revoke UI
 * immediately after the write so the custom claim propagates within
 * seconds instead of within an hour.
 */
export async function refreshAuthToken() {
  if (_auth && _auth.currentUser) {
    try { await _auth.currentUser.getIdToken(true); } catch (_) { /* ignore */ }
  }
}

export async function emitT2(event, { itemId = null, courseId = null, payload = {} } = {}) {
  const db = _ensureDb();
  if (!db) return;
  if (!_auth || !_auth.currentUser) return;
  if (!event || typeof event !== 'string') return;
  if (_throttled('t2', event, itemId)) return;

  const { granted, version } = await readConsentClaim();
  if (!granted) return; // hard guard on client (rules are the authority)

  const doc = {
    uid:            _auth.currentUser.uid,
    consentVersion: version,
    event,
    itemId,
    courseId,
    timestamp:      _serverTs(),
    payload:        (payload && typeof payload === 'object') ? payload : {},
    expiresAt:      _expiresAt(TTL_T2_DAYS),
  };

  try {
    await db.collection('telemetry_t2').add(doc);
  } catch (err) {
    if (window.console) console.debug('emitT2 failed', event, err && err.code);
  }
}
