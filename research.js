/* ============================================================
   ACADEMIC RESEARCH PANEL — research.js
   Requires: firebase-config.js, Chart.js, MathJax (loaded in HTML)
   ============================================================ */

'use strict';

/* ── UTILS (self-contained, no dependency on course.js) ──── */

/** HTML entity-encode a value to prevent XSS. */
function esc(s) {
  if (!s && s !== 0) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Validate URL — only allow https:// or http://. */
function safeUrl(u) {
  if (!u) return '';
  try {
    const p = new URL(u);
    return ['https:', 'http:'].includes(p.protocol) ? esc(u) : '';
  } catch { return ''; }
}

function nl2br(html) {
  if (!html) return '';
  return html.replace(/\n/g, '<br>');
}

/**
 * Renders question/sub-question text with LaTeX and inline images.
 * Output is trusted HTML — internally uses esc() and safeUrl().
 */
function formatMathText(text, inlineImages = null) {
  if (!text) return '';
  const DISPLAY_RE = /(\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\])/g;
  const parts = text.split(DISPLAY_RE);
  return parts.map(part => {
    if (part.startsWith('$$') || part.startsWith('\\[')) {
      const safe = part.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      return `<div class="math-display">${safe}</div>`;
    }
    let trimmed = part.replace(/^\s*\n/, '').replace(/\n\s*$/, '');
    if (!trimmed) return '';
    trimmed = trimmed.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, rawRef) => {
      const ref = String(rawRef || '').trim();
      let resolved = '';
      if (ref.startsWith('img:')) {
        const key = ref.slice(4);
        const map = inlineImages && typeof inlineImages === 'object' ? inlineImages : {};
        resolved = String(map[key] || '').trim();
      } else {
        resolved = ref;
      }
      const safe = safeUrl(resolved);
      if (!safe) return '';
      return `<div class="qv-inline-image align-center"><img class="qv-image" src="${safe}" alt="${esc(alt || 'image')}" loading="lazy" referrerpolicy="no-referrer"></div>`;
    });
    trimmed = trimmed.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    trimmed = trimmed.replace(/(\$[^$]+?\$)/g, m => m.replace(/&/g, '&amp;').replace(/</g, '&lt;'));
    return nl2br(trimmed);
  }).join('');
}

/** Show a brief toast notification. */
function rpToast(msg, type = '') {
  const wrap = document.getElementById('rp-toast-wrap');
  if (!wrap) return;
  const t = document.createElement('div');
  t.className = 'rp-toast' + (type ? ' ' + type : '');
  t.textContent = msg;
  wrap.appendChild(t);
  setTimeout(() => t.remove(), 2800);
}

/** Format a date as YYYY-MM-DD. */
function toDateStr(d) {
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toISOString().slice(0, 10);
}

/** Return today's date as YYYY-MM-DD (Asia/Jerusalem, falls back to local). */
function todayStr() {
  try {
    return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Jerusalem' }).format(new Date());
  } catch {
    return toDateStr(new Date());
  }
}

/** Return a Date N days ago. */
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

/* ── DIFFICULTY COLOUR PALETTE ───────────────────────────── */
const DIFF_COLORS = {
  struggled: '#c8860a',  // orange
  abandoned:  '#b91c1c', // red
  success:    '#1a7c45', // green
};

/* ── ID MAPPING: analytics ↔ Firestore ──────────────────── */
const SEMESTER_MAP = { A: 'א', B: 'ב', C: 'קיץ' };
const MOED_MAP     = { A: 'א', B: 'ב', C: 'ג' };

/**
 * Human-readable label for a question, e.g. "2022 סמ' ב / מועד א — שאלה 1"
 */
function formatExamLabel(examId, questionId) {
  const parsed = parseAnalyticsExamId(examId);
  if (!parsed) return `${esc(examId)} / ${esc(questionId)}`;
  const qNum = parseInt((questionId || '').replace(/\D/g, ''), 10);
  const qLabel = isNaN(qNum) ? esc(questionId) : `שאלה ${qNum}`;
  return `${parsed.year} סמ' ${parsed.semester} / מועד ${parsed.moed} — ${qLabel}`;
}

/**
 * Parse an analytics examId (e.g. "05091724_2024_B_B") into its parts
 * and return the Hebrew field values needed to query Firestore.
 */
function parseAnalyticsExamId(examAnalyticsId) {
  // Format: {courseCode}_{year}_{semesterLetter}_{moedLetter}
  const parts = examAnalyticsId.split('_');
  if (parts.length < 4) return null;
  // courseCode may itself contain underscores if it's numeric — safe to take last 3 as fixed fields
  const moedLetter     = parts[parts.length - 1];
  const semesterLetter = parts[parts.length - 2];
  const year           = parseInt(parts[parts.length - 3], 10);
  const courseCode     = parts.slice(0, parts.length - 3).join('_');
  return {
    courseCode,
    year,
    semester: SEMESTER_MAP[semesterLetter.toUpperCase()] || semesterLetter,
    moed:     MOED_MAP[moedLetter.toUpperCase()] || moedLetter,
  };
}

