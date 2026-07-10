'use strict';

/**
 * admin-dashboard-refresh — Cloud Function (gen2, Node 20)
 *
 * Trigger : Pub/Sub topic "admin-dashboard-trigger" (Cloud Scheduler, every 5 min)
 * Reads   : telemetry_t1 (last 1h window), audit_log (last 24h), popularity_stats,
 *           difficulty_aggregates (bounded getAll for top-N)
 * Writes  : admin_dashboard/overview, admin_dashboard/security
 *
 * Design: docs/architecture-telemetry-difficulty-admin.md §2.8, §6.1
 */

const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS  = 24 * HOUR_MS;

exports.adminDashboardRefresh = async () => {
  const startedAt = Date.now();
  console.log('admin-dashboard-refresh: starting');

  const now     = admin.firestore.Timestamp.now();
  const hourAgo = admin.firestore.Timestamp.fromMillis(now.toMillis() - HOUR_MS);
  const dayAgo  = admin.firestore.Timestamp.fromMillis(now.toMillis() - DAY_MS);

  // ── Overview ────────────────────────────────────────────────────────────
  const [t1Snap, popSnap, usersAgg] = await Promise.all([
    db.collection('telemetry_t1').where('timestamp', '>', hourAgo).get(),
    db.collection('popularity_stats').orderBy('popularityScore', 'desc').limit(50).get(),
    db.collection('users').count().get(),
  ]);

  const activeSessions = new Set();
  const eventsPerMin   = {};
  for (const d of t1Snap.docs) {
    const e = d.data();
    if (e.sessionSalt) activeSessions.add(e.sessionSalt);
    const minute = Math.floor(e.timestamp.toMillis() / 60000);
    eventsPerMin[minute] = (eventsPerMin[minute] || 0) + 1;
  }
  const perMinValues = Object.values(eventsPerMin);
  const eventsPerMinAvg = perMinValues.length
    ? Math.round(perMinValues.reduce((a, b) => a + b, 0) / perMinValues.length)
    : 0;

  const topExams = popSnap.docs.map((d) => {
    const p = d.data();
    return {
      itemId:          p.itemId,
      itemType:        p.itemType,
      courseId:        p.courseId,
      popularityScore: p.popularityScore || 0,
      views7d:         p.views7d || 0,
    };
  });

  const topProblematic = [];
  const aggRefs = topExams.slice(0, 25).map((x) => db.collection('difficulty_aggregates').doc(x.itemId));
  if (aggRefs.length) {
    const aggs = await db.getAll(...aggRefs);
    for (let i = 0; i < aggs.length; i += 1) {
      const a = aggs[i].exists ? aggs[i].data() : null;
      if (!a) continue;
      const diff = a.bayesianAverage || 0;
      const pop  = topExams[i].popularityScore;
      if (diff >= 4.2 && pop > 0) {
        topProblematic.push({
          itemId:          topExams[i].itemId,
          courseId:        topExams[i].courseId,
          bayesianAverage: diff,
          voteCount:       a.voteCount || 0,
          popularityScore: pop,
          problemScore:    Math.round(diff * pop * 100) / 100,
        });
      }
    }
    topProblematic.sort((a, b) => b.problemScore - a.problemScore);
  }

  const consentedAgg = await db.collection('users').where('analyticsConsent', '==', true).count().get();
  const t2OptInCount    = consentedAgg.data().count;
  const totalUserCount  = usersAgg.data().count;
  const consentGrantRate = totalUserCount ? t2OptInCount / totalUserCount : 0;

  await db.collection('admin_dashboard').doc('overview').set(
    {
      generatedAt: admin.firestore.FieldValue.serverTimestamp(),
      window:      '1h',
      metrics: {
        activeSessions:   activeSessions.size,
        eventsPerMinAvg,
        totalUserCount,
        t2OptInCount,
        consentGrantRate: Math.round(consentGrantRate * 10000) / 10000,
        topExams:         topExams.slice(0, 20),
        topProblematic:   topProblematic.slice(0, 10),
        anomalies:        [],
      },
    },
    { merge: false },
  );

  // ── Security ────────────────────────────────────────────────────────────
  const auditSnap = await db.collection('audit_log').where('timestamp', '>', dayAgo).get();
  const byAction = {};
  const consentEvents = [];
  const roleChanges   = [];
  const deniedT2      = [];
  for (const d of auditSnap.docs) {
    const a = d.data();
    byAction[a.action] = (byAction[a.action] || 0) + 1;
    if (a.action === 'consent_grant' || a.action === 'consent_revoke') {
      consentEvents.push({ actorUid: a.actorUid, action: a.action, at: a.timestamp });
    }
    if (a.action === 'role_change') roleChanges.push(a);
    if (a.action === 'rule_denied_t2_write') deniedT2.push(a);
  }

  await db.collection('admin_dashboard').doc('security').set(
    {
      generatedAt: admin.firestore.FieldValue.serverTimestamp(),
      window:      '24h',
      metrics: {
        auditEventsByAction: byAction,
        consentEventsRecent: consentEvents.slice(-50),
        roleChangesRecent:   roleChanges.slice(-20),
        deniedT2WriteCount:  deniedT2.length,
      },
    },
    { merge: false },
  );

  console.log(`admin-dashboard-refresh: done in ${Date.now() - startedAt}ms`);
};
