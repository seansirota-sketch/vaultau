'use strict';

/**
 * research-export — Cloud Function (gen2, Node 20)
 *
 * Trigger  : Pub/Sub topic "research-export-trigger" (Cloud Scheduler, nightly 03:00 IL)
 * Purpose  : OLAP boundary — extract raw research data into BigQuery so
 *            researchers never touch the live OLTP Firestore.
 *
 * Reads    : difficulty_ledger, telemetry_t1, telemetry_t2   (incremental by
 *            watermark stored in settings/export_watermarks)
 * Transforms:
 *   - uid → HMAC-SHA256(uid, RESEARCH_SALT)  — stable pseudonym.
 *     Salt rotation = dataset-wide unlinking (erasure escalation path).
 *   - drops payload keys on a denylist
 *   - Tier-1 and Tier-2 land in SEPARATE tables (boundary survives export)
 *
 * Loads    :
 *   BigQuery dataset `vaultau_research`:
 *     ledger_ratings   partition day(updated_at), cluster (course_id, item_id)
 *     t1_events        partition day(ts), cluster (event)
 *     t2_events        partition day(ts), cluster (event)
 *
 * Emits    : audit_log entry per run (row counts, watermark range, duration)
 *
 * Environment:
 *   RESEARCH_SALT   — HMAC key (secret, never log)
 *   BQ_PROJECT_ID   — GCP project id
 *   BQ_DATASET      — default "vaultau_research"
 *   BQ_LOCATION     — default "europe-west1"
 *
 * Design: docs/architecture-telemetry-difficulty-admin.md §6.2
 */

const crypto = require('crypto');
const admin  = require('firebase-admin');
const { BigQuery } = require('@google-cloud/bigquery');

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const PROJECT_ID  = process.env.BQ_PROJECT_ID || process.env.GCP_PROJECT || process.env.GCLOUD_PROJECT;
const BQ_DATASET  = process.env.BQ_DATASET    || 'vaultau_research';
const BQ_LOCATION = process.env.BQ_LOCATION   || 'europe-west1';
const SALT        = process.env.RESEARCH_SALT || '';

const T1_PAYLOAD_DENYLIST = new Set(['email', 'userId', 'uid', 'ip', 'userAgent']);
const T2_PAYLOAD_DENYLIST = new Set(['email', 'ip', 'phone']);

const WATERMARK_DOC = db.collection('settings').doc('export_watermarks');
const PAGE_SIZE = 500;

const bq = new BigQuery({ location: BQ_LOCATION, projectId: PROJECT_ID });

exports.researchExport = async () => {
  if (!SALT) throw new Error('RESEARCH_SALT env var is required');
  if (!PROJECT_ID) throw new Error('BQ_PROJECT_ID env var is required');

  const startedAt = Date.now();
  const runId     = new Date().toISOString();
  console.log(`research-export: run ${runId} starting`);

  const wmSnap = await WATERMARK_DOC.get();
  const wm     = wmSnap.exists ? wmSnap.data() : {};
  const now    = admin.firestore.Timestamp.now();

  const results = {
    ledger: await exportLedger(wm.ledger, now),
    t1:     await exportTier1(wm.t1,      now),
    t2:     await exportTier2(wm.t2,      now),
  };

  await WATERMARK_DOC.set(
    { ledger: now, t1: now, t2: now, lastRun: now },
    { merge: true },
  );

  await db.collection('audit_log').add({
    actorUid:  'system',
    action:    'export_run',
    target:    `bigquery://${PROJECT_ID}.${BQ_DATASET}`,
    detail:    { runId, results, durationMs: Date.now() - startedAt },
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
    expiresAt: new Date(Date.now() + 400 * 24 * 60 * 60 * 1000),
  });

  console.log(`research-export: done ${JSON.stringify(results)}`);
};

// ── Pseudonymization ─────────────────────────────────────────────────────────

function pseudo(uid) {
  return crypto.createHmac('sha256', SALT).update(String(uid)).digest('hex');
}

function stripDenylist(map, deny) {
  if (!map || typeof map !== 'object') return {};
  const out = {};
  for (const k of Object.keys(map)) {
    if (!deny.has(k)) out[k] = map[k];
  }
  return out;
}

// ── Exporters ────────────────────────────────────────────────────────────────

async function exportLedger(since, until) {
  const rows = [];
  await streamCollection(
    db.collection('difficulty_ledger'), 'updatedAt', since, until,
    (doc) => {
      const d = doc.data();
      rows.push({
        pseudo_uid:  pseudo(d.uid),
        item_id:     d.itemId,
        item_type:   d.itemType,
        exam_id:     d.examId,
        question_id: d.questionId || null,
        course_id:   d.courseId,
        rating:      d.rating,
        prev_rating: d.prevRating == null ? null : d.prevRating,
        created_at:  toBqTs(d.createdAt),
        updated_at:  toBqTs(d.updatedAt),
        context:     d.context ? JSON.stringify(d.context) : null,
      });
    },
  );
  await loadRows('ledger_ratings', rows);
  return { rows: rows.length };
}

async function exportTier1(since, until) {
  const rows = [];
  await streamCollection(
    db.collection('telemetry_t1'), 'timestamp', since, until,
    (doc) => {
      const d = doc.data();
      rows.push({
        event:        d.event,
        item_id:      d.itemId || null,
        course_id:    d.courseId || null,
        session_salt: d.sessionSalt || null,
        ts:           toBqTs(d.timestamp),
        payload:      JSON.stringify(stripDenylist(d.payload, T1_PAYLOAD_DENYLIST)),
      });
    },
  );
  await loadRows('t1_events', rows);
  return { rows: rows.length };
}

async function exportTier2(since, until) {
  const rows = [];
  await streamCollection(
    db.collection('telemetry_t2'), 'timestamp', since, until,
    (doc) => {
      const d = doc.data();
      rows.push({
        pseudo_uid:      pseudo(d.uid),
        consent_version: d.consentVersion || null,
        event:           d.event,
        item_id:         d.itemId || null,
        course_id:       d.courseId || null,
        ts:              toBqTs(d.timestamp),
        payload:         JSON.stringify(stripDenylist(d.payload, T2_PAYLOAD_DENYLIST)),
      });
    },
  );
  await loadRows('t2_events', rows);
  return { rows: rows.length };
}

// ── Streaming reader ─────────────────────────────────────────────────────────

async function streamCollection(col, tsField, since, until, onDoc) {
  let cursor = since || admin.firestore.Timestamp.fromMillis(0);
  while (true) {
    const q = col
      .where(tsField, '>', cursor)
      .where(tsField, '<=', until)
      .orderBy(tsField, 'asc')
      .limit(PAGE_SIZE);
    const snap = await q.get();
    if (snap.empty) return;
    snap.docs.forEach(onDoc);
    cursor = snap.docs[snap.docs.length - 1].data()[tsField];
    if (snap.size < PAGE_SIZE) return;
  }
}

function toBqTs(ts) {
  if (!ts) return null;
  return new Date(ts.toMillis()).toISOString();
}

// ── BigQuery loader ──────────────────────────────────────────────────────────

async function loadRows(table, rows) {
  if (!rows.length) return;
  const ref = bq.dataset(BQ_DATASET).table(table);
  // Streaming inserts. For very large batches, prefer load jobs via GCS Parquet.
  await ref.insert(rows, { ignoreUnknownValues: false, skipInvalidRows: false });
}