/* ── MODULE STATE ────────────────────────────────────────── */
const STATE = {
  user: null,
  role: null,
  currentCourseCode: null,
  currentCourseFirestoreId: null,  // Firestore UUID for the selected course
  coursesWithData: [],
  examIdsWithData: [],       // all examIds that have any analytics data
  allDailyDocs: [],          // all daily_* docs loaded for current course
  allQuestionDocs: [],       // all question_* docs for current course
  currentExamAnalyticsId: null,
  currentExamDoc: null,      // research_stats exam doc
  activeTab: 'overview',
  dateFrom: null,            // Date object
  dateTo:   null,            // Date object
  // Chart.js instances (kept for destroy on redraw)
  overviewDonutChart: null,
  questionCardCharts: [],  // one Chart.js instance per question card
  drawerDonutChart: null,
  // Small in-memory cache: courseCode → Firestore UUID
  courseUuidCache: {},
};

/* ── FIRESTORE REFERENCE ─────────────────────────────────── */
// db is declared globally in firebase-config.js — do not redeclare.

/* ═══════════════════════════════════════════════════════════
   AUTH
═══════════════════════════════════════════════════════════ */
firebase.auth().onAuthStateChanged(async user => {
  if (!user) {
    showAuthWall();
    return;
  }
  try {
    const snap = await db.collection('users').doc(user.uid).get();
    const role = snap.exists ? snap.data().role : null;
    if (role !== 'admin' && role !== 'instructor') {
      showAuthWall();
      return;
    }
    STATE.user = user;
    STATE.role = role;
    renderUserBadge(user, role);
    showApp();
    await initPanel();
  } catch (err) {
    console.error('Auth check failed:', err);
    showAuthWall();
  }
});

function showAuthWall() {
  document.getElementById('rp-auth-wall').style.display = 'flex';
  document.getElementById('rp-app').style.display = 'none';
}

function showApp() {
  document.getElementById('rp-auth-wall').style.display = 'none';
  document.getElementById('rp-app').style.display = 'flex';
}

function renderUserBadge(user, role) {
  const name = esc(user.displayName || user.email || '');
  const initial = (user.displayName || user.email || '?')[0].toUpperCase();
  document.getElementById('rp-user-avatar').textContent = esc(initial);
  document.getElementById('rp-user-name').textContent = name;
  document.getElementById('rp-role-badge').textContent = role === 'admin' ? 'Admin' : 'מרצה';
}

/* ═══════════════════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════════════════ */
async function initPanel() {
  // Set default date range: last 30 days
  STATE.dateTo   = new Date();
  STATE.dateFrom = daysAgo(30);

  await loadCourseDropdown();

  // Close custom popover on outside click
  document.addEventListener('click', e => {
    const pop = document.getElementById('rp-custom-popover');
    const btn = document.getElementById('rp-custom-btn');
    if (pop.classList.contains('open') && !pop.contains(e.target) && e.target !== btn) {
      rpCloseCustom();
    }
  });

  // Keyboard: Escape closes drawer or popover
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (document.getElementById('rp-drawer').classList.contains('open')) {
        rpCloseDrawer();
      } else {
        rpCloseCustom();
      }
    }
  });
}

/* ═══════════════════════════════════════════════════════════
   COURSE DROPDOWN
═══════════════════════════════════════════════════════════ */
async function loadCourseDropdown() {
  const select = document.getElementById('rp-course-select');
  select.innerHTML = '<option value="">-- בחר קורס --</option>';

  try {
    const [coursesSnap, metaSnap] = await Promise.all([
      db.collection('courses').orderBy('name').get(),
      db.collection('research_stats').doc('_meta').get(),
    ]);

    const metaData = metaSnap.exists ? metaSnap.data() : {};
    const coursesWithData = metaData.coursesWithData || [];
    STATE.coursesWithData  = coursesWithData;
    STATE.examIdsWithData  = metaData.examIdsWithData || [];

    if (metaSnap.exists && metaSnap.data().lastRefresh) {
      const ts = metaSnap.data().lastRefresh.toDate
        ? metaSnap.data().lastRefresh.toDate()
        : new Date(metaSnap.data().lastRefresh);
      document.getElementById('rp-last-refresh').textContent =
        'עדכון אחרון: ' + ts.toLocaleString('he-IL');
    }

    coursesSnap.forEach(doc => {
      const d = doc.data();
      const hasData = coursesWithData.includes(d.code);
      const opt = document.createElement('option');
      opt.value = esc(d.code || doc.id);
      // Store the Firestore doc ID in a data attribute for later exam queries
      opt.dataset.firestoreId = doc.id;
      opt.disabled = !hasData;
      opt.textContent = (d.icon ? d.icon + ' ' : '') + (d.name || '') + (!hasData ? ' (אין נתונים)' : '');
      select.appendChild(opt);
    });

    select.addEventListener('change', () => {
      const opt = select.options[select.selectedIndex];
      const code = select.value;
      const firestoreId = opt ? opt.dataset.firestoreId || null : null;
      rpSelectCourse(code, firestoreId);
    });

  } catch (err) {
    console.error('loadCourseDropdown error:', err);
    rpToast('שגיאה בטעינת הקורסים', 'err');
  }
}

