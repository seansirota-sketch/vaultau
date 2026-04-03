/**
 * Phase 3: Dual-Login Reliability Testing Harness
 * 
 * Usage:
 *   1. Deploy to test VM or include in Netlify function
 *   2. Run: node phase3-test-harness.js
 *   3. Results logged to console and phase3-results.json
 * 
 * Configuration:
 *   - VAULTAU_DEPLOY_PREVIEW_URL
 *   - EXCHANGE_ENDPOINT_URL
 *   - MOODLE_SANDBOX_URL
 *   - LTI_SIGNING_KEY
 */

const crypto = require('crypto');
const fs = require('fs');

const fetchFn = global.fetch || ((...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args)));

const CONFIG = {
  VAULTAU_URL: process.env.VAULTAU_URL || 'https://deploy-preview-67--vaultau.netlify.app',
  EXCHANGE_ENDPOINT: '/.netlify/functions/lti-session-exchange',
  MOODLE_URL: process.env.MOODLE_URL || 'https://sandbox.moodledemo.net',
  LTI_SIGNING_KEY: process.env.LTI_HANDOFF_SIGNING_KEY || 'dev-only-change-me',
  LTI_HANDOFF_ISSUER: process.env.LTI_HANDOFF_ISSUER || 'lti-tool-bridge',
  LTI_HANDOFF_AUDIENCE: process.env.LTI_HANDOFF_AUDIENCE || 'vaultau',
};

const RESULTS = {
  launchTests: [],
  negativeTests: [],
  performanceTests: [],
  regressionTests: [],
  summary: {},
};

/**
 * ─────────────────────────────────────────────────────────────
 * UTIL FUNCTIONS
 * ─────────────────────────────────────────────────────────────
 */

function base64UrlEncode(str) {
  return Buffer.from(str)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function generateHandoffToken(claims, expiresInSeconds = 300) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    iss: CONFIG.LTI_HANDOFF_ISSUER,
    aud: CONFIG.LTI_HANDOFF_AUDIENCE,
    exp: now + expiresInSeconds,
    iat: now,
    jti: `jti_${Math.random().toString(36).substr(2, 9)}`,
    sub: claims.sub || 'user_12345',
    email: claims.email || 'test@example.com',
    name: claims.name || 'Test User',
    roles: claims.roles || ['http://purl.imsglobal.org/vocab/lis/v2/institution/person#Student'],
    context_id: claims.context_id || 'course_001',
    context_label: claims.context_label,
    ...claims,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signature = crypto
    .createHmac('sha256', CONFIG.LTI_SIGNING_KEY)
    .update(signingInput)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  return `${signingInput}.${signature}`;
}

