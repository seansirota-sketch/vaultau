'use strict';

/**
 * research-stats-refresh — Cloud Function (gen2, Node 20)
 *
 * Trigger  : Pub/Sub topic  "research-stats-trigger"
 * Schedule : Cloud Scheduler → every hour (0 * * * *)
 * Reads    : BigQuery dataset  vaultau_analytics  (tables below)
 * Writes   : Firestore collection  research_stats
 *
 * Firestore document shapes produced:
 *
 *   _meta
 *     lastRefresh   Timestamp
 *     status        "success" | "error"
 *     errorMessage? string
 *     coursesWithData  string[]   course codes that have ≥1 event
 *
 *   daily_{courseCode}_{YYYY-MM-DD}
 *     courseCode          string
 *     date                string  (YYYY-MM-DD)
 *     dau                 number  distinct users active that day
 *     activeStudents      number  same as dau (kept separate for future cohort splits)
 *     examsSolved         number  exam_status_changed → "done" events
 *     questionsFeedbacked number  difficulty_voted events
 *     difficultyVotes     { struggled, abandoned, success }  counts for that day
 *
 *   question_{courseCode}_{examAnalyticsId}_{questionId}
 *     courseCode   string
 *     examId       string  (analytics format: {code}_{year}_{sem}_{moed})
 *     questionId   string  (Q1 … QN)
 *     difficulty   { struggled, abandoned, success }  all-time totals
 *     stars        number  all-time star_toggled → starred=true  count
 *     copies       number  all-time question_copied count
 *
 *   exam_{examAnalyticsId}
 *     examId         string
 *     totalAttempted number  distinct users who opened the exam
 *     totalFinished  number  distinct users who marked it done
 *     questions      Array<{ questionId, difficulty:{struggled,abandoned,success}, stars, copies }>
 *
 * BigQuery views used (all in dataset vaultau_analytics, region europe-west1):
 *   events_safe               — all events; cols include uid_hash, event, courseCode, examId,
 *                               questionId, action_status, difficulty_level, is_starred,
 *                               event_datetime_il (DATETIME)
 *   latest_exam_status        — latest action_status per (uid_hash, examId)
 *                               cols: examId, uid_hash, action_status, courseCode, event_datetime_il
 *   latest_question_difficulty — latest difficulty vote per (uid_hash, questionId)
 *                               cols: questionId, uid_hash, difficulty_level, examId, courseCode,
 *                                     event_datetime_il, difficulty_category
 *   session_activity_pulse    — one row per session; cols: uid_hash, sessionId, courseCode,
 *                               session_start_time, active_actions, unique_exams_touched
 *
 * questionId in views: may be "{examId}_Q{N}" (raw) or already normalised.
 * REGEXP_EXTRACT(questionId, r'(Q\d+)$') is used everywhere — safe for both forms.
 */

const { BigQuery }   = require('@google-cloud/bigquery');
const admin          = require('firebase-admin');

// ── Init ────────────────────────────────────────────────────────────────────

admin.initializeApp();
const firestore = admin.firestore();
const bq        = new BigQuery({ location: 'europe-west1' });

const PROJECT_ID  = process.env.GCP_PROJECT || process.env.GCLOUD_PROJECT || 'eaxmbank';
const BQ_DATASET  = process.env.BQ_DATASET  || 'vaultau_analytics';
const BQ_LOCATION = 'europe-west1'; // dataset region — must match for job routing

// Rolling window for daily metrics (question/exam stats are all-time).
const DAILY_WINDOW_DAYS = 90;

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * Pub/Sub triggered Cloud Function.
 * The message payload is ignored — any message triggers a full refresh.
 */
exports.researchStatsRefresh = async (message, context) => {
  console.log('research-stats-refresh: starting');

  let status = 'success';
  let errorMessage;

  try {
    await runRefresh();
  } catch (err) {
    status = 'error';
    errorMessage = err.message || String(err);
    console.error('research-stats-refresh: fatal error:', err);
  }

  // Always write _meta so the UI can display last-refresh time even after an error.
  await firestore.collection('research_stats').doc('_meta').set(
    {
      lastRefresh:   admin.firestore.FieldValue.serverTimestamp(),
      status,
      ...(errorMessage ? { errorMessage } : { errorMessage: admin.firestore.FieldValue.delete() }),
    },
    { merge: true },
  );

  console.log(`research-stats-refresh: done (${status})`);
};

