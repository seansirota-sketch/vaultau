'use strict';

/**
 * backfill-difficulty-aggregates.js
 *
 * One-shot migration: seed difficulty_aggregates from the legacy
 * questionVotes numeric fields (voteCount, ratingSum, averageRating,
 * plus the legacy bucket fields easy/medium/hard/unsolved when present).
 *
 * Design: docs/architecture-telemetry-difficulty-admin.md §7 step 5
 *         ("Migration: backfill difficulty_aggregates from legacy
 *          questionVotes; freeze legacy writes after cutover")
 *
 * Prerequisites:
 *   - GOOGLE_APPLICATION_CREDENTIALS pointing to a service-account key
 *     with Firestore admin, OR run inside a Firebase Admin environment
 *     (e.g. Cloud Shell) already authenticated.
 *   - The `firebase-admin` package must be installed at the repo root
 *     (already declared in package.json).
 *
 * Usage:
 *   node seed/backfill-difficulty-aggregates.js               # dry-run
 *   node seed/backfill-difficulty-aggregates.js --write       # actually write
 *   node seed/backfill-difficulty-aggregates.js --write --limit 500
 *
 * Notes:
 *   - The migration writes a `migratedFromQuestionVotes: true` flag on
 *     each destination doc so it can be filtered out later.
 *   - It does NOT delete the source questionVotes docs; freeze the
 *     legacy write path separately after cutover verification.
 *   - questionId in the legacy collection maps to the new namespaced
 *     itemId as "q:{questionId}"  (examId is unknown from the legacy
 *     shape; researchers/aggregate-reconcile will backfill examId once
 *     new ledger writes start flowing).
 */

const admin = require('firebase-admin');

const WRITE = process.argv.includes('--write');
const limitIx = process.argv.indexOf('--limit');
const LIMIT = limitIx >= 0 ? Number(process.argv[limitIx + 1]) : Infinity;

const BAYES_C = 10;
const BAYES_M = 3.0;

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

async function main() {
  console.log(`backfill-difficulty-aggregates: ${WRITE ? 'WRITE' : 'DRY-RUN'} mode, limit=${LIMIT}`);

  let processed = 0;
  let written   = 0;
  let skipped   = 0;
  let cursor    = null;

  while (processed < LIMIT) {
    let q = db.collection('questionVotes').orderBy('__name__').limit(200);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) break;

    const batch = WRITE ? db.batch() : null;
    for (const doc of snap.docs) {
      if (processed >= LIMIT) break;
      processed += 1;
      const src = doc.data();
      const questionId = doc.id;

      // Prefer new numeric shape; fall back to legacy buckets.
      let voteCount = Number(src.voteCount) || 0;
      let ratingSum = Number(src.ratingSum) || 0;

      if (!voteCount && (src.easy || src.medium || src.hard || src.unsolved)) {
        // Legacy bucket → coarse rating mapping: easy=1, medium=3, hard=4, unsolved=5.
        const buckets = {
          1: Number(src.easy)     || 0,
          3: Number(src.medium)   || 0,
          4: Number(src.hard)     || 0,
          5: Number(src.unsolved) || 0,
        };
        voteCount = Object.values(buckets).reduce((a, b) => a + b, 0);
        ratingSum = Object.entries(buckets).reduce((s, [k, v]) => s + Number(k) * v, 0);
      }

      if (voteCount === 0) { skipped += 1; continue; }

      const average         = Math.round((ratingSum / voteCount) * 100) / 100;
      const bayesianAverage = Math.round(
        ((BAYES_C * BAYES_M + ratingSum) / (BAYES_C + voteCount)) * 100,
      ) / 100;

      const itemId = `q:${questionId}`;
      const target = db.collection('difficulty_aggregates').doc(itemId);
      const doc2 = {
        itemId,
        itemType:   'question',
        examId:     null,       // unknown from legacy shape
        questionId,
        courseId:   null,
        voteCount,
        ratingSum,
        average,
        bayesianAverage,
        histogram: {            // coarse — legacy scale isn't 1..5 uniformly
          '1': Number(src.easy)     || 0,
          '2': 0,
          '3': Number(src.medium)   || 0,
          '4': Number(src.hard)     || 0,
          '5': Number(src.unsolved) || 0,
        },
        minVotesForDisplay:       3,
        migratedFromQuestionVotes: true,
        migratedAt:                admin.firestore.FieldValue.serverTimestamp(),
        updatedAt:                 admin.firestore.FieldValue.serverTimestamp(),
      };

      if (WRITE) batch.set(target, doc2, { merge: true });
      written += 1;
    }
    if (WRITE) await batch.commit();

    cursor = snap.docs[snap.docs.length - 1];
    if (snap.size < 200) break;
  }

  console.log(`backfill: processed=${processed} written=${written} skipped=${skipped}`);
  if (!WRITE) console.log('(dry-run — re-run with --write to apply)');
}

main().catch((err) => {
  console.error('backfill failed:', err);
  process.exit(1);
});