async function callExchange(token) {
  const startTime = Date.now();
  try {
    const response = await fetchFn(`${CONFIG.VAULTAU_URL}${CONFIG.EXCHANGE_ENDPOINT}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handoffToken: token }),
    });

    const duration = Date.now() - startTime;
    const body = await response.json().catch(() => ({}));

    return {
      status: response.status,
      duration,
      body,
      success: response.status === 200,
    };
  } catch (err) {
    return {
      status: 0,
      duration: Date.now() - startTime,
      body: { error: err.message },
      success: false,
    };
  }
}

function logResult(category, test) {
  const status = test.passed === null ? '⏭️' : (test.passed ? '✅' : '❌');
  console.log(`${status} ${category}: ${test.name} — ${test.message}`);
  if (!test.passed && test.details) {
    console.log(`   Details: ${test.details}`);
  }
}

function uniqueEmail(prefix) {
  const suffix = Date.now().toString(36);
  return `${prefix}+${suffix}@example.com`;
}

/**
 * ─────────────────────────────────────────────────────────────
 * TEST SUITES
 * ─────────────────────────────────────────────────────────────
 */

async function runLaunchTests() {
  console.log('\n📋 LAUNCH TESTS\n');
  let passed = 0;

  // Test 1.1: Valid token, standard learner
  {
    const token = generateHandoffToken({
      sub: 'alice_learner_001',
      email: uniqueEmail('alice.learner'),
      name: 'Alice Learner',
      roles: ['http://purl.imsglobal.org/vocab/lis/v2/institution/person#Student'],
      context_id: 'course_001',
      context_label: 'MATH101',
    });
    const result = await callExchange(token);
    const test = {
      name: 'L1.1 – New LTI Learner',
      passed: result.status === 200 && result.body.customToken,
      message: `Status ${result.status}, Duration ${result.duration}ms`,
      details: result.body.failureStep || result.body.errorMessage || result.body.errorCode || result.body.error || null,
    };
    RESULTS.launchTests.push(test);
    logResult('Launch', test);
    if (test.passed) passed++;
  }

  // Test 1.2: Valid token, instructor role
  {
    const token = generateHandoffToken({
      sub: 'bob_instructor_001',
      email: uniqueEmail('bob.instructor'),
      name: 'Bob Instructor',
      roles: ['http://purl.imsglobal.org/vocab/lis/v2/institution/person#Instructor'],
      context_id: 'course_001',
    });
    const result = await callExchange(token);
    const test = {
      name: 'L1.2 – New LTI Instructor',
      passed: result.status === 200 && result.body.customToken,
      message: `Status ${result.status}, Duration ${result.duration}ms`,
      details: result.body.failureStep || result.body.errorMessage || result.body.errorCode || result.body.error || null,
    };
    RESULTS.launchTests.push(test);
    logResult('Launch', test);
    if (test.passed) passed++;
  }

  // Test 1.3: Same token twice (jti replay check would fail in Phase 6)
  {
    const token = generateHandoffToken({
      sub: 'charlie_learner_001',
      email: uniqueEmail('charlie.learner'),
      name: 'Charlie Learner',
    });
    const result1 = await callExchange(token);
    const result2 = await callExchange(token);
    // Both should succeed in Phase 3 (jti replay prevention not yet implemented)
    const test = {
      name: 'L1.3 – Token Reuse (Currently Allowed)',
      passed: result1.status === 200 && result2.status === 200,
      message: `First: ${result1.status}, Second: ${result2.status}`,
      details: 'Note: jti replay prevention implemented in Phase 6',
    };
    RESULTS.launchTests.push(test);
    logResult('Launch', test);
    if (test.passed) passed++;
  }

  // Test 1.4: Admin role
  {
    const token = generateHandoffToken({
      sub: 'admin_user_001',
      email: uniqueEmail('admin.user'),
      name: 'Admin User',
      roles: ['http://purl.imsglobal.org/vocab/lis/v2/institution/person#Administrator'],
    });
    const result = await callExchange(token);
    const test = {
      name: 'L1.4 – New LTI Admin',
      passed: result.status === 200 && result.body.user?.ltiRole === 'admin',
      message: `Status ${result.status}, Role: ${result.body.user?.ltiRole || 'N/A'}`,
      details: result.body.failureStep || result.body.errorMessage || result.body.errorCode || result.body.error || null,
    };
    RESULTS.launchTests.push(test);
    logResult('Launch', test);
    if (test.passed) passed++;
  }

  // Test 1.5: Multiple courses (same user, different contexts)
  {
    const multiEmail = uniqueEmail('multi.course');
    const token1 = generateHandoffToken({
      sub: 'multi_course_user',
      email: multiEmail,
      name: 'Multi User',
      context_id: 'course_001',
    });
    const token2 = generateHandoffToken({
      sub: 'multi_course_user',
      email: multiEmail,
      name: 'Multi User',
      context_id: 'course_002',
    });
    const result1 = await callExchange(token1);
    const result2 = await callExchange(token2);
    const test = {
      name: 'L1.5 – Multiple Courses',
      passed: result1.status === 200 && result2.status === 200,
      message: `Course 1: ${result1.status}, Course 2: ${result2.status}`,
    };
    RESULTS.launchTests.push(test);
    logResult('Launch', test);
    if (test.passed) passed++;
  }

  // Test 1.6: Minimal token (only required claims)
  {
    const token = generateHandoffToken({
      sub: 'minimal_user',
      email: uniqueEmail('minimal.user'),
      name: 'Minimal User',
      roles: [],
    });
    const result = await callExchange(token);
    const test = {
      name: 'L1.6 – Minimal Token',
      passed: result.status === 200,
      message: `Status ${result.status}`,
    };
    RESULTS.launchTests.push(test);
    logResult('Launch', test);
    if (test.passed) passed++;
  }

  RESULTS.summary.launchTestsPassed = passed;
  RESULTS.summary.launchTestsTotal = RESULTS.launchTests.length;
  console.log(`\n→ Launch Tests: ${passed}/${RESULTS.launchTests.length} passed\n`);
}

async function runNegativeTests() {
  console.log('\n⚠️  NEGATIVE TESTS\n');
  let passed = 0;

  // Test 2.1: Expired token
  {
    const token = generateHandoffToken(
      { sub: 'expired_user', email: uniqueEmail('expired.user') },
      -3600  // Expired 1 hour ago
    );
    const result = await callExchange(token);
    const test = {
      name: 'N2.1 – Expired Token',
      passed: result.status === 401 && result.body.error === 'handoff_token_expired',
      message: `Status ${result.status}, Error: ${result.body.error}`,
    };
    RESULTS.negativeTests.push(test);
    logResult('Negative', test);
    if (test.passed) passed++;
  }

  // Test 2.2: Bad signature
  {
    const token = generateHandoffToken({ sub: 'user1' });
    const tamperedToken = token.slice(0, -10) + 'xxxxxxxxxx';
    const result = await callExchange(tamperedToken);
    const test = {
      name: 'N2.2 – Bad Signature',
      passed: result.status === 401 && result.body.error === 'invalid_handoff_signature',
      message: `Status ${result.status}, Error: ${result.body.error}`,
    };
    RESULTS.negativeTests.push(test);
    logResult('Negative', test);
    if (test.passed) passed++;
  }

  // Test 2.3: Wrong audience
  {
    const token = generateHandoffToken({
      sub: 'wrong_aud_user',
      email: uniqueEmail('wrong.audience'),
      aud: 'wrong-audience',
    });
    const result = await callExchange(token);
    const test = {
      name: 'N2.3 – Wrong Audience',
      passed: result.status === 401 && result.body.error === 'handoff_audience_mismatch',
      message: `Status ${result.status}, Error: ${result.body.error}`,
      details: result.body.errorMessage || result.body.errorCode || null,
    };
    RESULTS.negativeTests.push(test);
    logResult('Negative', test);
    if (test.passed) passed++;
  }

  // Test 2.4: Missing claims
  {
    const noSubToken = generateHandoffToken({ sub: null, email: uniqueEmail('missing.sub') });
    const result = await callExchange(noSubToken);
    const test = {
      name: 'N2.4 – Missing Required Claims',
      passed: result.status === 400 && result.body.error === 'missing_required_claims',
      message: `Status ${result.status}, Error: ${result.body.error}`,
      details: result.body.errorMessage || result.body.errorCode || result.body.missingClaims?.join(', ') || null,
    };
    RESULTS.negativeTests.push(test);
    logResult('Negative', test);
    if (test.passed) passed++;
  }

  // Test 2.5: Invalid JSON body
  {
    const result = await fetchFn(`${CONFIG.VAULTAU_URL}${CONFIG.EXCHANGE_ENDPOINT}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handoffToken: null }),
    }).then(r => ({ status: r.status })).catch(e => ({ status: 0 }));
    
    const test = {
      name: 'N2.5 – Invalid Request Body',
      passed: result.status === 400,
      message: `Status ${result.status}`,
    };
    RESULTS.negativeTests.push(test);
    logResult('Negative', test);
    if (test.passed) passed++;
  }

  RESULTS.summary.negativeTestsPassed = passed;
  RESULTS.summary.negativeTestsTotal = RESULTS.negativeTests.length;
  console.log(`\n→ Negative Tests: ${passed}/${RESULTS.negativeTests.length} passed\n`);
}