// ── Core pipeline ───────────────────────────────────────────────────────────

async function runRefresh() {

  // ── 1. Daily metrics (rolling 90-day window) ─────────────────────────────
  const dailyRows = await queryBQ(sqlDailyMetrics());
  const courseCodesWithData = new Set();
  const dailyBatches = chunkArray(dailyRows, 400);

  for (const chunk of dailyBatches) {
    const batch = firestore.batch();
    for (const row of chunk) {
      const code = String(row.courseCode || '').trim();
      if (!code) continue;
      courseCodesWithData.add(code);
      // BigQuery returns DATE columns as BigQueryDate objects — convert to plain string.
      const dateStr = row.date && row.date.value ? row.date.value : String(row.date);
      const docId = `daily_${code}_${dateStr}`;
      batch.set(
        firestore.collection('research_stats').doc(docId),
        {
          courseCode:          code,
          date:                dateStr,
          dau:                 Number(row.dau)                 || 0,
          activeStudents:      Number(row.dau)                 || 0,
          examsSolved:         Number(row.examsSolved)         || 0,
          questionsFeedbacked: Number(row.questionsFeedbacked) || 0,
          difficultyVotes: {
            struggled: Number(row.struggled) || 0,
            abandoned:  Number(row.abandoned)  || 0,
            success:    Number(row.success)    || 0,
          },
        },
        { merge: false }, // full overwrite for idempotency
      );
    }
    await batch.commit();
  }
  console.log(`daily docs: ${dailyRows.length} rows → ${dailyRows.length} docs`);

  // ── 2. Per-question stats (all-time) ──────────────────────────────────────
  const questionRows = await queryBQ(sqlQuestionStats());
  const questionBatches = chunkArray(questionRows, 400);

  for (const chunk of questionBatches) {
    const batch = firestore.batch();
    for (const row of chunk) {
      const code   = String(row.courseCode || '').trim();
      const examId = String(row.examId     || '').trim();
      const qid    = String(row.questionId || '').trim();
      if (!code || !examId || !qid) continue;
      courseCodesWithData.add(code);
      const docId = `question_${code}_${examId}_${qid}`;
      batch.set(
        firestore.collection('research_stats').doc(docId),
        {
          courseCode:  code,
          examId,
          questionId:  qid,
          difficulty: {
            struggled: Number(row.struggled) || 0,
            abandoned:  Number(row.abandoned)  || 0,
            success:    Number(row.success)    || 0,
          },
          stars:  Number(row.stars)  || 0,
          copies: Number(row.copies) || 0,
        },
        { merge: false },
      );
    }
    await batch.commit();
  }
  console.log(`question docs: ${questionRows.length} rows → ${questionRows.length} docs`);

  // ── 3. Exam daily views (popularity by exam_open events) ──────────────────
  const examDayRows = await queryBQ(sqlExamDailyViews());
  const examDayBatches = chunkArray(examDayRows, 400);
  for (const chunk of examDayBatches) {
    const batch = firestore.batch();
    for (const row of chunk) {
      const code   = String(row.courseCode || '').trim();
      const examId = String(row.examId     || '').trim();
      const dateStr = row.date && row.date.value ? row.date.value : String(row.date);
      if (!code || !examId) continue;
      courseCodesWithData.add(code);
      const docId = `examday_${code}_${examId}_${dateStr}`;
      batch.set(
        firestore.collection('research_stats').doc(docId),
        {
          courseCode:     code,
          examId,
          date:           dateStr,
          uniqueViewers:  Number(row.uniqueViewers) || 0,
        },
        { merge: false },
      );
    }
    await batch.commit();
  }
  console.log(`examday docs: ${examDayRows.length} rows`);

  // ── 4. Exam aggregate docs (deep-dive) ────────────────────────────────────
  const examRows    = await queryBQ(sqlExamStats());
  const examQRows   = await queryBQ(sqlExamQuestionList());

  // Group question rows by examId for building the questions[] array.
  const qByExam = {};
  for (const row of examQRows) {
    const examId = String(row.examId || '').trim();
    if (!examId) continue;
    if (!qByExam[examId]) qByExam[examId] = [];
    qByExam[examId].push({
      questionId: String(row.questionId || '').trim(),
      difficulty: {
        struggled: Number(row.struggled) || 0,
        abandoned:  Number(row.abandoned)  || 0,
        success:    Number(row.success)    || 0,
      },
      stars:  Number(row.stars)  || 0,
      copies: Number(row.copies) || 0,
    });
  }

  // Build map of examIds that have status-change data
  const examStatusMap = {};
  for (const row of examRows) {
    const examId = String(row.examId || '').trim();
    if (examId) examStatusMap[examId] = row;
  }

  // Merge: all examIds from question data + all from status data
  const allExamIds = new Set([
    ...Object.keys(examStatusMap),
    ...Object.keys(qByExam),
  ]);

  const allExamRows = Array.from(allExamIds).map(examId => {
    const row = examStatusMap[examId];
    const finished  = row ? Number(row.totalFinished) || 0 : 0;
    return { examId, finished };
  });

  const examBatches = chunkArray(allExamRows, 400);
  for (const chunk of examBatches) {
    const batch = firestore.batch();
    for (const { examId, finished } of chunk) {
      batch.set(
        firestore.collection('research_stats').doc(`exam_${examId}`),
        {
          examId,
          totalFinished:  finished,
          questions:      qByExam[examId] || [],
        },
        { merge: false },
      );
    }
    await batch.commit();
  }
  console.log(`exam docs: ${allExamRows.length} docs (${examRows.length} with status data)`);

  // ── 5. Update _meta ────────────────────────────────────────────────────
  await firestore.collection('research_stats').doc('_meta').set(
    {
      coursesWithData: Array.from(courseCodesWithData).sort(),
      examIdsWithData: Array.from(allExamIds).sort(),
    },
    { merge: true },
  );
}

