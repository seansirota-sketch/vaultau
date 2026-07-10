'use strict';

/**
 * popularity-rollup — Cloud Function (gen2, Node 20)
 *
 * Trigger  : Pub/Sub topic "popularity-rollup-trigger" (Cloud Scheduler, every 15 min)
 * Reads    : telemetry_t1 (since watermark), difficulty_ledger (write velocity)
 * Writes   : popularity_stats/{itemId}
 * Watermark: settings/rollup_watermarks.popularity  (admin-only doc — writable
 *            only by this function via Admin SDK)
 *
 * Design: docs/architecture-telemetry-difficulty-admin.md §2.7, §6.3
 *
 * popularityScore = Σ w_e * exp(-λ * ageDays)
 *   weights : view=1, bookmark=3, attempt=5, vote=2
 *   half-life 7 days   → λ = ln(2)/7
 *
 * Tier-1 only — popularity never needs identity. sessionSalt is used for
 * approximate-distinct via a Set (adequate at platform scale; swap to
 * HyperLogLog if the salt set exceeds a few hundred thousand).
 */

const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const WEIGHTS = { view: 1, bookmark: 3, attempt: 5, vote: 2 };
const LAMBDA  = Math.log(2) / 7;

const T1_EVENT_MAP = {
  exam_open:      'view',
  question_view:  'view',
  bookmark_add:   'bookmark',
  attempt_start:  'attempt',
};

const WATERMARK_DOC = db.collection('settings').doc('rollup_watermarks');

exports.popularityRollup = async () => {
  const startedAt = Date.now();
  console.log('popularity-rollup: starting');

  const wmSnap = await WATERMARK_DOC.get();
  const wm     = wmSnap.exists ? wmSnap.data() : {};
  const sinceMs = wm.popularity ? wm.popularity.toMillis() : (Date.now() - 24 * 60 * 60 * 1000);
  const since   = admin.firestore.Timestamp.fromMillis(sinceMs);
  const now     = admin.firestore.Timestamp.now();
  const nowMs   = now.toMillis();

  const perItem = new Map();
  const ensure = (itemId, meta) => {
    if (!perItem.has(itemId)) {
      perItem.set(itemId, {
        meta,
        views: 0, bookmarks: 0, attempts: 0, votes: 0,
        sessions: new Set(),
        weightedScore: 0,
      });
    }
    return perItem.get(itemId);
  };
  const addWeighted = (bucket, kind, tsMs) => {
    const ageDays = Math.max(0, (nowMs - tsMs) / 86400000);
    bucket.weightedScore += WEIGHTS[kind] * Math.exp(-LAMBDA * ageDays);
  };

  const t1Snap = await db.collection('telemetry_t1')
    .where('timestamp', '>', since)
    .where('timestamp', '<=', now)
    .get();

  for (const doc of t1Snap.docs) {
    const d = doc.data();
    if (!d.itemId) continue;
    const kind = T1_EVENT_MAP[d.event];
    if (!kind) continue;
    const meta = {
      itemType: d.itemId.startsWith('exam:') ? 'exam' : 'question',
      examId:   (d.payload && d.payload.examId) || null,
      courseId: d.courseId || null,
    };
    const b = ensure(d.itemId, meta);
    const tsMs = d.timestamp.toMillis();
    if (kind === 'view')     b.views     += 1;
    if (kind === 'bookmark') b.bookmarks += 1;
    if (kind === 'attempt')  b.attempts  += 1;
    if (d.sessionSalt) b.sessions.add(d.sessionSalt);
    addWeighted(b, kind, tsMs);
  }

  const ledgerSnap = await db.collection('difficulty_ledger')
    .where('updatedAt', '>', since)
    .where('updatedAt', '<=', now)
    .get();

  for (const doc of ledgerSnap.docs) {
    const d = doc.data();
    if (!d.itemId) continue;
    const meta = {
      itemType: d.itemType || (d.itemId.startsWith('exam:') ? 'exam' : 'question'),
      examId:   d.examId   || null,
      courseId: d.courseId || null,
    };
    const b = ensure(d.itemId, meta);
    b.votes += 1;
    addWeighted(b, 'vote', d.updatedAt.toMillis());
  }

  const itemIds = Array.from(perItem.keys());
  const chunks  = chunk(itemIds, 400);
  let written   = 0;

  for (const c of chunks) {
    const refs = c.map((id) => db.collection('popularity_stats').doc(id));
    const cur  = await db.getAll(...refs);
    const batch = db.batch();

    for (let i = 0; i < c.length; i += 1) {
      const itemId = c[i];
      const acc    = perItem.get(itemId);
      const prev   = cur[i].exists ? cur[i].data() : null;

      let carriedScore = 0;
      if (prev && prev.popularityScore && prev.updatedAt) {
        const ageDays = (nowMs - prev.updatedAt.toMillis()) / 86400000;
        carriedScore = prev.popularityScore * Math.exp(-LAMBDA * ageDays);
      }

      const doc = {
        itemId,
        ...acc.meta,
        viewsTotal:     (prev && prev.viewsTotal    ? prev.viewsTotal    : 0) + acc.views,
        bookmarks:      (prev && prev.bookmarks     ? prev.bookmarks     : 0) + acc.bookmarks,
        attemptsTotal:  (prev && prev.attemptsTotal ? prev.attemptsTotal : 0) + acc.attempts,
        difficultyVotes7d: acc.votes,
        uniqueSessions7d:  acc.sessions.size,
        views7d:           acc.views,
        views30d:          acc.views,
        popularityScore:   Math.round((carriedScore + acc.weightedScore) * 1000) / 1000,
        updatedAt:         admin.firestore.FieldValue.serverTimestamp(),
      };
      batch.set(cur[i].ref, doc, { merge: true });
      written += 1;
    }
    await batch.commit();
  }

  await WATERMARK_DOC.set({ popularity: now }, { merge: true });

  console.log(`popularity-rollup: done in ${Date.now() - startedAt}ms, `
    + `t1=${t1Snap.size} ledger=${ledgerSnap.size} items=${written}`);
};

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
