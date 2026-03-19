/**
 * migrate-roles.js — Add `role` field to all production users
 *
 * Usage:
 *   node seed/migrate-roles.js --dry-run    ← preview only, no changes
 *   node seed/migrate-roles.js --emulator   ← run against local emulator
 *   node seed/migrate-roles.js              ← run against production
 */

const https = require('https');
const http  = require('http');

// ── Config ─────────────────────────────────────────────────────────────────

const ADMIN_EMAILS = [
  'sean.sirota.2002.09@gmail.com',
  'gmorag1@gmail.com',
  'dor17170101@gmail.com',
];

const PROJECT_ID   = 'eaxmbank';
const IS_DRY_RUN   = process.argv.includes('--dry-run');
const IS_EMULATOR  = process.argv.includes('--emulator');

const HOST    = IS_EMULATOR ? 'localhost' : 'firestore.googleapis.com';
const PORT    = IS_EMULATOR ? 8080 : 443;
const PROTO   = IS_EMULATOR ? http : https;
const BASE    = IS_EMULATOR
  ? `http://localhost:${PORT}/v1`
  : `https://firestore.googleapis.com/v1`;

// ── Helpers ────────────────────────────────────────────────────────────────

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = PROTO.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function toFirestoreValue(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'boolean')          return { booleanValue: val };
  if (typeof val === 'number')           return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  if (typeof val === 'string')           return { stringValue: val };
  return { stringValue: String(val) };
}

async function listUsers(pageToken) {
  const path = `/v1/projects/${PROJECT_ID}/databases/(default)/documents/users${pageToken ? `?pageToken=${pageToken}` : ''}`;
  const res = await request({
    hostname: HOST,
    port: PORT,
    path,
    method: 'GET',
    headers: {}
  });
  if (res.status >= 400) throw new Error(`List users failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

async function patchUserRole(docName, role) {
  // docName is the full resource name e.g. projects/.../documents/users/{uid}
  const path = `/v1/${docName}?updateMask.fieldPaths=role`;
  const res = await request({
    hostname: HOST,
    port: PORT,
    path,
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' }
  }, { fields: { role: toFirestoreValue(role) } });
  if (res.status >= 400) throw new Error(`Patch failed for ${docName}: ${res.status} ${JSON.stringify(res.body)}`);
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🔧 VaulTau migrate-roles`);
  console.log(`   Mode: ${IS_EMULATOR ? '🖥  emulator' : '🌐 production'}`);
  console.log(`   Dry run: ${IS_DRY_RUN ? '✅ YES — no changes will be made' : '❌ NO — changes will be written'}\n`);

  if (!IS_EMULATOR && !IS_DRY_RUN) {
    console.log('⚠️  Running against PRODUCTION. You have 5 seconds to cancel (Ctrl+C)...\n');
    await new Promise(r => setTimeout(r, 5000));
  }

  let allDocs = [];
  let pageToken = null;

  // Paginate through all users
  do {
    const res = await listUsers(pageToken);
    if (res.documents) allDocs = allDocs.concat(res.documents);
    pageToken = res.nextPageToken || null;
  } while (pageToken);

  console.log(`📋 Found ${allDocs.length} users\n`);

  let adminCount   = 0;
  let studentCount = 0;
  let skipCount    = 0;

  for (const doc of allDocs) {
    const fields = doc.fields || {};
    const email  = fields.email?.stringValue || '';
    const uid    = doc.name.split('/').pop();
    const currentRole = fields.role?.stringValue;

    if (currentRole) {
      console.log(`   ⏭  skip  ${email || uid} — already has role: ${currentRole}`);
      skipCount++;
      continue;
    }

    const role = ADMIN_EMAILS.includes(email.toLowerCase()) ? 'admin' : 'student';

    if (role === 'admin') {
      console.log(`   👑 admin   ${email}`);
      adminCount++;
    } else {
      console.log(`   🎓 student ${email || uid}`);
      studentCount++;
    }

    if (!IS_DRY_RUN) {
      await patchUserRole(doc.name, role);
    }
  }

  console.log(`\n📊 Summary:`);
  console.log(`   👑 admins:   ${adminCount}`);
  console.log(`   🎓 students: ${studentCount}`);
  console.log(`   ⏭  skipped:  ${skipCount} (already had role)`);

  if (IS_DRY_RUN) {
    console.log('\n✅ Dry run complete — no changes were made.');
    console.log('   Run without --dry-run to apply changes.');
  } else {
    console.log('\n✅ Migration complete!');
  }
}

main().catch(err => {
  console.error('\n❌ Migration failed:', err.message);
  if (!IS_EMULATOR) {
    console.error('   For production, make sure you are authenticated: firebase login');
  } else {
    console.error('   Make sure the emulator is running: npm run emulator');
  }
  process.exit(1);
});
