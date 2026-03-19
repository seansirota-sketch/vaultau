/**
 * migrate-roles.js — Add `role` field to all production users
 *
 * Usage:
 *   node seed/migrate-roles.js --dry-run    ← preview only, no changes
 *   node seed/migrate-roles.js --emulator   ← run against local emulator
 *   node seed/migrate-roles.js              ← run against production
 */

const path  = require('path');

const ADMIN_EMAILS = [
  'sean.sirota.2002.09@gmail.com',
  'gmorag1@gmail.com',
  'dor17170101@gmail.com',
];

const PROJECT_ID  = 'eaxmbank';
const IS_DRY_RUN  = process.argv.includes('--dry-run');
const IS_EMULATOR = process.argv.includes('--emulator');

// ── Init ───────────────────────────────────────────────────────────────────

let db;

async function init() {
  if (IS_EMULATOR) {
    // Use plain HTTP for emulator (no Admin SDK needed)
    return;
  }

  const admin = require('firebase-admin');
  const serviceAccount = require(path.resolve(__dirname, '../service-account.json'));

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: PROJECT_ID,
  });

  db = admin.firestore();
}

// ── Emulator helpers (plain HTTP) ──────────────────────────────────────────

const http = require('http');

function httpRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, res => {
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

async function listEmulatorUsers(pageToken) {
  const p = `/v1/projects/${PROJECT_ID}/databases/(default)/documents/users${pageToken ? `?pageToken=${pageToken}` : ''}`;
  const res = await httpRequest({ hostname: 'localhost', port: 8080, path: p, method: 'GET', headers: {} });
  if (res.status >= 400) throw new Error(`List users failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

async function patchEmulatorRole(docName, role) {
  const p = `/v1/${docName}?updateMask.fieldPaths=role`;
  const res = await httpRequest({
    hostname: 'localhost', port: 8080, path: p, method: 'PATCH',
    headers: { 'Content-Type': 'application/json' }
  }, { fields: { role: { stringValue: role } } });
  if (res.status >= 400) throw new Error(`Patch failed: ${res.status} ${JSON.stringify(res.body)}`);
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

  await init();

  let adminCount   = 0;
  let studentCount = 0;
  let skipCount    = 0;

  if (IS_EMULATOR) {
    // ── Emulator path ──────────────────────────────────────────────────────
    let allDocs  = [];
    let pageToken = null;
    do {
      const res = await listEmulatorUsers(pageToken);
      if (res.documents) allDocs = allDocs.concat(res.documents);
      pageToken = res.nextPageToken || null;
    } while (pageToken);

    console.log(`📋 Found ${allDocs.length} users\n`);

    for (const doc of allDocs) {
      const fields      = doc.fields || {};
      const email       = fields.email?.stringValue || '';
      const uid         = doc.name.split('/').pop();
      const currentRole = fields.role?.stringValue;

      if (currentRole) {
        console.log(`   ⏭  skip  ${email || uid} — already has role: ${currentRole}`);
        skipCount++; continue;
      }

      const role = ADMIN_EMAILS.includes(email.toLowerCase()) ? 'admin' : 'student';
      role === 'admin'
        ? console.log(`   👑 admin   ${email}`) && adminCount++
        : console.log(`   🎓 student ${email || uid}`) && studentCount++;

      if (role === 'admin') adminCount++; else studentCount++;
      if (!IS_DRY_RUN) await patchEmulatorRole(doc.name, role);
    }

  } else {
    // ── Production path (Admin SDK) ────────────────────────────────────────
    const snap = await db.collection('users').get();
    console.log(`📋 Found ${snap.size} users\n`);

    for (const doc of snap.docs) {
      const data        = doc.data();
      const email       = (data.email || '').toLowerCase();
      const currentRole = data.role;

      if (currentRole) {
        console.log(`   ⏭  skip  ${email || doc.id} — already has role: ${currentRole}`);
        skipCount++; continue;
      }

      const role = ADMIN_EMAILS.includes(email) ? 'admin' : 'student';
      if (role === 'admin') {
        console.log(`   👑 admin   ${email}`);
        adminCount++;
      } else {
        console.log(`   🎓 student ${email || doc.id}`);
        studentCount++;
      }

      if (!IS_DRY_RUN) await doc.ref.update({ role });
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
    console.error('   Make sure service-account.json is in the project root.');
  } else {
    console.error('   Make sure the emulator is running: npm run emulator');
  }
  process.exit(1);
});