/* ═══════════════════════════════════════════════════════════
   TABS
═══════════════════════════════════════════════════════════ */
function rpSwitchTab(tab) {
  STATE.activeTab = tab;
  document.querySelectorAll('.rp-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.querySelectorAll('.rp-screen').forEach(s => s.classList.remove('active'));
  document.getElementById('rp-screen-' + tab).classList.add('active');
}

/* ═══════════════════════════════════════════════════════════
   COURSE SELECTION — main entry point
═══════════════════════════════════════════════════════════ */
async function rpSelectCourse(courseCode, firestoreId) {
  STATE.currentCourseCode = courseCode || null;
  STATE.currentCourseFirestoreId = firestoreId || null;
  STATE.currentExamAnalyticsId = null;
  STATE.allDailyDocs = [];
  STATE.allQuestionDocs = [];

  if (!courseCode) {
    showOverviewEmpty();
    showDeepdiveEmptyCourse();
    return;
  }

  // Cache Firestore UUID for Live Drawer resolver
  if (firestoreId) STATE.courseUuidCache[courseCode] = firestoreId;

  showOverviewEmpty(false); // hide empty, show content skeleton
  showDeepdiveCourseSelected();

  // Parallel: fetch today's count + all daily docs + all question docs
  await Promise.all([
    loadActiveToday(courseCode),
    loadDailyAndQuestionDocs(courseCode),
  ]);

  renderOverviewFromState();
  await loadExamDropdown(courseCode, firestoreId);
}

/* ── Data loaders ────────────────────────────────────────── */

async function loadActiveToday(courseCode) {
  const docId = `daily_${courseCode}_${todayStr()}`;
  try {
    const snap = await db.collection('research_stats').doc(docId).get();
    const dau = snap.exists ? (snap.data().dau || 0) : 0;
    renderActiveToday(dau);
  } catch (err) {
    console.error('loadActiveToday error:', err);
    renderActiveToday(0);
  }
}

async function loadDailyAndQuestionDocs(courseCode) {
  try {
    // Daily docs: range query by doc ID prefix pattern
    const startId = `daily_${courseCode}_0`;   // '0' < any digit
    const endId   = `daily_${courseCode}_~`;   // '~' > any digit/letter in ASCII
    const [dailySnap, questionSnap] = await Promise.all([
      db.collection('research_stats')
        .orderBy(firebase.firestore.FieldPath.documentId())
        .startAt(startId).endAt(endId)
        .get(),
      db.collection('research_stats')
        .orderBy(firebase.firestore.FieldPath.documentId())
        .startAt(`question_${courseCode}_`)
        .endAt(`question_${courseCode}_~`)
        .get(),
    ]);
    STATE.allDailyDocs    = dailySnap.docs.map(d => ({ id: d.id, ...d.data() }));
    STATE.allQuestionDocs = questionSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.error('loadDailyAndQuestionDocs error:', err);
    STATE.allDailyDocs = [];
    STATE.allQuestionDocs = [];
  }
}

/* ═══════════════════════════════════════════════════════════
   OVERVIEW — render
═══════════════════════════════════════════════════════════ */
function renderOverviewFromState() {
  const { dateFrom, dateTo, allDailyDocs, allQuestionDocs } = STATE;
  const filtered = filterDailyDocs(allDailyDocs, dateFrom, dateTo);

  // Aggregate KPIs
  let totalDau = 0, totalExams = 0, totalQFeed = 0, activeDays = 0, totalStudents = new Set();

  filtered.forEach(doc => {
    totalDau    += doc.dau || 0;
    totalExams  += doc.examsSolved || 0;
    totalQFeed  += doc.questionsFeedbacked || 0;
    if (doc.dau > 0) activeDays++;
    // activeStudents is a count per day — we sum as proxy for avg
  });

  const days = Math.max(activeDays, 1);
  const avgDau = activeDays > 0 ? (totalDau / activeDays).toFixed(1) : '0';

  // Weighted avg per active student across the period
  let totalActiveStudentDays = 0;
  filtered.forEach(d => { totalActiveStudentDays += d.activeStudents || d.dau || 0; });
  const avgExamsPerStudent = totalActiveStudentDays > 0
    ? (totalExams / totalActiveStudentDays).toFixed(2) : '—';
  const avgQFeedPerStudent = totalActiveStudentDays > 0
    ? (totalQFeed / totalActiveStudentDays).toFixed(2) : '—';

  renderKPIGrid('rp-kpi-grid', [
    { label: 'ממוצע משתמשים פעילים ליום',    value: avgDau },
    { label: 'סה"כ מבחנים שנפתרו',           value: totalExams.toLocaleString('he-IL') },
    { label: 'מבחנים לסטודנט פעיל (ממוצע)', value: avgExamsPerStudent },
    { label: 'סה"כ הגבות על שאלות',          value: totalQFeed.toLocaleString('he-IL') },
    { label: 'הגבות לסטודנט פעיל (ממוצע)',  value: avgQFeedPerStudent },
  ]);

  // Aggregate difficulty from question docs (all-time — not date-filtered)
  let struggled = 0, abandoned = 0, success = 0;
  allQuestionDocs.forEach(q => {
    struggled += q.difficulty?.struggled || 0;
    abandoned  += q.difficulty?.abandoned  || 0;
    success    += q.difficulty?.success    || 0;
  });
  const total = struggled + abandoned + success;

  document.getElementById('rp-leg-struggled').textContent = struggled;
  document.getElementById('rp-leg-abandoned').textContent = abandoned;
  document.getElementById('rp-leg-success').textContent   = success;

  renderDoughnutChart('rp-overview-donut', struggled, abandoned, success);

  // Top tables
  renderTopTable('rp-table-hardest', sortByHardest(allQuestionDocs).slice(0, 7), 'hard');
  renderTopTable('rp-table-easiest', sortByEasiest(allQuestionDocs).slice(0, 7), 'easy');
  renderSavedTable('rp-table-saved', sortBySaved(allQuestionDocs).slice(0, 7));

  document.getElementById('rp-overview-content').style.display = 'block';
}

/** Filter daily docs by date range. */
function filterDailyDocs(docs, from, to) {
  if (!from && !to) return docs;
  const fromStr = from ? toDateStr(from) : '0';
  const toStr   = to   ? toDateStr(to)   : '9999-99-99';
  return docs.filter(d => {
    // doc id: daily_{courseCode}_{YYYY-MM-DD}
    const parts = d.id.split('_');
    const datepart = parts[parts.length - 1];
    return datepart >= fromStr && datepart <= toStr;
  });
}

/* ── Sort helpers ────────────────────────────────────────── */
function difficultyRatio(q) {
  const t = (q.difficulty?.struggled || 0) + (q.difficulty?.abandoned || 0) + (q.difficulty?.success || 0);
  if (t === 0) return 0;
  return (q.difficulty?.struggled || 0) / t;
}
function successRatio(q) {
  const t = (q.difficulty?.struggled || 0) + (q.difficulty?.abandoned || 0) + (q.difficulty?.success || 0);
  if (t === 0) return 0;
  return (q.difficulty?.success || 0) / t;
}
function hasVotes(q) {
  return (q.difficulty?.struggled || 0) + (q.difficulty?.abandoned || 0) + (q.difficulty?.success || 0) > 0;
}
function sortByHardest(qs) {
  return [...qs].filter(hasVotes).sort((a, b) => (b.difficulty?.struggled || 0) - (a.difficulty?.struggled || 0));
}
function sortByEasiest(qs) {
  return [...qs].filter(hasVotes).sort((a, b) => (b.difficulty?.success || 0) - (a.difficulty?.success || 0));
}
function sortBySaved(qs) {
  return [...qs].filter(q => q.stars > 0).sort((a, b) => (b.stars || 0) - (a.stars || 0));
}

/* ── Rendering helpers ───────────────────────────────────── */
function renderKPIGrid(containerId, kpis) {
  const grid = document.getElementById(containerId);
  grid.innerHTML = kpis.map(kpi => `
    <div class="rp-kpi-card">
      <div class="rp-kpi-label">${esc(kpi.label)}</div>
      <div class="rp-kpi-value">${esc(String(kpi.value))}</div>
      ${kpi.sub ? `<div class="rp-kpi-sub">${esc(kpi.sub)}</div>` : ''}
    </div>
  `).join('');
}

function renderActiveToday(dau) {
  const badge = document.getElementById('rp-today-badge');
  const text  = document.getElementById('rp-today-text');
  text.textContent = dau > 0
    ? `${esc(String(dau))} משתמשים פעילים היום`
    : 'אין פעילות היום עדיין';
  badge.classList.toggle('zero',   dau === 0);
  badge.classList.toggle('active', dau > 0);
}

function renderDoughnutChart(canvasId, struggled, abandoned, success) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const key = canvasId === 'rp-overview-donut' ? 'overviewDonutChart'
            : canvasId === 'rp-drawer-donut'   ? 'drawerDonutChart'
            : null;
  if (key && STATE[key]) { STATE[key].destroy(); STATE[key] = null; }

  const total = struggled + abandoned + success;
  if (total === 0) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  const chart = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: ['התקשיתי', 'נטשתי', 'הצלחתי'],
      datasets: [{
        data: [struggled, abandoned, success],
        backgroundColor: [DIFF_COLORS.struggled, DIFF_COLORS.abandoned, DIFF_COLORS.success],
        borderWidth: 2,
        borderColor: '#fff',
      }],
    },
    options: {
      responsive: canvasId !== 'rp-drawer-donut',
      maintainAspectRatio: true,
      cutout: '65%',
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => {
              const v = ctx.raw;
              const pct = total > 0 ? ((v / total) * 100).toFixed(1) : 0;
              return ` ${ctx.label}: ${v} (${pct}%)`;
            },
          },
        },
      },
      animation: { duration: 400 },
    },
  });
  if (key) STATE[key] = chart;
}

