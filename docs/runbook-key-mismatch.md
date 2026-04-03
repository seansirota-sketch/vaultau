# Runbook: Signing Key Mismatch

**Symptom:** All LTI exchange failures show `handoff_token_expired` or `invalid_handoff_signature`

**Root Cause:** Bridge and VaultAU have different `LTI_HANDOFF_SIGNING_KEY` values, or high clock skew (>60 seconds).

---

## Quick Fix (2 minutes)

### Step 1: Verify Key Mismatch
```bash
# Get Bridge key:
railway env list | grep LTI_HANDOFF_SIGNING_KEY
# Output: LTI_HANDOFF_SIGNING_KEY=PAcVxtlroZuASUZdKmTNxkn/teHKwnSxQMLi0aSShRYJTDN9Wxus0bPlhUsG20ba

# Get VaultAU key (via Netlify UI):
# vaultau project → Settings → Build & Deploy → Environment → LTI_HANDOFF_SIGNING_KEY
# Or via CLI:
netlify env:list --scope production | grep LTI_HANDOFF_SIGNING_KEY
```

### Step 2: Compare
- If keys are **different:** Update one to match the other (use Bridge key as source of truth):
  ```bash
  BRIDGE_KEY=$(railway env list | grep LTI_HANDOFF_SIGNING_KEY | cut -d'=' -f2)
  netlify env:set LTI_HANDOFF_SIGNING_KEY "$BRIDGE_KEY" --scope production
  netlify deploy --prod
  ```

- If keys are **same:** Proceed to Step 3 (clock skew)

### Step 3: Check Clock Skew
```bash
# Bridge system time:
ssh [bridge-url] date -u
# Should show: Thu Apr 03 14:32:45 UTC 2026

# VaultAU system time:
# Check Sentry timestamps on recent events
# Should be within ±60 seconds of Bridge time
```

If clock skew >60 seconds:
- Contact Railway support (bridge clock may be drifting)
- Contact Netlify support (VaultAU clock may be drifting)
- Temporary: Increase `nbf` clock-skew tolerance in `lti-session-exchange.js` (line ~140)

### Step 4: Restart Bridge
```bash
railway restart
```

### Step 5: Verify
- Test exchange: `node tests/phase3-test-harness.js` (expect 6/6 launch tests pass)
- Check Sentry: Error rate should drop to <1% within 2 min

---

## If Still Failing

1. **Check for recent deployments:**
   ```bash
   # Bridge:
   railway logs --limit 50 | grep -i "deployed\|restart"
   
   # VaultAU:
   # Netlify UI → Deployments → Recent
   ```

2. **If recent deployment caused issue, rollback:**
   ```bash
   # Bridge:
   railway rollback
   
   # VaultAU:
   # Netlify UI → Deployments → Click previous version → Publish
   ```

3. **If still failing, escalate to emergency rollback** (see main runbook)

---

## Prevention

- Use the **current `LTI_HANDOFF_SIGNING_KEY`** as source of truth (stored in password manager or vaults)
- **Never** generate new signing keys without coordinating updates across all systems
- **Always test** key changes on staging first with harness

