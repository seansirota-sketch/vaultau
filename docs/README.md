# VaultAU Documentation Index

## LTI Integration (Phases 2–6)

Complete LTI 1.3 implementation for Moodle integration.

### Getting Started
- [LTI Bridge Contract](./lti-bridge-contract.md) — Token format & signing specification
- [Allowed Issuers & Audiences](./lti-env-plan.md) — Configuration for trusted Moodle instances
- [Test Matrix](./lti-test-matrix.md) — Test scenarios & expected outcomes

### Implementation References
- [Baseline Checklist](./lti-baseline-checklist.md) — Pre-rollout verification (before production)

### Operations & Support

#### Incident Response
- [LTI Incident Response Runbook](./LTI-INCIDENT-RESPONSE.md) — **START HERE** if LTI is broken
  - Triage procedure (5 min)
  - Diagnosis & mitigation step-by-step
  - Emergency rollback procedure

#### Diagnostic Sub-Runbooks
- [Signing Key Mismatch](./runbook-key-mismatch.md) — `handoff_token_expired` or `invalid_handoff_signature`
- [Audience Mismatch](./runbook-audience-mismatch.md) — `handoff_audience_mismatch` error
- [Firestore Quota](./runbook-quota-exceeded.md) — `lti_exchange_error` + quota issues
- [Process Crashes](./runbook-crash.md) — Random errors or Bridge restarting constantly

#### Monitoring Setup (Phase 7 — Optional)
- [Sentry Integration Guide](./SENTRY-SETUP.md) — Deploy error tracking (30 min setup)
- [Phase 7 Checklist](./PHASE-7-CHECKLIST.md) — Observability & incident runbook tasks

---

## Quick Reference

### What is the LTI integration?
VaultAU can now authenticate users via **Moodle LTI 1.3**, allowing Moodle students to log in directly without needing a separate email/password account.

### Key Files
- **LTI Exchange Function:** `netlify/functions/lti-session-exchange.js` — Converts Moodle handoff tokens to VaultAU Firebase tokens
- **Role Authorization:** `netlify/edge-functions/parse-exam.js`, `generate-question.js` — Instructor/admin-only endpoints
- **Profile Persistence:** `course.js` → `maybeBootstrapLtiSession()` — Creates user profile on first LTI login
- **Bridge Service:** lti-tool on Railway — Signs handoff tokens for Moodle

### Environment Variables (VaultAU Production)
```
LTI_ENTRY_ENABLED = true|false          # Feature flag for LTI entry
LTI_HANDOFF_SIGNING_KEY = [base64key]   # Shared secret with Bridge
LTI_HANDOFF_AUDIENCE = vaultau.app      # Expected audience claim
LTI_ALLOWED_ISSUERS = moodle.uni.edu   # Allowed Moodle instance URL(s)
```

### Testing
Run Phase 3 test harness to validate LTI exchange:
```bash
$env:LTI_HANDOFF_SIGNING_KEY="[YOUR_KEY]"; node tests/phase3-test-harness.js
# Expected: 6/6 launch tests pass
```

---

## Architecture

```
Moodle (Sandbox or Production)
    ↓ User clicks "Enter VaultAU"
    ↓ Sends OAuth 2.0 POST to lti-tool Bridge
Railway Bridge (lti-tool)
    ↓ Validates Moodle identity
    ↓ Generates JWT handoff token (signed with shared key)
VaultAU
    ↓ netlify/functions/lti-session-exchange.js
    ↓ Verifies handoff token signature
    ↓ Creates Firebase custom token
    ↓ Bootstraps user profile in Firestore
    ↓ Returns custom token to client
Course Page
    ↓ User logged in as LTI learner/instructor/admin
    ↓ Can browse, search, take quizzes, etc.
```

---

## Production Readiness

**Phase 6 Status:** ✅ Complete
- All LTI exchanges functional (6/6 test harness pass)
- Role-based authorization enforced
- Replay protection + time validation active
- Error handling + user-friendly messages
- Firestore security rules updated

**Before Production Moodle Rollout:**
- [ ] Review [Baseline Checklist](./lti-baseline-checklist.md)
- [ ] Test LTI launch from Moodle sandbox
- [ ] Verify signing key matches between Bridge + VaultAU
- [ ] Monitor Firestore quota usage (should be <80%)
- [ ] Have [Incident Runbook](./LTI-INCIDENT-RESPONSE.md) accessible to on-call team

**Optional:** Set up Sentry monitoring (see [Phase 7 Guide](./PHASE-7-CHECKLIST.md))

---

## Support

- 🐛 **LTI is broken?** Follow [LTI-INCIDENT-RESPONSE.md](./LTI-INCIDENT-RESPONSE.md)
- 🤔 **Questions about token format?** See [lti-bridge-contract.md](./lti-bridge-contract.md)
- 📊 **Want error monitoring?** See [SENTRY-SETUP.md](./SENTRY-SETUP.md)
- ✅ **Ready for production?** Check [lti-baseline-checklist.md](./lti-baseline-checklist.md)