function renderTopTable(tableId, questions, mode = 'hard') {
  const tbody = document.querySelector(`#${tableId} tbody`);
  if (!tbody) return;
  if (questions.length === 0) {
    tbody.innerHTML = `<tr><td colspan="3" class="rp-no-data-inline">אין נתונים</td></tr>`;
    return;
  }
  tbody.innerHTML = questions.map((q, i) => {
    const struggled = q.difficulty?.struggled || 0;
    const success   = q.difficulty?.success   || 0;
    // numeric count: how many students voted "struggled" (hard table) or "success" (easy table)
    const count = mode === 'easy' ? success : struggled;
    const color = mode === 'easy' ? 'var(--success)' : 'var(--accent)';
    return `
      <tr class="clickable"
          onclick="rpOpenDrawer('${esc(q.questionId)}','${esc(q.examId)}')">
        <td><span class="rp-rank-num">${i + 1}</span></td>
        <td>${formatExamLabel(q.examId || '', q.questionId || '')}</td>
        <td style="color:${color};font-weight:600">${esc(String(count))}</td>
      </tr>`;
  }).join('');
}

function renderSavedTable(tableId, questions) {
  const tbody = document.querySelector(`#${tableId} tbody`);
  if (!tbody) return;
  if (questions.length === 0) {
    tbody.innerHTML = `<tr><td colspan="3" class="rp-no-data-inline">אין נתונים</td></tr>`;
    return;
  }
  tbody.innerHTML = questions.map((q, i) => `
    <tr class="clickable" onclick="rpOpenDrawer('${esc(q.questionId)}','${esc(q.examId)}')">
      <td><span class="rp-rank-num">${i + 1}</span></td>
      <td>${formatExamLabel(q.examId || '', q.questionId || '')}</td>
      <td>⭐ ${esc(String(q.stars || 0))}</td>
    </tr>
  `).join('');
}