// ── BigQuery helper ─────────────────────────────────────────────────────────

async function queryBQ(sql) {
  // location must match the dataset region (europe-west1) so the job is routed correctly.
  const [job]  = await bq.createQueryJob({ query: sql, location: BQ_LOCATION });
  const [rows] = await job.getQueryResults();
  return rows;
}

// Fully-qualified view reference helper.
function view(name) {
  return `\`${PROJECT_ID}.${BQ_DATASET}.${name}\``;
}

// ── SQL queries ─────────────────────────────────────────────────────────────

/**
 * Daily active users + exam solves + feedback counts per course per day.
 * Source: events_safe view — rolling 90-day window.
 */
function sqlDailyMetrics() {
  return `
    SELECT
      courseCode,
      DATE(event_datetime_il)                                           AS date,
      COUNT(DISTINCT uid_hash)                                          AS dau,
      COUNTIF(event = 'exam_status_changed' AND action_status = 'done') AS examsSolved,
      COUNTIF(event = 'difficulty_voted')                                              AS questionsFeedbacked,
      COUNTIF(event = 'difficulty_voted' AND difficulty_level = 'hard')                AS struggled,
      COUNTIF(event = 'difficulty_voted' AND difficulty_level = 'unsolved')            AS abandoned,
      COUNTIF(event = 'difficulty_voted' AND difficulty_level IN ('easy', 'medium'))   AS success
    FROM ${view('events_safe')}
    WHERE
      event_datetime_il >= DATETIME_SUB(CURRENT_DATETIME(), INTERVAL ${DAILY_WINDOW_DAYS} DAY)
      AND courseCode IS NOT NULL
    GROUP BY 1, 2
    ORDER BY 1, 2
  `;
}

/**
 * All-time per-question difficulty votes, stars and copies.
 * Difficulty from latest_question_difficulty (deduped per user).
 * Stars + copies from events_safe (raw counts).
 * REGEXP_EXTRACT normalises questionId to Q{N} whether or not the view already did it.
 */
