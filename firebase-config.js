/* ============================================================
   firebase-config.js  —  Shared Firebase initialization
   Replace the firebaseConfig values with your project's config.
   Get them from: Firebase Console → Project Settings → Your Apps
   ============================================================ */

const firebaseConfig = {
  apiKey:            "AIzaSyD7pwI3HVY5xUm4Xdk2Tuk9BwG267RT-vI",
  authDomain:        "eaxmbank.firebaseapp.com",
  projectId:         "eaxmbank",
  storageBucket:     "eaxmbank.firebasestorage.app",
  messagingSenderId: "431763916395",
  appId:             "1:431763916395:web:f8d06dba827d5b246b532e",
  measurementId: "G-G4JZL48RNT"
};

/* ── Admin email whitelist ─────────────────────────────────────
   Only these emails can log in to the /admin.html panel.
   Add your admin email(s) here.                               */
const ADMIN_EMAILS = [
  "***REMOVED***"   // ← Replace with your email
];

/* ── Claude backend endpoint ───────────────────────────────────
   Set this to your backend URL that proxies the Claude API.
   e.g. "https://your-backend.com/api/parse-exam"
   Your backend should accept: POST { text: string, isPDF?: bool, base64?: string }
   and return: { questions: [{number, text, parts:[{letter,text}]}] }  */
const CLAUDE_ENDPOINT = "/.netlify/functions/parse-exam";

/* ── Initialize Firebase ─────────────────────────────────────── */
if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

const db   = firebase.firestore();
const auth = firebase.auth();

/* ── Firestore helpers (shared) ─────────────────────────────── */

/**
 * Fetch all courses (sorted by name)
 * @returns {Promise<Array>}
 */
async function fetchCourses() {
  const snap = await db.collection('courses').orderBy('name').get();
  return snap.docs.map(d => ({ ...d.data(), id: d.id }));
}

/**
 * Fetch all exams for a given course
 * @param {string} courseId
 * @returns {Promise<Array>}
 */
async function fetchExamsForCourse(courseId) {
  const snap = await db.collection('exams')
    .where('courseId', '==', courseId)
    .get();
  const docs = snap.docs.map(d => ({ ...d.data(), id: d.id }));
  // Sort client-side so exams without a 'year' field are not silently excluded
  docs.sort((a, b) => (b.year || 0) - (a.year || 0));
  return docs;
}

/**
 * Fetch a single exam by ID
 * @param {string} examId
 * @returns {Promise<Object|null>}
 */
async function fetchExam(examId) {
  const doc = await db.collection('exams').doc(examId).get();
  return doc.exists ? { ...doc.data(), id: doc.id } : null;
}

/**
 * Fetch user data from Firestore (starredQuestions etc.)
 * @param {string} uid
 * @returns {Promise<Object>}
 */
async function fetchUserData(uid) {
  const doc = await db.collection('users').doc(uid).get();
  if (doc.exists) return doc.data();
  // First time — create a minimal user doc so future writes succeed
  const defaults = { uid, starredQuestions: [], difficultyVotes: {} };
  try {
    await db.collection('users').doc(uid).set(defaults, { merge: true });
  } catch(e) { console.warn('fetchUserData: could not create user doc', e); }
  return defaults;
}

/**
 * Save (merge) user data to Firestore
 * @param {string} uid
 * @param {Object} data
 */
async function saveUserData(uid, data) {
  // Always include uid so the doc is self-identifying
  await db.collection('users').doc(uid).set({ uid, ...data }, { merge: true });
}

/* ── UUID ─────────────────────────────────────────────────────── */
function genId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
}