async function runPerformanceTests() {
  console.log('\n⚡ PERFORMANCE TESTS\n');

  // Test 3.3: Exchange endpoint latency
  const timings = [];
  const iterations = 20;

  console.log(`Running ${iterations} exchange calls...`);
  for (let i = 0; i < iterations; i++) {
    const token = generateHandoffToken({ sub: `perf_user_${i}` });
    const result = await callExchange(token);
    if (result.success) {
      timings.push(result.duration);
    }
  }

  timings.sort((a, b) => a - b);
  const hasSamples = timings.length > 0;
  const p50 = hasSamples ? timings[Math.floor(timings.length * 0.50)] : null;
  const p95 = hasSamples ? timings[Math.floor(timings.length * 0.95)] : null;
  const p99 = hasSamples ? timings[Math.floor(timings.length * 0.99)] : null;
  const avg = hasSamples ? (timings.reduce((a, b) => a + b, 0) / timings.length) : null;

  console.log(`Exchange Latency:
  p50: ${p50}ms
  p95: ${p95}ms
  p99: ${p99}ms
  avg: ${avg === null ? 'N/A' : `${avg.toFixed(0)}ms`}`);

  RESULTS.performanceTests.push({
    name: 'Exchange Endpoint Latency',
    metrics: { p50, p95, p99, avg },
    targets: { p50: 250, p95: 500, p99: 800 },
    passed: hasSamples && p95 < 500 && p99 < 800,
  });

  console.log(`\n→ Performance Tests: Exchange p95=${p95 === null ? 'N/A' : `${p95}ms`} (target: <500ms)\n`);
}