/* ═══════════════════════════════════════════════════════════
   EXAM DROPDOWN & DEEP-DIVE
═══════════════════════════════════════════════════════════ */
async function loadExamDropdown(courseCode, firestoreId) {
  const select = document.getElementById('rp-exam-select');
  select.innerHTML = '<option value="">-- בחר מבחן --</option>';

  if (!firestoreId) return;
  try {
    const snap = await db.collection('exams')
      .where('courseId', '==', firestoreId)
      .get();

    // Sort by year descending in JS (avoids needing a composite Firestore index)
    const docs = snap.docs.slice().sort((a, b) => (b.data().year || 0) - (a.data().year || 0));

    // Build a set of examAnalyticsIds that have any stats (question votes OR completions)
    const statsExamIds = new Set(STATE.examIdsWithData);

    docs.forEach(doc => {
      const d = doc.data();
      // Build the analytics-format exam ID to check for data presence
      const semLetter  = Object.keys(SEMESTER_MAP).find(k => SEMESTER_MAP[k] === d.semester) || d.semester || '';
      const moedLetter = Object.keys(MOED_MAP).find(k => MOED_MAP[k] === d.moed)         || d.moed     || '';
      const analyticsId = `${courseCode}_${d.year || ''}_${semLetter}_${moedLetter}`;

      const hasData = statsExamIds.has(analyticsId);
      const opt = document.createElement('option');
      opt.value = esc(analyticsId);
      opt.disabled = !hasData;
      // esc() the exam title parts to prevent XSS
      const title = [d.year, d.semester, d.moed].filter(Boolean).join(' ');
      opt.textContent = esc(title) + (!hasData ? ' (אין נתונים)' : '');
      select.appendChild(opt);
    });

  } catch (err) {
    console.error('loadExamDropdown error:', err);
    rpToast('שגיאה בטעינת המבחנים', 'err');
  }
}

async function rpSelectExam(examAnalyticsId) {
  // Destroy any previous question card charts before loading new exam
  STATE.questionCardCharts.forEach(c => { try { c.destroy(); } catch {} });
  STATE.questionCardCharts = [];

  STATE.currentExamAnalyticsId = examAnalyticsId || null;
  if (!examAnalyticsId) {
    document.getElementById('rp-deepdive-empty-exam').style.display = 'block';
    document.getElementById('rp-deepdive-content').style.display = 'none';
    return;
  }

  document.getElementById('rp-deepdive-empty-exam').style.display = 'none';
  document.getElementById('rp-deepdive-content').style.display = 'none';

  try {
    const snap = await db.collection('research_stats').doc(`exam_${examAnalyticsId}`).get();
    STATE.currentExamDoc = snap.exists ? snap.data() : null;
    if (!STATE.currentExamDoc) {
      rpToast('אין נתוני ניתוח למבחן זה', 'err');
      document.getElementById('rp-deepdive-empty-exam').style.display = 'block';
      return;
    }
    renderExamDeepdive(STATE.currentExamDoc);
  } catch (err) {
    console.error('rpSelectExam error:', err);
    rpToast('שגיאה בטעינת נתוני המבחן', 'err');
  }
}

function renderExamDeepdive(examDoc) {
  // KPIs
  renderKPIGrid('rp-exam-kpi-grid', [
    { label: 'סטודנטים שניסו',  value: (examDoc.totalAttempted || 0).toLocaleString('he-IL') },
    { label: 'סטודנטים שסיימו', value: (examDoc.totalFinished  || 0).toLocaleString('he-IL') },
  ]);

  const questions = examDoc.questions || [];

  // Mini-donut cards per question
  renderQuestionCards(questions);

  // Ranking table
  const tbody = document.getElementById('rp-exam-table-body');
  if (!tbody) return;
  const sorted = [...questions].sort((a, b) => {
    return difficultyRatio({ difficulty: a.difficulty }) - difficultyRatio({ difficulty: b.difficulty });
  }).reverse(); // hardest first

  tbody.innerHTML = sorted.map((q, i) => {
    const struggled = q.difficulty?.struggled || 0;
    const abandoned  = q.difficulty?.abandoned  || 0;
    const success    = q.difficulty?.success    || 0;
    const total = struggled + abandoned + success;
    const pctStruggled = total > 0 ? Math.round((struggled / total) * 100) : 0;
    const pctAbandoned = total > 0 ? Math.round((abandoned  / total) * 100) : 0;
    const pctSuccess   = total > 0 ? Math.round((success   / total) * 100) : 0;
    const qid    = esc(q.questionId || '');
    const examid = esc(STATE.currentExamAnalyticsId || '');
    return `
      <tr class="clickable" onclick="rpOpenDrawer('${qid}','${examid}')">
        <td><span class="rp-rank-num">${i + 1}</span></td>
        <td>${qid}</td>
        <td style="color:var(--accent);font-weight:600">${pctStruggled}%</td>
        <td style="color:var(--danger);font-weight:600">${pctAbandoned}%</td>
        <td style="color:var(--success);font-weight:600">${pctSuccess}%</td>
        <td>⭐ ${esc(String(q.stars || 0))}</td>
      </tr>`;
  }).join('');

  document.getElementById('rp-deepdive-content').style.display = 'block';
}

