# Phase 7 Checklist: Observability & Incident Runbook

**Phase:** 7 (Observability & Incident Runbook)  
**Duration:** Days 13–14  
**Status:** Runbook documentation complete; Sentry setup guide ready

---

## Tasks Overview

| Task | Owner | Duration | Status | Docs |
|------|-------|----------|--------|------|
| ✅ Write incident runbook | SRE | 3h | **DONE** | [LTI-INCIDENT-RESPONSE.md](./LTI-INCIDENT-RESPONSE.md) |
| ✅ Create diagnostic sub-runbooks | SRE | 2h | **DONE** | [runbook-*.md](./runbook-key-mismatch.md) |
| 📋 Set up Sentry error tracking | DevOps | 2h | **IN PROGRESS** | [SENTRY-SETUP.md](./SENTRY-SETUP.md) |
| 📋 Configure alerting rules | DevOps | 2h | **TODO** | See SENTRY-SETUP.md Step 4 |
| 📋 Set up Slack + email alerts | DevOps | 1h | **TODO** | See SENTRY-SETUP.md Step 5 |
| 📋 Conduct runbook drill | SRE/DevOps | 2h | **TODO** | See Drill Plan below |

---

## Completed Deliverables ✅

### 1. Main Incident Runbook
**File:** [docs/LTI-INCIDENT-RESPONSE.md](./LTI-INCIDENT-RESPONSE.md)

**Contents:**
- Triage procedure (5 min)
- Root cause diagnosis for 4 common scenarios
- Mitigation steps for each scenario
- Emergency rollback procedure (1 min)
- Recovery steps
- Key metrics reference
- On-call contact info

**Usage:** Print or bookmark; follow when `LTI Auth Error Rate > 5%` alert fires.

---

### 2. Diagnostic Sub-Runbooks

#### [runbook-key-mismatch.md](./runbook-key-mismatch.md)
**Problem:** `handoff_token_expired` or `invalid_handoff_signature` on all requests  
**Solution:** Compare Bridge + VaultAU signing keys; sync if different  
**Time:** 2 min fix, <5 min full diagnosis

#### [runbook-audience-mismatch.md](./runbook-audience-mismatch.md)
**Problem:** `handoff_audience_mismatch` error  
**Solution:** Compare `LTI_HANDOFF_AUDIENCE` across Bridge, VaultAU, Moodle  
**Time:** 2 min fix

#### [runbook-quota-exceeded.md](./runbook-quota-exceeded.md)
**Problem:** `lti_exchange_error` + Firestore quota >90%  
**Solution:** Upgrade to Blaze tier, or reduce test volume, or wait for reset  
**Time:** 2-5 min fix + monitoring

#### [runbook-crash.md](./runbook-crash.md)
**Problem:** Random errors; Bridge process repeatedly restarting  
**Solution:** Check logs, restart Bridge, check recent deployments, rollback if needed  
**Time:** 1-5 min diagnosis, cold restart is fastest

---

## In Progress: Sentry Setup 📋

**What:** Deploy error tracking to Bridge + VaultAU  
**Why:** Catch LTI errors in production before users are blocked  
**Cost:** Free tier sufficient (<5K events/month)

**Next Steps:**
1. Follow [SENTRY-SETUP.md](./SENTRY-SETUP.md) Step 1 → Create Sentry account + 2 projects
2. Follow Steps 2–3 → Add SDKs to Bridge + VaultAU
3. Follow Steps 4–5 → Configure alerts + Slack
4. Follow Step 6 → Test integration
5. Follow Step 7 → Document credentials

**Time Estimate:** ~30 minutes  
**Expected state after:** All LTI errors logged to Sentry; Slack alerts working

---

## Remaining Tasks (Phase 7)

### Task A: Set Up Sentry (NOW)
**Prerequisite:** Have Sentry account ready  
**Steps:**
1. Create Sentry account at https://sentry.io/signup/
2. Create 2 projects: `LTI Bridge`, `LTI VaultAU`
3. Follow [SENTRY-SETUP.md](./SENTRY-SETUP.md) section by section
4. Test: Run Phase 3 harness, confirm Sentry captures no errors (normal operation)

**Success Criteria:**
- [ ] Sentry dashboard accessible with data flowing in
- [ ] Test error from Bridge visible in Sentry within 5 sec
- [ ] Test error from VaultAU visible in Sentry within 5 sec
- [ ] Slack alert fires and appears in `#lti-alerts`

---

### Task B: Set Up Alerting Rules (AFTER Sentry)

**Configuration targets:**

1. **High Error Rate Alert**
   - Trigger: Error count > 10 in 5 minutes (any project)
   - Action: Slack message to `#lti-alerts`
   - Escalation: If unresolved in 10 min → page on-call

2. **Quota Exceeded Alert**
   - Trigger: Error contains `firestore_quota` or `quota_exceeded`
   - Action: Slack + email
   - Mitigation: See [runbook-quota-exceeded.md](./runbook-quota-exceeded.md)

3. **Bridge Down Alert**
   - Trigger: No exchange requests for 5 minutes (health check)
   - Action: Slack + email + wake up on-call
   - Mitigation: See [runbook-crash.md](./runbook-crash.md)

**Time:** ~30 min to configure all rules in Sentry

