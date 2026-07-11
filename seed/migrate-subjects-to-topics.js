/**
 * migrate-subjects-to-topics.js
 *
 * One-off backfill: scan each course's exams, collect the distinct legacy
 * `subject`/`topic` strings from questions and clauses, and create draft
 * topic documents under courses/{courseId}/topics/{slug}.
 *
 * It does NOT create any topic_assignments — the AI pipeline
 * (/api/categorize-question via the admin UI) is the assignment backfill.
 * Admins curate / merge the draft topics afterwards.
 *
 * Usage (emulator):
 *   FIRESTORE_EMULATOR_HOST=localhost:8080 node seed/migrate-subjects-to-topics.js         # dry-run
 *   FIRESTORE_EMULATOR_HOST=localhost:8080 node seed/migrate-subjects-to-topics.js --apply  # write
 *
 * Usage (production): set FIREBASE_SERVICE_ACCOUNT to a service-account JSON string.
 */

const admin = require('firebase-admin');

const APPLY = process.argv.includes('--apply');
const PROJECT_ID = process.env.GCLOUD_PROJECT || 'eaxmbank';

function init() {
  if (admin.apps.length) return;
  if (process.env.FIRESTORE_EMULATOR_HOST) {
    admin.initializeApp({ projectId: PROJECT_ID });
    return;
  }
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!sa) {
    console.error('Set FIRESTORE_EMULATOR_HOST (emulator) or FIREBASE_SERVICE_ACCOUNT (prod).');
    process.exit(1);
  }
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(sa)) });
}

function slugify(name) {
  return String(name || '').trim().toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

function collectSubjects(questions) {
  const set = new Set();
  (questions || []).forEach(q => {
    const s = String(q.subject || q.topic || '').trim();
    if (s) set.add(s);
    const clauses = Array.isArray(q.subs) ? q.subs : (Array.isArray(q.parts) ? q.parts : []);
    clauses.forEach(c => {
      const cs = String(c.subject || c.topic || '').trim();
      if (cs) set.add(cs);
    });
  });
  return set;
}

async function main() {
  init();
  const db = admin.firestore();
  const FieldValue = admin.firestore.FieldValue;

  const coursesSnap = await db.collection('courses').get();
  let totalDrafts = 0;

  for (const courseDoc of coursesSnap.docs) {
    const courseId = courseDoc.id;
    const examsSnap = await db.collection('exams').where('courseId', '==', courseId).get();

    const subjects = new Set();
    examsSnap.forEach(e => collectSubjects(e.data().questions).forEach(s => subjects.add(s)));
    if (!subjects.size) continue;

    // Skip slugs that already exist as topics (don't clobber curated topics).
    const existing = new Set((await courseDoc.ref.collection('topics').get()).docs.map(d => d.id));

    const toCreate = [];
    let order = 1000;
    for (const name of subjects) {
      const id = slugify(name) || `topic-${order}`;
      if (existing.has(id)) continue;
      toCreate.push({ id, name, order: order++ });
    }

    console.log(`\n[${courseId}] ${subjects.size} distinct subjects → ${toCreate.length} new draft topics`);
    toCreate.forEach(t => console.log(`   ${APPLY ? '＋' : '·'} ${t.id}  ("${t.name}")`));

    if (APPLY) {
      for (const t of toCreate) {
        await courseDoc.ref.collection('topics').doc(t.id).set({
          name: t.name, description: '', order: t.order,
          status: 'draft', createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
    }
    totalDrafts += toCreate.length;
  }

  console.log(`\n${APPLY ? 'Wrote' : 'Would write'} ${totalDrafts} draft topics.`);
  if (!APPLY) console.log('Re-run with --apply to write.');
}

main().catch(err => { console.error('Migration failed:', err); process.exit(1); });