function makeDiffBar(struggled, abandoned, success, total) {
  if (total === 0) return '<span class="rp-no-data-inline">—</span>';
  const s = Math.round((struggled / total) * 100);
  const a = Math.round((abandoned  / total) * 100);
  const c = 100 - s - a;
  return `<div class="rp-diff-bar-wrap">
    <div class="rp-diff-bar-seg struggled" style="width:${s}%"></div>
    <div class="rp-diff-bar-seg abandoned"  style="width:${a}%"></div>
    <div class="rp-diff-bar-seg success"    style="width:${c}%"></div>
  </div>`;
}

function renderQuestionCards(questions) {
  // Destroy previous card charts
  STATE.questionCardCharts.forEach(c => { try { c.destroy(); } catch {} });
  STATE.questionCardCharts = [];

  const container = document.getElementById('rp-question-cards');
  if (!container) return;
  container.innerHTML = '';
  if (!questions.length) return;

  questions.forEach((q, i) => {
    const struggled = q.difficulty?.struggled || 0;
    const abandoned  = q.difficulty?.abandoned  || 0;
    const success    = q.difficulty?.success    || 0;
    const total = struggled + abandoned + success;
    const pctStruggled = total > 0 ? Math.round(struggled / total * 100) : 0;
    const pctAbandoned  = total > 0 ? Math.round(abandoned  / total * 100) : 0;
    const pctSuccess   = total > 0 ? Math.round(success   / total * 100) : 0;
    const canvasId = `rp-q-donut-${i}`;
    const qid = q.questionId || `Q${i + 1}`;

    const card = document.createElement('div');
    card.className = 'rp-q-card';
    card.title = 'לחץ לפרטי השאלה';
    card.onclick = () => rpOpenDrawer(qid, STATE.currentExamAnalyticsId);
    card.innerHTML = `
      <div class="rp-q-card-label">${esc(qid)}</div>
      <div class="rp-q-card-canvas-wrap">
        <canvas id="${canvasId}" width="100" height="100"></canvas>
      </div>
      <div class="rp-q-card-pct">
        <span style="color:var(--accent)">${pctStruggled}% התקשיתי</span><br>
        <span style="color:var(--danger)">${pctAbandoned}% נטשתי</span><br>
        <span style="color:var(--success)">${pctSuccess}% הצלחתי</span>
      </div>`;
    container.appendChild(card);

    const chart = new Chart(document.getElementById(canvasId), {
      type: 'doughnut',
      data: {
        labels: ['התקשיתי', 'נטשתי', 'הצלחתי'],
        datasets: [{
          data: [struggled, abandoned, success],
          backgroundColor: [DIFF_COLORS.struggled, DIFF_COLORS.abandoned, DIFF_COLORS.success],
          borderWidth: 1,
          borderColor: '#fff',
        }],
      },
      options: {
        cutout: '58%',
        plugins: { legend: { display: false }, tooltip: { enabled: true } },
        animation: { duration: 250 },
      },
    });
    STATE.questionCardCharts.push(chart);
  });
}

/* ═══════════════════════════════════════════════════════════
   DATE RANGE CONTROLS
═══════════════════════════════════════════════════════════ */
function rpSelectPreset(days) {
  // Deactivate all pills
  document.querySelectorAll('.rp-range-pill').forEach(p => p.classList.remove('active'));
  // Activate the matching pill
  const pill = document.querySelector(`.rp-range-pill[data-days="${days}"]`);
  if (pill) pill.classList.add('active');

  rpCloseCustom();

  if (days === 0) {
    STATE.dateFrom = null;
    STATE.dateTo   = null;
  } else {
    STATE.dateTo   = new Date();
    STATE.dateFrom = daysAgo(days);
  }
  if (STATE.currentCourseCode) renderOverviewFromState();
}

function rpToggleCustom() {
  const pop = document.getElementById('rp-custom-popover');
  pop.classList.toggle('open');
  if (pop.classList.contains('open')) {
    // Pre-fill inputs with current range
    const fromEl = document.getElementById('rp-date-from');
    const toEl   = document.getElementById('rp-date-to');
    fromEl.value = STATE.dateFrom ? toDateStr(STATE.dateFrom) : '';
    toEl.value   = STATE.dateTo   ? toDateStr(STATE.dateTo)   : '';
    // Set max date to today to prevent future dates
    const today = todayStr();
    fromEl.max = today;
    toEl.max   = today;
    document.getElementById('rp-dp-error').textContent = '';
  }
}

