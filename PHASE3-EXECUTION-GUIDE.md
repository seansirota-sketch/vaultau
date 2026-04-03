# Phase 3: Execution Quick Start

**Status**: Ready to execute  
**Duration**: 1 day (8 hours)  
**Environment**: Deploy Preview #67 + Moodle Sandbox  

---

## What is Phase 3?

Validate that both web and LTI login flows work perfectly together:
- ✅ 6 launch tests (new users, returning users, multiple roles, multiple courses)
- ✅ 6 negative tests (expired tokens, bad signatures, wrong audience)
- ✅ 3 performance tests (measure latency p95)
- ✅ 2 regression tests (ensure no breaking changes)

**Go/No-Go Decision**: After tests, decide whether to proceed to Phase 4 or rollback

---

## Quick Start (30 minutes)

### Step 1: Setup Environment

```bash
cd c:\Users\User\Documents\vaultau

# Verify Deploy Preview is live
curl -I https://deploy-preview-67--vaultau.netlify.app

# Install test dependencies
npm install node-fetch  # For test harness

# Verify Moodle sandbox accessible
curl -I https://sandbox.moodledemo.net
```

### Step 2: Run Automated Tests (5 minutes)

```bash
# Execute full test suite
node tests/phase3-test-harness.js

# Expected output: Summary with GO/NO-GO decision
# Results saved to: phase3-results.json
```

### Step 3: Manual Verification (10 minutes)

**Browser Session 1: LTI Launch**
```
1. Open https://sandbox.moodledemo.net
2. Sign in as alice_learner (password: TestPass123$)
3. Go to MATH101 course → Click "Launch VaultAU"
4. Verify: Dashboard loads, navbar shows "[Learner] [via Moodle]"
5. Open DevTools → Console: check for errors (should be none)
```

**Browser Session 2: Web Login**
```
1. Open https://deploy-preview-67--vaultau.netlify.app
2. Sign up: eve@test.local (new user)
3. Verify: Navbar shows email only (no roles, no Moodle badge)
4. Sign out and sign back in
5. Verify: Same behavior (no errors, login works)
```

### Step 4: Review Results (5 minutes)

```bash
# View automated test results
cat phase3-results.json | jq '.summary'

# Expected output:
# {
#   "launchTestsPassed": 6,
#   "launchTestsTotal": 6,
#   "negativeTestsPassed": 6,
#   "negativeTestsTotal": 6,
#   "regressionTestsPassed": 2,
#   "regressionTestsTotal": 2
# }
```

---

## Test Suite Overview

### Launch Tests (6 scenarios)
- L1.1: New LTI learner
- L1.2: New LTI instructor  
- L1.3: Returning LTI user (no duplicate)
- L1.4: New LTI admin
- L1.5: Multiple courses (same user)
- L1.6: Minimal token (only required claims)

**Target**: 6/6 pass

### Negative Tests (6 scenarios)
- N2.1: Expired token (401)
- N2.2: Bad signature (401)
- N2.3: Wrong audience (401) - requires special setup
- N2.4: Missing claims (400)
- N2.5: Invalid body (400)
- N2.6: LTI disabled (403) - requires env toggle

**Target**: ≥5/6 pass

### Performance Tests (3 metrics)
- P3.1: LTI handoff latency p95 < 2000ms
- P3.2: Email login latency p95 < 1500ms
- P3.3: Exchange endpoint p95 < 500ms

**Target**: All metrics pass

### Regression Tests (2 scenarios)
- R4.1: Email/password login unchanged
- R4.2: No console errors during auth

**Target**: 2/2 pass

---

## Go/No-Go Decision

After all tests complete, check this matrix:

### ✅ GO (Proceed to Phase 4)
- All 18 tests pass
- p95 latency on target
- Zero console errors
- Zero Firestore permission errors

**Action**: Proceed to Phase 4 – Authorization Enforcement

### 🟡 GO with Fixes
- 1–2 tests failing (non-critical)
- Minor latency overage
- Specific known issue to fix

**Action**: Fix in ~30 min, re-run harness, then Phase 4

### ❌ NO-GO (Rollback)
- >2 tests failing
- Systematic errors
- Latency >2.5s for LTI / >2s for email
- Auth or Firestore errors

**Action**:
```bash
# 1. Immediate rollback (1 min):
# Netlify Dashboard → Deploy Preview #67 → Environment
# Set: LTI_ENTRY_ENABLED = false
# (Users can still sign in with email/password)

# 2. Investigate root cause
# 3. Fix in staging + re-test
# 4. Retry Phase 3 in 2 hours
```

---

## Execution Checklist

**Before Starting**:
- [ ] Deploy Preview #67 deployed and live
- [ ] Netlify functions responding (check Network tab)
- [ ] Firestore rules deployed
- [ ] Moodle sandbox accessible
- [ ] Bridge/tunnel running
- [ ] Test data seeded (test users in Moodle)
- [ ] Fresh Firestore state (no stale test data)

**During Testing**:
- [ ] Run automated harness
- [ ] Monitor console for errors
- [ ] Record timing data
- [ ] Test both auth flows

**After Testing**:
- [ ] Compile results
- [ ] Make go/no-go decision
- [ ] Document decision rationale
- [ ] Update Phase 3 document with results
- [ ] Brief stakeholders

---

## Common Issues & Fixes

### Issue: Exchange endpoint returns 500
**Diagnosis**: Firebase service account misconfigured  
**Fix**: Check Netlify env vars for FIREBASE_SERVICE_ACCOUNT

### Issue: p95 latency > 2s
**Diagnosis**: Bridge slow or distant  
**Fix**: Check bridge logs, consider moving to Railway/Fly.io

### Issue: LTI tests fail but web login works
**Diagnosis**: Likely issue in exchange function or JWT validation  
**Fix**: Check handoffToken claim validation, check custom claims setting

### Issue: Console shows "Cannot read property 'ltiRole' of undefined"
**Diagnosis**: Firestore user doc not written correctly  
**Fix**: Check that lti-session-exchange.js successfully writes to Firestore

### Need Rollback?
```bash
# Set flag to disable LTI (email login still works):
# Netlify Dashboard → Env Vars → LTI_ENTRY_ENABLED = false
# Redeploy: Automatic (usually <2 min)
```

---

## Success Metrics Summary

| Metric | Target | Pass/Fail |
|--------|--------|-----------|
| Launch tests pass rate | 100% (6/6) | ⬜ |
| Negative tests pass rate | ≥83% (5/6) | ⬜ |
| LTI latency p95 | <2000ms | ⬜ |
| Email latency p95 | <1500ms | ⬜ |
| Exchange endpoint p95 | <500ms | ⬜ |
| Console errors | 0 | ⬜ |
| Firestore permission errors | 0 | ⬜ |

---

## Next Steps (After Phase 3)

### If GO:
→ Proceed to **Phase 4: Authorization Enforcement**
- Implement role-based access checks
- Add Firestore audit logging
- Test instructor/learner/admin permissions

### If NO-GO:
→ **Fix & Retry**
1. Disable LTI feature flag
2. Diagnose issue in staging
3. Repeat Phase 3 testing

---

## Files & References

- **Test Harness**: `tests/phase3-test-harness.js`
- **Full Test Plan**: See Obsidian – Phase 3 document
- **Bridge Code**: See lti-tool repository
- **Production Plan**: VaultAU – LTI Production Execution Plan.md
- **Exchange Function**: `netlify/functions/lti-session-exchange.js`

---

**Ready to execute Phase 3? Start with:**
```bash
node tests/phase3-test-harness.js
```

---

Last Updated: April 3, 2026
