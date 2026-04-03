# LTI Integration Incident Response Runbook

**Last Updated:** 2026-04-03  
**Severity:** Critical (blocks Moodle users from accessing VaultAU)  
**Owner:** On-call SRE/DevOps  
**Response Target:** Triage in 5 min, resolved in 10 min

---

## Alert: "LTI Auth Error Rate > 5%"

### Step 1: Triage (5 minutes)

**Goal:** Identify the type of failure and confirm scope.

#### 1.1 Check Sentry Dashboard
- **URL:** [Sentry LTI Project](https://[YOUR_SENTRY_ORG].sentry.io/projects/vaultau-lti/)
- **Filter:** `environment:production` | `last 1 hour`
- **Look for:**
  - Error rate spike (should be <0.5% normally)
  - Top errors by frequency:
    - `handoff_token_expired` → Signing key issue
    - `invalid_handoff_signature` → Bridge key mismatch
    - `handoff_audience_mismatch` → Audience config issue
    - `lti_exchange_error` + Firebase errors → Firestore quota
    - Random errors (different types) → Process crash

#### 1.2 Check Bridge Logs
- **SSH into Railway bridge:**
  ```bash
  railway logs -f
  ```
- **Look for patterns:**
  - Repeated 400/500 responses
  - Firebase connection errors (quota, permission denied)
  - Process restarts (crash loop)

#### 1.3 Check Firestore Status
- **Firebase Console:** [VaultAU Firebase](https://console.firebase.google.com/project/vaultau)
- **Check:**
  - Firestore quota usage (should be <80%)
  - Write latency (should be <100ms p95)
  - Recent permission errors in audit logs

#### 1.4 Check VaultAU Function Logs
- **Netlify Dashboard:** `vaultau` project → `Functions` → `lti-session-exchange`
- **Look for:** Last 50 errors, group by error type

---

## Step 2: Diagnosis & Mitigation

### Scenario 1: All errors are "handoff_token_expired"

**Likely Cause:**
- Bridge and VaultAU have different signing keys
- High clock skew between systems (>60 seconds)

**Diagnosis:**
```bash
# On Railway bridge:
echo $LTI_HANDOFF_SIGNING_KEY
# Compare with VaultAU Netlify:
# Settings → Build & Deploy → Environment
```

**Mitigation:**
1. Compare keys. If different, update one to match the other.
2. Check system clocks:
   ```bash
   # Bridge
   date -u
   # VaultAU (Netlify) - check Sentry event timestamps
   ```
3. Restart bridge:
   ```bash
   railway restart
   ```

**→ See detailed runbook:** [docs/runbook-key-mismatch.md](./runbook-key-mismatch.md)

---

### Scenario 2: All errors are "handoff_audience_mismatch"

**Likely Cause:**
- LTI_HANDOFF_AUDIENCE value changed in bridge or VaultAU

**Diagnosis:**
```bash
# Check bridge audience:
railway env list | grep LTI_HANDOFF_AUDIENCE
# Check VaultAU audience:
# Netlify UI → Settings → Environment → LTI_HANDOFF_AUDIENCE
```

**Mitigation:**
1. Ensure both systems have identical `LTI_HANDOFF_AUDIENCE` value (usually `vaultau.app` or `[YOUR_DOMAIN]`)
2. If changed, update bridge:
   ```bash
   railway env set LTI_HANDOFF_AUDIENCE=vaultau.app
   railway restart
   ```
3. Verify audience in next exchange request

**→ See detailed runbook:** [docs/runbook-audience-mismatch.md](./runbook-audience-mismatch.md)

---

### Scenario 3: 50% failures with "lti_exchange_error" + Firebase errors

**Likely Cause:**
- Firestore quota exceeded
- Firestore permission issue (new collection not in rules)

**Diagnosis:**
```bash
# Check Firestore quota:
# Firebase Console → Storage → Quotas tab
# Look for: Read/Write operations approaching limit

# Check recent Firestore rules changes:
# Firebase Console → Firestore Database → Rules tab
```

**Mitigation:**
1. **If quota exceeded:**
   - Reduce test volume if in testing phase
   - Upgrade Firestore tier (if on Spark free tier)
   - Check for errant loops writing repeatedly

2. **If permission denied:**
   - Verify `lti_users` and `lti_handoff_jtis` collections exist in rules
   - Rule should allow admin writes to those collections

3. **If still failing:**
   - Rollback recent code changes (see Emergency Rollback below)

**→ See detailed runbook:** [docs/runbook-quota-exceeded.md](./runbook-quota-exceeded.md)

---

### Scenario 4: Errors are random types; bridge process repeatedly restarting

**Likely Cause:**
- Bridge process crashing (OutOfMemory, uncaught exception)
- VaultAU function crash (too many simultaneous requests)

**Diagnosis:**
```bash
# Check bridge uptime:
railway status
# If uptime <5 min, process is restarting

# Check bridge memory:
railway logs -f | grep -i memory

# Check VaultAU function errors:
# Netlify Logs → lti-session-exchange
```

**Mitigation:**
1. **Restart bridge:**
   ```bash
   railway restart
   ```
2. **Monitor for 2 min:** Does it crash again?
3. **If crashes persist:**
   - Check recent code deployments
   - Rollback if needed
   - File emergency rollback (see below)

**→ See detailed runbook:** [docs/runbook-crash.md](./runbook-crash.md)

---

## Step 3: Emergency Rollback (1 minute)

**If unresolved in 10 minutes → disable LTI immediately.**

### 3.1 Disable LTI at VaultAU

**Via Netlify UI (fastest):**
1. Go to: `vaultau` project → Settings → Build & Deploy → Environment
2. Find: `LTI_ENTRY_ENABLED`
3. Change value: `true` → `false`
4. Save
5. **Trigger deploy:** Go to Deployments → trigger a new deploy (or just redeploy current version)

**Via CLI:**
```bash
netlify env:set LTI_ENTRY_ENABLED false --scope production
netlify deploy --prod
```

### 3.2 Verify Fallback Working
- Test email/password login at app
- Check Sentry: Should see zero `lti_*` errors
- Check Netlify logs: No more exchange failures

### 3.3 Communication

**Slack (immediate):**
```
@channel LTI feature temporarily disabled pending diagnostics.
Email/password login unaffected. ~5 min incident, investigating root cause.
```

**Moodle (update banner):**
- Log in to Moodle admin
- Dashboard → Message on upcoming courses
- Or send email: "VaultAU LTI temporarily unavailable. Please log in using web email: [url]"

### 3.4 Root Cause Analysis (after stability restored)

Collect diagnostics and file incident report:
- [ ] Bridge logs (last 100 errors before disable)
- [ ] Firestore slow logs
- [ ] Recent code deployments to bridge or VaultAU
- [ ] Timeline: When did error rate spike?
- [ ] Was there a config change, deployment, or external event?

---

## Step 4: Recovery (after root cause identified)

### Re-enable LTI
1. Apply fix (e.g., update signing key, rebuild bridge, etc.)
2. Test exchange on staging/preview
3. Verify: Run `node tests/phase3-test-harness.js` with correct signing key (expect 6/6 pass)
4. Re-enable: `LTI_ENTRY_ENABLED=true` and deploy
5. Monitor Sentry for 15 min: Error rate should drop to <1%

---

## Reference: Key Environment Variables

| Variable | Location | Purpose |
|----------|----------|---------|
| `LTI_HANDOFF_SIGNING_KEY` | Bridge (Railway) + VaultAU (Netlify) | HMAC signing key for token verification |
| `LTI_HANDOFF_AUDIENCE` | Bridge (Railway) + VaultAU (Netlify) | Expected audience claim in token |
| `LTI_ENTRY_ENABLED` | VaultAU (Netlify) | Feature flag; set to `false` to disable LTI entry |
| `MOODLE_PLATFORM_URL` | Bridge (Railway) | Moodle instance URL (for logging) |
| `FIREBASE_SERVICE_ACCOUNT` | Bridge (Railway) + VaultAU (Netlify) | Firebase admin credentials |

---

## Reference: Key Metrics

| Metric | Target | Alert Threshold |
|--------|--------|-----------------|
| LTI Exchange Success Rate | >99% | <95% (i.e., >5% error rate) |
| Exchange Latency (p95) | <500ms (preview), <250ms (prod) | >3s |
| Bridge Uptime | >99.9% | Downtime >5 min |
| Firestore Quota Usage | <80% | >90% |

---

## Runbook Sub-Pages

- [docs/runbook-key-mismatch.md](./runbook-key-mismatch.md) — Signing key debugging
- [docs/runbook-audience-mismatch.md](./runbook-audience-mismatch.md) — Audience claim issues
- [docs/runbook-quota-exceeded.md](./runbook-quota-exceeded.md) — Firestore quota exhaustion
- [docs/runbook-crash.md](./runbook-crash.md) — Process crashes and instability

---

## Contact & Escalation

- **On-Call SRE:** [Link to on-call schedule]
- **Moodle Admin:** [Contact info]
- **DevOps Lead:** [Contact info]
- **Escalation:** If unresolved in 30 min, page on-call engineer immediately.

---

**Last Tested:** 2026-04-03 (Runbook drill passed in 18 min)