async function runRegressionTests() {
  console.log('\n🔄 REGRESSION TESTS\n');
  let passed = 0;

  // Test 4.1: Exchange endpoint responds
  const result = await fetchFn(`${CONFIG.VAULTAU_URL}${CONFIG.EXCHANGE_ENDPOINT}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handoffToken: 'invalid' }),
  }).then(r => r.status).catch(() => 0);

  const test = {
    name: 'R4.1 – Exchange Endpoint Responsive',
    passed: result > 0 && result !== 500,
    message: `Status: ${result > 0 ? result : 'Error'}`,
  };
  RESULTS.regressionTests.push(test);
  logResult('Regression', test);
  if (test.passed) passed++;

  RESULTS.summary.regressionTestsPassed = passed;
  RESULTS.summary.regressionTestsTotal = RESULTS.regressionTests.length;
  console.log(`\n→ Regression Tests: ${passed}/${RESULTS.regressionTests.length} passed\n`);
}

/**
 * ─────────────────────────────────────────────────────────────
 * MAIN EXECUTION
 * ─────────────────────────────────────────────────────────────
 */

async function runAllTests() {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  PHASE 3: DUAL-LOGIN RELIABILITY TEST HARNESS');
  console.log('═══════════════════════════════════════════════════════════\n');

  await runLaunchTests();
  await runNegativeTests();
  await runPerformanceTests();
  await runRegressionTests();

  // Summary
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  SUMMARY');
  console.log('═══════════════════════════════════════════════════════════\n');

  const totalTests = RESULTS.launchTests.length + RESULTS.negativeTests.length + RESULTS.regressionTests.length;
  const totalPassed = (RESULTS.summary.launchTestsPassed || 0) +
                      (RESULTS.summary.negativeTestsPassed || 0) +
                      (RESULTS.summary.regressionTestsPassed || 0);

  console.log(`Total Tests: ${totalPassed}/${totalTests}`);
  console.log(`\nLaunch Tests: ${RESULTS.summary.launchTestsPassed}/${RESULTS.summary.launchTestsTotal}`);
  console.log(`Negative Tests: ${RESULTS.summary.negativeTestsPassed}/${RESULTS.summary.negativeTestsTotal}`);
  console.log(`Performance Tests: ${RESULTS.performanceTests.map(t => t.passed ? '✅' : '❌').join(', ')}`);
  console.log(`Regression Tests: ${RESULTS.summary.regressionTestsPassed}/${RESULTS.summary.regressionTestsTotal}`);

  const decision = totalPassed === totalTests ? '✅ GO' : '❌ NO-GO';
  console.log(`\nDecision: ${decision}\n`);

  // Write results to file
  fs.writeFileSync('phase3-results.json', JSON.stringify(RESULTS, null, 2));
  console.log('Results saved to: phase3-results.json\n');
}

// Run if executed directly
if (require.main === module) {
  runAllTests().catch(err => {
    console.error('Test harness error:', err);
    process.exit(1);
  });
}

module.exports = {
  runAllTests,
  generateHandoffToken,
  callExchange,
};
