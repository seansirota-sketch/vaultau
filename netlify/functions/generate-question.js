/* ============================================================
   netlify/functions/generate-question.js
   REMOVED — This endpoint has been disabled.
   Use the Edge Function at /api/generate-question instead.
   ============================================================ */

exports.handler = async () => ({
  statusCode: 410,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ error: 'This endpoint has been removed. Use /api/generate-question.' }),
});
