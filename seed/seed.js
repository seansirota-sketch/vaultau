/**
 * seed.js — Populate Firebase emulator with mock data
 *
 * Run WHILE the emulator is running:
 *   npm run seed
 *
 * Creates:
 *  - 2 courses
 *  - 10 exams (5 per course) with Hebrew questions
 *  - 3 authorized_users
 *  - 3 users (Firestore)
 *  - 3 Auth accounts (via emulator REST API)
 */

const http = require('http');

const FIRESTORE_HOST = 'localhost';
const FIRESTORE_PORT = 8080;
const AUTH_PORT      = 9099;
const PROJECT_ID     = 'eaxmbank';

// ── Helpers ────────────────────────────────────────────────────────────────

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function toFirestoreValue(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'boolean')          return { booleanValue: val };
  if (typeof val === 'number')           return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  if (typeof val === 'string')           return { stringValue: val };
  if (Array.isArray(val))                return { arrayValue: { values: val.map(toFirestoreValue) } };
  if (typeof val === 'object') {
    const fields = {};
    for (const [k, v] of Object.entries(val)) fields[k] = toFirestoreValue(v);
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function toFirestoreDoc(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = toFirestoreValue(v);
  return { fields };
}

async function setDoc(collection, docId, data) {
  const path = `/v1/projects/${PROJECT_ID}/databases/(default)/documents/${collection}/${docId}`;
  const res = await request({
    hostname: FIRESTORE_HOST,
    port: FIRESTORE_PORT,
    path,
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' }
  }, toFirestoreDoc(data));
  if (res.status >= 400) throw new Error(`Firestore PATCH ${collection}/${docId} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

async function createAuthUser(email, password, displayName) {
  const res = await request({
    hostname: FIRESTORE_HOST,
    port: AUTH_PORT,
    path: `/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { email, password, displayName });
  if (res.status >= 400) throw new Error(`Auth createUser ${email} failed: ${JSON.stringify(res.body)}`);
  const localId = res.body.localId;

  // Mark email as verified in the emulator so seed users can log in
  await request({
    hostname: FIRESTORE_HOST,
    port: AUTH_PORT,
    path: `/identitytoolkit.googleapis.com/v1/accounts:update?key=fake-api-key`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { localId, emailVerified: true });

  return localId;
}

async function clearCollection(collection) {
  const path = `/v1/projects/${PROJECT_ID}/databases/(default)/documents/${collection}`;
  const res = await request({
    hostname: FIRESTORE_HOST,
    port: FIRESTORE_PORT,
    path,
    method: 'GET',
    headers: {}
  });
  if (res.status === 404 || !res.body.documents) return;
  for (const doc of res.body.documents) {
    const docPath = doc.name.replace(`projects/${PROJECT_ID}/databases/(default)/documents/`, '');
    await request({
      hostname: FIRESTORE_HOST,
      port: FIRESTORE_PORT,
      path: `/v1/projects/${PROJECT_ID}/databases/(default)/documents/${docPath}`,
      method: 'DELETE',
      headers: {}
    });
  }
}

async function clearAllAuthUsers() {
  const res = await request({
    hostname: FIRESTORE_HOST,
    port: AUTH_PORT,
    path: `/emulator/v1/projects/${PROJECT_ID}/accounts`,
    method: 'DELETE',
    headers: {}
  });
  if (res.status >= 400) console.warn('Could not clear auth users:', res.status);
}

// ── Seed Data ──────────────────────────────────────────────────────────────

const COURSES = [
  { id: 'calculus',    name: 'חשבון דיפרנציאלי ואינטגרלי', icon: '🧮', status: 'published' },
  { id: 'datastructs', name: 'מבני נתונים ואלגוריתמים',     icon: '💻', status: 'published' },
];

const EXAMS = [
  // ── חשבון דיפרנציאלי ──────────────────────────────────────────────────
  {
    id: 'calc-2023-a-a',
    courseId: 'calculus',
    title: 'חשבון דיפרנציאלי ואינטגרלי — 2023 סמסטר א מועד א',
    year: 2023, semester: 'א', moed: 'א',
    lecturers: ['פרופ\' יצחק שפירא'],
    pdfUrl: null, status: 'published', createdBy: 'admin@admin.com',
    questions: [
      {
        id: 'q1', text: 'חשבו את הנגזרת של הפונקציות הבאות', isBonus: false,
        subs: [
          { id: 'q1a', label: 'א', text: 'f(x) = x³ − 5x² + 3x − 7' },
          { id: 'q1b', label: 'ב', text: 'g(x) = sin(x²) · eˣ' },
          { id: 'q1c', label: 'ג', text: 'h(x) = ln(x² + 1) / x' },
        ]
      },
      {
        id: 'q2', text: 'חשבו את האינטגרלים הבאים', isBonus: false,
        subs: [
          { id: 'q2a', label: 'א', text: '∫(2x³ − 4x + 1)dx' },
          { id: 'q2b', label: 'ב', text: '∫sin(x)·cos(x)dx' },
        ]
      },
      {
        id: 'q3', text: 'מצאו את נקודות הקיצון של f(x) = x⁴ − 8x² + 3 וסווגו אותן', isBonus: false,
        subs: []
      },
    ]
  },
  {
    id: 'calc-2023-a-b',
    courseId: 'calculus',
    title: 'חשבון דיפרנציאלי ואינטגרלי — 2023 סמסטר א מועד ב',
    year: 2023, semester: 'א', moed: 'ב',
    lecturers: ['פרופ\' יצחק שפירא'],
    pdfUrl: null, status: 'published', createdBy: 'admin@admin.com',
    questions: [
      {
        id: 'q1', text: 'חשבו את הגבולות הבאים', isBonus: false,
        subs: [
          { id: 'q1a', label: 'א', text: 'lim(x→0) sin(3x)/x' },
          { id: 'q1b', label: 'ב', text: 'lim(x→∞) (x² + 2x) / (3x² − 1)' },
        ]
      },
      {
        id: 'q2', text: 'השתמשו בכלל לופיטל: lim(x→0) (eˣ − 1 − x) / x²', isBonus: false,
        subs: []
      },
      {
        id: 'q3', text: 'חשבו את האינטגרל המסוים: ∫₀¹ x·eˣ dx', isBonus: false,
        subs: []
      },
      {
        id: 'q4', text: 'בונוס: הוכיחו כי f(x) = x³ חסומה בקטע [0,1]', isBonus: true,
        subs: []
      },
    ]
  },
  {
    id: 'calc-2022-b-a',
    courseId: 'calculus',
    title: 'חשבון דיפרנציאלי ואינטגרלי — 2022 סמסטר ב מועד א',
    year: 2022, semester: 'ב', moed: 'א',
    lecturers: ['ד"ר מיכל לוי'],
    pdfUrl: null, status: 'published', createdBy: 'admin@admin.com',
    questions: [
      {
        id: 'q1', text: 'נתונה f(x) = x² · ln(x) עבור x > 0. מצאו:', isBonus: false,
        subs: [
          { id: 'q1a', label: 'א', text: 'את הנגזרת f\'(x)' },
          { id: 'q1b', label: 'ב', text: 'את נקודות הקיצון' },
          { id: 'q1c', label: 'ג', text: 'את תחומי העלייה והירידה' },
        ]
      },
      {
        id: 'q2', text: 'חשבו בחלקים: ∫ x²·sin(x) dx', isBonus: false,
        subs: []
      },
    ]
  },
  {
    id: 'calc-2022-b-b',
    courseId: 'calculus',
    title: 'חשבון דיפרנציאלי ואינטגרלי — 2022 סמסטר ב מועד ב',
    year: 2022, semester: 'ב', moed: 'ב',
    lecturers: ['ד"ר מיכל לוי'],
    pdfUrl: null, status: 'published', createdBy: 'admin@admin.com',
    questions: [
      {
        id: 'q1', text: 'הוכיחו מהגדרה: lim(x→2) (3x − 1) = 5', isBonus: false,
        subs: []
      },
      {
        id: 'q2', text: 'חשבו את הנגזרות:', isBonus: false,
        subs: [
          { id: 'q2a', label: 'א', text: 'f(x) = arctan(x²)' },
          { id: 'q2b', label: 'ב', text: 'g(x) = √(x³ + 2x)' },
        ]
      },
    ]
  },
  {
    id: 'calc-2021-a-a',
    courseId: 'calculus',
    title: 'חשבון דיפרנציאלי ואינטגרלי — 2021 סמסטר א מועד א',
    year: 2021, semester: 'א', moed: 'א',
    lecturers: ['פרופ\' אהרון כהן'],
    pdfUrl: null, status: 'published', createdBy: 'admin@admin.com',
    questions: [
      {
        id: 'q1', text: 'בדקו רציפות בנקודה x=0:', isBonus: false,
        subs: [
          { id: 'q1a', label: 'א', text: 'f(x) = |x|/x עבור x≠0, f(0)=0' },
          { id: 'q1b', label: 'ב', text: 'g(x) = x·sin(1/x) עבור x≠0, g(0)=0' },
        ]
      },
      {
        id: 'q2', text: 'חשבו: ∫ 1/(x²−1) dx', isBonus: false,
        subs: []
      },
      {
        id: 'q3', text: 'מצאו משוואת המשיק לגרף f(x) = eˣ בנקודה x=0', isBonus: false,
        subs: []
      },
    ]
  },

  // ── מבני נתונים ואלגוריתמים ────────────────────────────────────────────
  {
    id: 'ds-2023-a-a',
    courseId: 'datastructs',
    title: 'מבני נתונים ואלגוריתמים — 2023 סמסטר א מועד א',
    year: 2023, semester: 'א', moed: 'א',
    lecturers: ['פרופ\' דן גלעד'],
    pdfUrl: null, status: 'published', createdBy: 'admin@admin.com',
    questions: [
      {
        id: 'q1', text: 'סיבוכיות:', isBonus: false,
        subs: [
          { id: 'q1a', label: 'א', text: 'מהי סיבוכיות חיפוש בינארי? נמקו.' },
          { id: 'q1b', label: 'ב', text: 'מהי סיבוכיות הזמן הגרוע של מיון בועות?' },
          { id: 'q1c', label: 'ג', text: 'מהי סיבוכיות המרחב של Merge Sort?' },
        ]
      },
      {
        id: 'q2', text: 'BST: הכניסו 5, 3, 7, 1, 4 לעץ ריק ורשמו את סדר In-Order.', isBonus: false,
        subs: []
      },
      {
        id: 'q3', text: 'ממשו תור באמצעות שתי מחסניות. כתבו פסאודו-קוד ל-Enqueue ו-Dequeue.', isBonus: false,
        subs: []
      },
    ]
  },
  {
    id: 'ds-2023-a-b',
    courseId: 'datastructs',
    title: 'מבני נתונים ואלגוריתמים — 2023 סמסטר א מועד ב',
    year: 2023, semester: 'א', moed: 'ב',
    lecturers: ['פרופ\' דן גלעד'],
    pdfUrl: null, status: 'published', createdBy: 'admin@admin.com',
    questions: [
      {
        id: 'q1', text: 'Heap:', isBonus: false,
        subs: [
          { id: 'q1a', label: 'א', text: 'הגדירו Max-Heap. מה תכונת הסדר?' },
          { id: 'q1b', label: 'ב', text: 'מהי סיבוכיות הוצאת המקסימום?' },
        ]
      },
      {
        id: 'q2', text: 'תארו BFS והדגימו על גרף עם 5 צמתים.', isBonus: false,
        subs: []
      },
      {
        id: 'q3', text: 'האם ניתן למיין n מספרים שלמים בסיבוכיות O(n)? תחת אילו תנאים?', isBonus: false,
        subs: []
      },
    ]
  },
  {
    id: 'ds-2022-b-a',
    courseId: 'datastructs',
    title: 'מבני נתונים ואלגוריתמים — 2022 סמסטר ב מועד א',
    year: 2022, semester: 'ב', moed: 'א',
    lecturers: ['ד"ר רונית אבן'],
    pdfUrl: null, status: 'published', createdBy: 'admin@admin.com',
    questions: [
      {
        id: 'q1', text: 'רשימה מקושרת:', isBonus: false,
        subs: [
          { id: 'q1a', label: 'א', text: 'כתבו פסאודו-קוד להיפוך רשימה מקושרת בודדת' },
          { id: 'q1b', label: 'ב', text: 'מהי הסיבוכיות?' },
        ]
      },
      {
        id: 'q2', text: 'טבלת גיבוב: הסבירו את עיקרון הפעולה. תארו שתי שיטות לטיפול בהתנגשות.', isBonus: false,
        subs: []
      },
      {
        id: 'q3', text: 'Memoization: הסבירו את העיקרון ותנו דוגמה.', isBonus: false,
        subs: []
      },
    ]
  },
  {
    id: 'ds-2022-b-b',
    courseId: 'datastructs',
    title: 'מבני נתונים ואלגוריתמים — 2022 סמסטר ב מועד ב',
    year: 2022, semester: 'ב', moed: 'ב',
    lecturers: ['ד"ר רונית אבן'],
    pdfUrl: null, status: 'published', createdBy: 'admin@admin.com',
    questions: [
      {
        id: 'q1', text: 'הוכיחו כי גובה עץ AVL עם n צמתים הוא O(log n)', isBonus: false,
        subs: []
      },
      {
        id: 'q2', text: 'Merge Sort:', isBonus: false,
        subs: [
          { id: 'q2a', label: 'א', text: 'הסבירו את עיקרון האלגוריתם' },
          { id: 'q2b', label: 'ב', text: 'כתבו את נוסחת הנסיגה וחשבו את הסיבוכיות' },
        ]
      },
    ]
  },
  {
    id: 'ds-2021-a-a',
    courseId: 'datastructs',
    title: 'מבני נתונים ואלגוריתמים — 2021 סמסטר א מועד א',
    year: 2021, semester: 'א', moed: 'א',
    lecturers: ['פרופ\' דן גלעד'],
    pdfUrl: null, status: 'published', createdBy: 'admin@admin.com',
    questions: [
      {
        id: 'q1', text: 'השוו בין Stack ל-Queue: מבנה, פעולות ושימושים.', isBonus: false,
        subs: []
      },
      {
        id: 'q2', text: 'אלגוריתם Dijkstra:', isBonus: false,
        subs: [
          { id: 'q2a', label: 'א', text: 'תארו את האלגוריתם בפסאודו-קוד' },
          { id: 'q2b', label: 'ב', text: 'מהי סיבוכיות הזמן? על מה היא תלויה?' },
          { id: 'q2c', label: 'ג', text: 'האם עובד עם קשתות בעלות משקל שלילי?' },
        ]
      },
    ]
  },
];

const USERS_SEED = [
  { email: 'student1@tau.ac.il', password: 'Test1234', displayName: 'סטודנט לדוגמה 1', role: 'student' },
  { email: 'student2@tau.ac.il', password: 'Test1234', displayName: 'סטודנט לדוגמה 2', role: 'student' },
  { email: 'admin@admin.com',    password: 'Test1234', displayName: 'מנהל מערכת',       role: 'admin'   },
];

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('🌱 VaulTau seed script starting...\n');

  // 1. Clear existing data
  console.log('🧹 Clearing existing data...');
  await clearAllAuthUsers();
  for (const col of ['courses', 'exams', 'authorized_users', 'users']) {
    await clearCollection(col);
  }
  console.log('   ✓ Done\n');

  // 2. Courses
  console.log('📚 Creating courses...');
  for (const course of COURSES) {
    const { id, ...data } = course;
    await setDoc('courses', id, data);
    console.log(`   ✓ ${data.name}`);
  }

  // 3. Exams
  console.log('\n📝 Creating exams...');
  for (const exam of EXAMS) {
    const { id, ...data } = exam;
    await setDoc('exams', id, data);
    console.log(`   ✓ ${data.title}`);
  }

  // 4. Auth users + Firestore users + authorized_users
  console.log('\n👤 Creating users...');
  for (const u of USERS_SEED) {
    const uid = await createAuthUser(u.email, u.password, u.displayName);

    await setDoc('users', uid, {
      uid,
      email:            u.email,
      displayName:      u.displayName,
      role:             u.role,
      starredQuestions: [],
      difficultyVotes:  {},
    });

    await setDoc('authorized_users', u.email, {
      email:   u.email,
      active:  true,
      source:  'seed',
      addedAt: new Date().toISOString(),
    });

    console.log(`   ✓ ${u.email} (uid: ${uid})`);
  }

  console.log('\n✅ Seed complete!');
  console.log('   Stop the emulator cleanly (Ctrl+C) to save data to emulator-data/');
  console.log('\n   Login credentials:');
  USERS_SEED.forEach(u => console.log(`   ${u.email} / ${u.password}`));
}

main().catch(err => {
  console.error('\n❌ Seed failed:', err.message);
  console.error('   Make sure the emulator is running: npm run emulator');
  process.exit(1);
});