function sqlQuestionStats() {
  return `
    WITH
    difficulty AS (
      SELECT
        courseCode,
        examId,
        REGEXP_EXTRACT(questionId, r'(Q\\d+)$') AS questionId,
        COUNTIF(difficulty_category = 'Struggled') AS struggled,
        COUNTIF(difficulty_category = 'Abandoned')  AS abandoned,
        COUNTIF(difficulty_category = 'Success')    AS success
      FROM ${view('latest_question_difficulty')}
      WHERE courseCode IS NOT NULL AND examId IS NOT NULL AND questionId IS NOT NULL
      GROUP BY 1, 2, 3
    ),
    interactions AS (
      SELECT
        courseCode,
        examId,
        REGEXP_EXTRACT(questionId, r'(Q\\d+)$') AS questionId,
        COUNTIF(event = 'star_toggled'  AND is_starred = 'true') AS stars,
        COUNTIF(event = 'question_copied')                       AS copies
      FROM ${view('events_safe')}
      WHERE event IN ('star_toggled', 'question_copied')
        AND questionId IS NOT NULL AND courseCode IS NOT NULL AND examId IS NOT NULL
      GROUP BY 1, 2, 3
    )
    SELECT
      COALESCE(d.courseCode, i.courseCode) AS courseCode,
      COALESCE(d.examId,     i.examId)     AS examId,
      COALESCE(d.questionId, i.questionId) AS questionId,
      COALESCE(d.struggled, 0) AS struggled,
      COALESCE(d.abandoned, 0) AS abandoned,
      COALESCE(d.success,   0) AS success,
      COALESCE(i.stars,  0)    AS stars,
      COALESCE(i.copies, 0)    AS copies
    FROM difficulty d
    FULL OUTER JOIN interactions i USING (courseCode, examId, questionId)
    WHERE COALESCE(d.questionId, i.questionId) IS NOT NULL
  `;
}

/**
 * Per-exam daily unique viewers — for popularity ranking.
 * Source: events_safe — counts distinct users who opened each exam per day.
 */
function sqlExamDailyViews() {
  return `
    SELECT
      courseCode,
      examId,
      DATE(event_datetime_il) AS date,
      COUNT(DISTINCT uid_hash) AS uniqueViewers
    FROM ${view('events_safe')}
    WHERE event = 'exam_open'
      AND examId IS NOT NULL
    GROUP BY 1, 2, 3
  `;
}

/**
 * Per-exam: distinct users who finished (done).
 * Source: latest_exam_status — already deduped to 1 row per (uid_hash, examId).
 */
function sqlExamStats() {
  return `
    SELECT
      examId,
      COUNT(DISTINCT IF(action_status = 'done', uid_hash, NULL))    AS totalFinished
    FROM ${view('latest_exam_status')}
    WHERE examId IS NOT NULL
    GROUP BY 1
  `;
}

/**
 * Per-exam per-question aggregates — used to build the questions[] array
 * inside each exam_ Firestore document.
 * Same join pattern as sqlQuestionStats but grouped by (examId, questionId) only.
 */
function sqlExamQuestionList() {
  return `
    WITH
    difficulty AS (
      SELECT
        examId,
        REGEXP_EXTRACT(questionId, r'(Q\\d+)$') AS questionId,
        COUNTIF(difficulty_category = 'Struggled') AS struggled,
        COUNTIF(difficulty_category = 'Abandoned')  AS abandoned,
        COUNTIF(difficulty_category = 'Success')    AS success
      FROM ${view('latest_question_difficulty')}
      WHERE examId IS NOT NULL AND questionId IS NOT NULL
      GROUP BY 1, 2
    ),
    interactions AS (
      SELECT
        examId,
        REGEXP_EXTRACT(questionId, r'(Q\\d+)$') AS questionId,
        COUNTIF(event = 'star_toggled'  AND is_starred = 'true') AS stars,
        COUNTIF(event = 'question_copied')                       AS copies
      FROM ${view('events_safe')}
      WHERE event IN ('star_toggled', 'question_copied')
        AND questionId IS NOT NULL AND examId IS NOT NULL
      GROUP BY 1, 2
    )
    SELECT
      COALESCE(d.examId,     i.examId)     AS examId,
      COALESCE(d.questionId, i.questionId) AS questionId,
      COALESCE(d.struggled, 0) AS struggled,
      COALESCE(d.abandoned, 0) AS abandoned,
      COALESCE(d.success,   0) AS success,
      COALESCE(i.stars,  0)    AS stars,
      COALESCE(i.copies, 0)    AS copies
    FROM difficulty d
    FULL OUTER JOIN interactions i USING (examId, questionId)
    WHERE COALESCE(d.questionId, i.questionId) IS NOT NULL
  `;
}

// ── Utility ──────────────────────────────────────────────────────────────────

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
