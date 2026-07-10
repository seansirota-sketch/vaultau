'use strict';

/**
 * aggregate-reconcile — Cloud Function (gen2, Node 20)
 *
 * Trigger : Pub/Sub topic "aggregate-reconcile-trigger" (Cloud Scheduler, nightly)
 * Purpose : Full-scan reconcile of difficulty_aggregates from
 *           difficulty_ledger, to heal any drift caused by missed onWrite
 *           trigger deliveries. Complementary to on-ledger-write §3.1.
 *
 * Design: docs/architecture-telemetry-difficulty-admin.md §3.1 step 6
 *
 * Strategy:
 *   1. Sweep the ledger in pages, group by itemId in memory.
 *   2. Compute canonical count/sum/hist/average/bayes per item.
 *   3. Upsert into difficulty_aggregates/{itemId}  (merge: true preserves
 *      lastLedgerEventIds ring so the live trigger still dedupes).
 */

const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const BAYES_C = 10;
const BAYES_M = 3.0;
const PAGE_SIZE = 500;

exports.aggregateReconcile = async () => {
  const startedAt = Date.now();
  console.log('aggregate-reconcile: starting');

  const perItem = new Map();
  let cursor = null;
  let scanned = 0;

  while (true) {
    let q = db.collection('difficulty_ledger').orderBy('__name__').limit(PAGE_SIZE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      const d = doc.data();
      if (!d.itemId) continue;
      if (!perItem.has(d.itemId)) {
        perItem.set(d.itemId, {
          itemId:     d.itemId,
          itemType:   d.itemType   || null,
          examId:     d.examId     || null,
          questionId: d.questionId || null,
          courseId:   d.courseId   || null,
          count:      0,
          sum:        0,
          hist:       { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },
        });
      }
      const b = perItem.get(d.itemId);
      const r = Number(d.rating) || 0;
      if (r < 1 || r > 5) continue;
      b.count += 1;
      b.sum   += r;
      b.hist[String(r)] += 1;
    }

    scanned += snap.size;
    if (snap.size < PAGE_SIZE) break;
    cursor = snap.docs[snap.docs.length - 1];
  }

  const items = Array.from(perItem.values());
  console.log(`aggregate-reconcile: scanned ${scanned} ledger docs → ${items.length} items`);

  const chunks = chunk(items, 400);
  let written = 0;
  for (const c of chunks) {
    const batch = db.batch();
    for (const b of c) {
      const average         = b.count > 0 ? Math.round((b.sum / b.count) * 100) / 100 : 0;
      const bayesianAverage = Math.round(
        ((BAYES_C * BAYES_M + b.sum) / (BAYES_C + b.count)) * 100,
      ) / 100;
      batch.set(
        db.collection('difficulty_aggregates').doc(b.itemId),
        {
          itemId:             b.itemId,
          itemType:           b.itemType,
          examId:             b.examId,
          questionId:         b.questionId,
          courseId:           b.courseId,
          voteCount:          b.count,
          ratingSum:          b.sum,
          average,
          bayesianAverage,
          histogram:          b.hist,
          minVotesForDisplay: 3,
          updatedAt:          admin.firestore.FieldValue.serverTimestamp(),
          reconciledAt:       admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      written += 1;
    }
    await batch.commit();
  }

  console.log(`aggregate-reconcile: done in ${Date.now() - startedAt}ms, wrote ${written} aggregates`);
};

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