function rpCloseCustom() {
  document.getElementById('rp-custom-popover').classList.remove('open');
}

function rpApplyCustomRange() {
  const fromVal = document.getElementById('rp-date-from').value;
  const toVal   = document.getElementById('rp-date-to').value;
  const errEl   = document.getElementById('rp-dp-error');

  // Validation
  if (!fromVal || !toVal) {
    errEl.textContent = 'יש למלא את שני התאריכים.';
    return;
  }
  if (fromVal > toVal) {
    errEl.textContent = 'תאריך ההתחלה חייב להיות לפני תאריך הסיום.';
    return;
  }
  const today = todayStr();
  if (fromVal > today || toVal > today) {
    errEl.textContent = 'לא ניתן לבחור תאריך עתידי.';
    return;
  }
  errEl.textContent = '';

  STATE.dateFrom = new Date(fromVal + 'T00:00:00');
  STATE.dateTo   = new Date(toVal   + 'T23:59:59');

  // Mark custom pill as active, deactivate others
  document.querySelectorAll('.rp-range-pill').forEach(p => p.classList.remove('active'));
  document.getElementById('rp-custom-btn').classList.add('active');

  rpCloseCustom();
  if (STATE.currentCourseCode) renderOverviewFromState();
}

/* ═══════════════════════════════════════════════════════════
   LIVE DRAWER
═══════════════════════════════════════════════════════════ */
async function rpOpenDrawer(questionId, examAnalyticsId) {
  // Find analytics doc for this question
  const analyticsDoc = findQuestionDoc(questionId, examAnalyticsId);

  rpShowDrawerSkeleton(questionId, examAnalyticsId);
  openDrawerDOM();

  // Fetch question content from Firestore
  let questionContent = null;
  try {
    questionContent = await resolveQuestionContent(examAnalyticsId, questionId);
  } catch (err) {
    console.error('resolveQuestionContent error:', err);
  }

  renderDrawerContent(questionId, examAnalyticsId, questionContent, analyticsDoc);
}

/** Find the pre-loaded analytics doc for a specific question. */
function findQuestionDoc(questionId, examAnalyticsId) {
  // Try question docs from allQuestionDocs (overview) or from currentExamDoc.questions
  const fromList = STATE.allQuestionDocs.find(
    q => q.questionId === questionId && q.examId === examAnalyticsId
  );
  if (fromList) return fromList;

  if (STATE.currentExamDoc) {
    const q = (STATE.currentExamDoc.questions || []).find(
      q => q.questionId === questionId
    );
    if (q) return { questionId, examId: examAnalyticsId, ...q };
  }
  return null;
}

/**
 * Resolve a question's full content from Firestore.
 * Maps analytics IDs back to Firestore UUIDs.
 */
async function resolveQuestionContent(examAnalyticsId, questionId) {
  const parsed = parseAnalyticsExamId(examAnalyticsId);
  if (!parsed) throw new Error(`Cannot parse examAnalyticsId: ${examAnalyticsId}`);

  const { courseCode, year, semester, moed } = parsed;

  // Step 1: Get course Firestore UUID (use cache to avoid repeat reads)
  let courseUuid = STATE.courseUuidCache[courseCode];
  if (!courseUuid) {
    const snap = await db.collection('courses').where('code', '==', courseCode).limit(1).get();
    if (snap.empty) throw new Error(`Course not found: ${courseCode}`);
    courseUuid = snap.docs[0].id;
    STATE.courseUuidCache[courseCode] = courseUuid;
  }

  // Step 2: Find exam document by metadata fields
  const examSnap = await db.collection('exams')
    .where('courseId',  '==', courseUuid)
    .where('year',      '==', year)
    .where('semester',  '==', semester)
    .where('moed',      '==', moed)
    .limit(1)
    .get();

  if (examSnap.empty) throw new Error(`Exam not found: ${examAnalyticsId}`);
  const examData = examSnap.docs[0].data();

  // Step 3: Extract question by index (Q1 → index 0, Q2 → index 1, etc.)
  const idx = parseInt(questionId.replace(/[^0-9]/g, ''), 10) - 1;
  const questions = examData.questions || [];
  const question = questions[idx] || null;

  return question; // { id, text, subs, inlineImages, isBonus }
}