---

### Task C: Runbook Drill (AFTER Alerting)

**Objective:** Verify all runbook steps are executable in <30 min  
**Scenario:** Simulate "high error rate" alert

**Drill Plan:**

1. **Setup (5 min)**
   - Have Sentry dashboard open
   - Have runbook [LTI-INCIDENT-RESPONSE.md](./LTI-INCIDENT-RESPONSE.md) open
   - Have 2 people: SRE (diagnoses) + DevOps (executes mitigations)

2. **Simulate Outage (5 min)**
   - Change Bridge signing key intentionally (break it)
   - Run Phase 3 harness → expect 401 errors
   - Wait for Sentry alert to fire + Slack notification
   - Record time until alert fire (should be <2 min)

3. **Follow Runbook Triage (5 min)**
   - Open [LTI-INCIDENT-RESPONSE.md](./LTI-INCIDENT-RESPONSE.md) Step 1
   - Check Sentry dashboard (confirm `invalid_handoff_signature` errors)
   - Check Bridge logs
   - Diagnose: "Signing key mismatch"

4. **Execute Mitigation (3 min)**
   - Open [runbook-key-mismatch.md](./runbook-key-mismatch.md)
   - Sync signing keys between Bridge + VaultAU
   - Restart Bridge
   - Verify: Run harness again → 6/6 pass

5. **Verify Recovery (2 min)**
   - Check Sentry: Error rate drops to 0
   - Check Slack: No more alerts
   - Document: "Incident resolved in 15 min"

**Success Criteria:**
- [ ] All runbook steps executable in <30 min
- [ ] Alert fires within 2 min of simulated outage
- [ ] Root cause identified in <5 min
- [ ] Mitigation restores service in <3 min
- [ ] Slack notifications helpful (not too noisy, not too sparse)

---

## State of LTI Implementation After Phase 7

### Deployed Changes
```
Main Branch (main):
  ✅ Phase 1: Identity setup
  ✅ Phase 2: Profile persistence + auth origin
  ✅ Phase 3: Dual-login reliability (6/6 tests pass)
  ✅ Phase 4: Role-based authorization
  ✅ Phase 5: 24/7 bridge hosting + rollback + errors
  ✅ Phase 6: Replay protection + time validation

Feature Branch (feat/lti-entry-implementation):
  ✅ All Phase 2–6 code merged
  ✅ PR #67 ready for review/merge

Production Ready (via Phase 7):
  ✅ Error tracking (Sentry)
  ✅ Alerting (Slack + email)
  ✅ Incident runbook (5 pages + diagnostic sub-runbooks)
  ✅ On-call procedures documented
```

### Metrics Monitored
- LTI handoff exchange success rate (target: >99%)
- Exchange latency p95 (target: <500ms on preview, <250ms on production)
- Bridge uptime (target: >99.9%)
- Firestore quota usage (target: <80%)
- Error breakdown by type (expired, signature, audience, quota, etc.)

### Operational Readiness
- [ ] Sentry dashboard live
- [ ] Slack alerts configured
- [ ] Runbook accessible to on-call team
- [ ] On-call schedule published
- [ ] Emergency rollback mechanism tested (flip `LTI_ENTRY_ENABLED=false`)
- [ ] Runbook drill completed successfully

---

## After Phase 7: What's Next?

### Phase 8 (Not Started): Production Rollout
- [ ] Update Moodle production LTI tool configuration
- [ ] Switch traffic from preview/staging to production Railway bridge
- [ ] Monitor production metrics for 24 hours
- [ ] Celebrate! 🎉

### Optional Optimizations
- [ ] Reduce exchange latency to <250ms (requires production profiling)
- [ ] Auto-scale Bridge based on request volume
- [ ] Add more granular metrics (per-Moodle-instance, per-role, etc.)

---

## Files in This Phase

```
docs/
  ├── LTI-INCIDENT-RESPONSE.md      (Main runbook - 5 pages)
  ├── runbook-key-mismatch.md        (Sub-runbook: Signing keys)
  ├── runbook-audience-mismatch.md   (Sub-runbook: Audience claim)
  ├── runbook-quota-exceeded.md      (Sub-runbook: Firestore quota)
  ├── runbook-crash.md               (Sub-runbook: Process crashes)
  ├── SENTRY-SETUP.md                (Integration guide - 7 steps)
  └── PHASE-7-CHECKLIST.md           (This file)
```

---

## Quick Reference

### Emergency Contacts
- **On-Call SRE:** [Add to runbook]
- **DevOps Lead:** [Add to runbook]
- **Moodle Admin:** [Add to runbook]

### Emergency Rollback (1 minute)
```bash
# Disable LTI via Netlify UI:
# Settings → Build & Deploy → Environment
# LTI_ENTRY_ENABLED = false
# → Save → Redeploy
```

### Quick Diagnosis
1. Check error rate: [Sentry dashboard](https://[YOUR_SENTRY_ORG].sentry.io/)
2. Filter by error type (expired, signature, audience, quota, other)
3. Open corresponding sub-runbook
4. Follow 2-min fix
5. Verify via harness or reload page

---

**Status:** Phase 7 runbook documentation ✅ COMPLETE  
**Next Action:** Follow SENTRY-SETUP.md to deploy error tracking

