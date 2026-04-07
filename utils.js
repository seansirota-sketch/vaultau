/* ============================================================
   SHARED UTILITIES  —  utils.js
   Loaded before admin.js and course.js in both HTML pages.
   ============================================================ */

function normalizeImageAlign(v) {
  return ['left', 'center', 'right'].includes(v) ? v : 'center';
}