function openDrawerDOM() {
  document.getElementById('rp-backdrop').classList.add('open');
  document.getElementById('rp-drawer').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function rpCloseDrawer() {
  document.getElementById('rp-backdrop').classList.remove('open');
  document.getElementById('rp-drawer').classList.remove('open');
  document.body.style.overflow = '';
  // Destroy drawer chart to free memory
  if (STATE.drawerDonutChart) { STATE.drawerDonutChart.destroy(); STATE.drawerDonutChart = null; }
}

function rpShowDrawerSkeleton(questionId, examAnalyticsId) {
  document.getElementById('rp-drawer-qid').textContent = esc(questionId);
  document.getElementById('rp-drawer-q-label').textContent = 'שאלה';
  document.getElementById('rp-drawer-body').innerHTML = `
    <div class="rp-drawer-skeleton">
      <div class="rp-skeleton sk-line" style="width:80%;height:12px"></div>
      <div class="rp-skeleton sk-line" style="width:60%;height:12px"></div>
      <div class="rp-skeleton sk-line" style="width:90%;height:12px"></div>
      <div class="rp-skeleton sk-line" style="width:55%;height:12px;margin-top:1.2rem"></div>
      <div class="rp-skeleton sk-line" style="width:40%;height:12px"></div>
    </div>`;
}

function renderDrawerContent(questionId, examAnalyticsId, questionContent, analyticsDoc) {
  const body = document.getElementById('rp-drawer-body');

  // --- Question Content Section ---
  let contentHtml = '';
  if (questionContent) {
    const isBonus = questionContent.isBonus || false;
    const mainText = formatMathText(questionContent.text, questionContent.inlineImages || {});
    const subsHtml = (questionContent.subs || []).map(sub => `
      <div class="rp-sub-question">
        <div class="rp-sub-label">${esc(sub.label || '')}</div>
        <div>${formatMathText(sub.text, questionContent.inlineImages || {})}</div>
      </div>`).join('');

    contentHtml = `
      <div class="rp-question-content">
        ${isBonus ? '<div class="rp-bonus-tag">בונוס</div>' : ''}
        ${mainText}
        ${subsHtml}
      </div>`;
  } else {
    contentHtml = `
      <div class="rp-question-content rp-empty-state" style="padding:1rem 0">
        <div class="rp-empty-icon">📄</div>
        <p>לא נמצא תוכן השאלה עבור מבחן זה.</p>
        <small style="color:var(--light)">${esc(examAnalyticsId)} / ${esc(questionId)}</small>
      </div>`;
  }

  // --- Analytics Section ---
  let analyticsHtml = '';
  if (analyticsDoc) {
    const struggled = analyticsDoc.difficulty?.struggled || 0;
    const abandoned  = analyticsDoc.difficulty?.abandoned  || 0;
    const success    = analyticsDoc.difficulty?.success    || 0;
    const stars  = analyticsDoc.stars  || 0;
    const copies = analyticsDoc.copies || 0;

    analyticsHtml = `
      <div class="rp-drawer-analytics">
        <div class="rp-drawer-analytics-title">נתוני אנליטיקה</div>
        <div class="rp-drawer-stats-row">
          <div class="rp-drawer-stat">⭐ ${esc(String(stars))} שמירות</div>
          <div class="rp-drawer-stat">📋 ${esc(String(copies))} העתקות</div>
        </div>
        <div class="rp-drawer-chart-wrap">
          <canvas id="rp-drawer-donut" width="160" height="160"></canvas>
        </div>
        <div class="rp-chart-legend">
          <div class="rp-legend-item">
            <div class="rp-legend-dot" style="background:var(--accent)"></div>
            <span>התקשיתי (${esc(String(struggled))})</span>
          </div>
          <div class="rp-legend-item">
            <div class="rp-legend-dot" style="background:var(--danger)"></div>
            <span>נטשתי (${esc(String(abandoned))})</span>
          </div>
          <div class="rp-legend-item">
            <div class="rp-legend-dot" style="background:var(--success)"></div>
            <span>הצלחתי (${esc(String(success))})</span>
          </div>
        </div>
      </div>`;
  } else {
    analyticsHtml = `
      <div class="rp-drawer-analytics">
        <div class="rp-drawer-analytics-title">נתוני אנליטיקה</div>
        <p class="rp-no-data-inline">אין נתוני אנליטיקה לשאלה זו.</p>
      </div>`;
  }

  body.innerHTML = contentHtml + analyticsHtml;

  // Render Chart.js doughnut for this question
  if (analyticsDoc) {
    const struggled = analyticsDoc.difficulty?.struggled || 0;
    const abandoned  = analyticsDoc.difficulty?.abandoned  || 0;
    const success    = analyticsDoc.difficulty?.success    || 0;
    renderDoughnutChart('rp-drawer-donut', struggled, abandoned, success);
  }

  // Typeset MathJax on the drawer content (async, non-blocking)
  if (window.MathJax && window.MathJax.typesetPromise) {
    window.MathJax.typesetPromise([body]).catch(err => console.warn('MathJax typeset error:', err));
  }
}

/* ═══════════════════════════════════════════════════════════
   SHOW/HIDE HELPERS
═══════════════════════════════════════════════════════════ */
function showOverviewEmpty(show = true) {
  document.getElementById('rp-overview-empty').style.display         = show ? 'block' : 'none';
  document.getElementById('rp-overview-content').style.display       = show ? 'none'  : 'none'; // keep hidden until data loads
}

function showDeepdiveEmptyCourse() {
  document.getElementById('rp-deepdive-empty-course').style.display  = 'block';
  document.getElementById('rp-deepdive-exam-select').style.display   = 'none';
  document.getElementById('rp-deepdive-empty-exam').style.display    = 'none';
  document.getElementById('rp-deepdive-content').style.display       = 'none';
}

function showDeepdiveCourseSelected() {
  document.getElementById('rp-deepdive-empty-course').style.display  = 'none';
  document.getElementById('rp-deepdive-exam-select').style.display   = 'block';
  document.getElementById('rp-deepdive-empty-exam').style.display    = 'block';
  document.getElementById('rp-deepdive-content').style.display       = 'none';
}
