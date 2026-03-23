/**
 * Pre-generation background job (Netlify Scheduled Function).
 * Runs daily at 2:00 AM UTC — generates and caches AI questions
 * for the top 10 most-accessed exams to ensure instant responses
 * during peak hours.
 *
 * Schedule is configured in netlify.toml.
 */

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

// Initialize Firebase Admin (uses GOOGLE_APPLICATION_CREDENTIALS or inline config)
let db;
function getDb() {
  if (db) return db;
  const projectId = process.env.FIREBASE_PROJECT_ID || 'eaxmbank';
  try {
    initializeApp({ projectId });
  } catch { /* already initialized */ }
  db = getFirestore();
  return db;
}

const GEMINI_MODEL = 'gemini-3.1-pro-preview';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const QUESTIONS_PER_EXAM = 5;
const CACHE_COLLECTION = 'ai_questions_cache';

exports.handler = async (event) => {
  console.log('⏰ Pre-generation job started', new Date().toISOString());
  const firestore = getDb();
  const geminiKey = process.env.GEMINI_API_KEY;

  if (!geminiKey) {
    console.error('GEMINI_API_KEY not set');
    return { statusCode: 500, body: 'Missing API key' };
  }

  try {
    // 1. Find top 10 popular exams from recent usage
    const usageSnap = await firestore.collection('generate_usage')
      .orderBy('timestamp', 'desc')
      .limit(500)
      .get();

    const examCounts = {};
    usageSnap.docs.forEach(doc => {
      const d = doc.data();
      // Extract exam context from prompt if available
      const promptSnippet = (d.promptSnippet || '').slice(0, 50);
      if (promptSnippet) {
        examCounts[promptSnippet] = (examCounts[promptSnippet] || 0) + 1;
      }
    });

    // Alternatively, enumerate all cached question IDs and pick the most-hit ones
    const cacheSnap = await firestore.collection(CACHE_COLLECTION)
      .orderBy('updatedAt', 'desc')
      .limit(50)
      .get();

    const popularIds = cacheSnap.docs
      .map(doc => ({ id: doc.id, data: doc.data() }))
      .filter(d => d.data.sourceText)  // must have source text to regenerate
      .slice(0, 10);

    if (!popularIds.length) {
      console.log('No popular exams found for pre-generation');
      return { statusCode: 200, body: 'No exams to pre-generate' };
    }

    let totalGenerated = 0;

    // 2. Generate questions for each popular exam
    for (const { id, data } of popularIds) {
      const sourceText = data.sourceText || '';
      if (!sourceText) continue;

      // Check how many fresh items exist already
      const existingItems = (data.items || []).filter(item => {
        if (!item.createdAt) return false;
        const age = Date.now() - new Date(item.createdAt).getTime();
        return age < 6 * 60 * 60 * 1000; // 6 hours
      });

      const needed = Math.max(0, QUESTIONS_PER_EXAM - existingItems.length);
      if (needed === 0) {
        console.log(`Cache ${id}: already has ${existingItems.length} fresh items, skipping`);
        continue;
      }

      console.log(`Cache ${id}: generating ${needed} questions`);

      const newItems = [];
      for (let i = 0; i < needed; i++) {
        try {
          const text = await generateQuestion(geminiKey, sourceText);
          if (text) {
            newItems.push({ text, createdAt: new Date().toISOString() });
            totalGenerated++;
          }
        } catch (e) {
          console.warn(`Generation failed for ${id} question ${i + 1}:`, e.message);
        }
        // Small delay to avoid rate limiting
        await sleep(1000);
      }

      if (newItems.length > 0) {
        const allItems = [...existingItems, ...newItems];
        await firestore.collection(CACHE_COLLECTION).doc(id).set({
          sourceText,
          items: allItems,
          updatedAt: new Date(),
        }, { merge: true });
        console.log(`Cache ${id}: added ${newItems.length} new items (total: ${allItems.length})`);
      }
    }

    console.log(`✅ Pre-generation complete: ${totalGenerated} questions generated`);
    return { statusCode: 200, body: `Generated ${totalGenerated} questions` };

  } catch (e) {
    console.error('Pre-generation error:', e);
    return { statusCode: 500, body: e.message };
  }
};

async function generateQuestion(apiKey, sourceText) {
  const prompt = `אתה מרצה בכיר למתמטיקה באוניברסיטה.
צור שאלת תרגול *אחת* חדשה שדומה לשאלה המקורית.
שמור על אותו מבנה ומושגים, שנה את הנתונים.
ודא שהשאלה פתירה בצורה נקייה.
השתמש ב-LaTeX ($ ו-$$) לביטויים מתמטיים.
החזר רק את טקסט השאלה בעברית, בלי הקדמות.

השאלה המקורית:
${sourceText}`;

  const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.65, maxOutputTokens: 16384 },
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Gemini HTTP ${res.status}`);
  }

  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
