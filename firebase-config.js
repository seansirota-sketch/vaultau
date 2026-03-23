/* ============================================================
   firebase-config.js  —  Shared Firebase initialization
   ============================================================ */

const firebaseConfig = {
  apiKey:            "AIzaSyD7pwI3HVY5xUm4Xdk2Tuk9BwG267RT-vI",
  authDomain:        "eaxmbank.firebaseapp.com",
  projectId:         "eaxmbank",
  storageBucket:     "eaxmbank.firebasestorage.app",
  messagingSenderId: "431763916395",
  appId:             "1:431763916395:web:f8d06dba827d5b246b532e",
  measurementId: "G-SF9W1XBZZK"
};

var PILOT_STUDENTS = [
  "studetn@mail.tau.ac.il"
];

const CLAUDE_ENDPOINT = "/.netlify/functions/parse-exam";

if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

const db      = firebase.firestore();
const auth    = firebase.auth();
const storage = typeof firebase.storage === 'function' ? firebase.storage() : null;

// Connect to Firebase Emulator when running locally
if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
  db.useEmulator('localhost', 8080);
  auth.useEmulator('http://localhost:9099');
  if (storage) storage.useEmulator('localhost', 9199);
}

async function fetchCourses() {
  const snap = await db.collection('courses').orderBy('name').get();
  return snap.docs.map(d => ({ ...d.data(), id: d.id }));
}

async function fetchExamsForCourse(courseId) {
  const snap = await db.collection('exams')
    .where('courseId', '==', courseId)
    .get();
  const docs = snap.docs.map(d => ({ ...d.data(), id: d.id }));
  docs.sort((a, b) => (b.year || 0) - (a.year || 0));
  return docs;
}

async function fetchExam(examId) {
  const doc = await db.collection('exams').doc(examId).get();
  return doc.exists ? { ...doc.data(), id: doc.id } : null;
}

/**
 * Fetch user data from Firestore.
 * @param {string} uid
 * @param {string} [email]  — now accepted so email is always saved/backfilled
 * @returns {Promise<Object>}
 */
async function fetchUserData(uid, email) {
  const doc = await db.collection('users').doc(uid).get();
  if (doc.exists) {
    const data = doc.data();
    // Backfill email if it was missing — fixes users created before this was added
    if (email && !data.email) {
      const normalizedEmail = email.toLowerCase().trim();
      try {
        await db.collection('users').doc(uid).set({ email: normalizedEmail }, { merge: true });
      } catch(e) { console.warn('fetchUserData: could not backfill email', e); }
      return { ...data, email: normalizedEmail };
    }
    return data;
  }
  // First time — create user doc with email so it is always identifiable in admin
  const defaults = {
    uid,
    email: email ? email.toLowerCase().trim() : null,
    role: 'student',
    starredQuestions: [],
    difficultyVotes: {}
  };
  try {
    await db.collection('users').doc(uid).set(defaults, { merge: true });
  } catch(e) { console.warn('fetchUserData: could not create user doc', e); }
  return defaults;
}

const ALLOWED_USER_FIELDS = [
  'displayName', 'starredQuestions', 'difficultyVotes',
  'acceptedTerms', 'acceptedTermsAt', 'surveyDone',
  'completedExams', 'doneExams', 'inProgressExams',
  'copyCount', 'lastCopyReset', 'createdAt', 'savedCourses', 'aiQuestions'
];

async function saveUserData(uid, data) {
  const safe = {};
  for (const key of ALLOWED_USER_FIELDS) {
    if (key in data) safe[key] = data[key];
  }
  await db.collection('users').doc(uid).set(safe, { merge: true });
}

function genId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
}

/**
 * Check whether a given email is authorized to access the app.
 * Priority:
 *   1. Firestore `authorized_users/{email}` with active:true.
 *   2. Falls back to static PILOT_STUDENTS if Firestore is unreachable.
 *
 * @param {string} email  — raw email, will be normalized internally
 * @returns {Promise<boolean>}
 */
async function isUserAuthorized(email) {
  if (!email) return false;
  const normalized = email.toLowerCase().trim();

  // Dynamic check via Firestore
  try {
    // source:'server' bypasses the local Firestore cache — ensures we always
    // get the latest authorization status, not a stale 'document not found'.
    const doc = await db.collection('authorized_users').doc(normalized).get({ source: 'server' });
    return doc.exists && doc.data()?.active === true;
  } catch (err) {
    console.warn('isUserAuthorized: Firestore unreachable, falling back to static list', err);
    // Offline / rules-error fallback — use the static list
    return (window.PILOT_STUDENTS || []).some(e => e.toLowerCase() === normalized);
  }
}
