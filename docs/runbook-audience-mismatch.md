# Runbook: Audience Mismatch

**Symptom:** LTI exchange failures show `handoff_audience_mismatch` error for all requests.

**Root Cause:** `LTI_HANDOFF_AUDIENCE` value differs between Bridge and VaultAU.

---

## Quick Fix (2 minutes)

### Step 1: Verify Audience Mismatch
```bash
# Get Bridge audience:
railway env list | grep LTI_HANDOFF_AUDIENCE
# Output: LTI_HANDOFF_AUDIENCE=vaultau.app

# Get VaultAU audience:
netlify env:list --scope production | grep LTI_HANDOFF_AUDIENCE
# Output: LTI_HANDOFF_AUDIENCE=app.vaultau.com
# ^ DIFFERENT! This is the issue.
```

### Step 2: Understand Correct Audience
- The audience should be the **domain/client ID that VaultAU accepts**
- Usually: Your base URL or Netlify site name
- Config: Checked in `netlify/functions/lti-session-exchange.js` (line ~30):
  ```javascript
  const expectedAudience = process.env.LTI_HANDOFF_AUDIENCE || 'vaultau.app';
  if (aud !== expectedAudience) {
    return { statusCode: 401, body: JSON.stringify({ error: 'handoff_audience_mismatch' }) };
  }
  ```

### Step 3: Update Bridge to Match VaultAU
```bash
# Use VaultAU value as source of truth:
VAULTAU_AUD=$(netlify env:list --scope production | grep LTI_HANDOFF_AUDIENCE | cut -d'=' -f2)
railway env set LTI_HANDOFF_AUDIENCE "$VAULTAU_AUD"
railway restart
```

### Step 4: Verify
- Test exchange: `node tests/phase3-test-harness.js` (expect 6/6 launch tests pass)
- Check Sentry: Error rate should drop to <1% within 1 min

---

## If Still Failing

1. **Check Moodle LTI tool configuration:**
   - Moodle admin → LTI Providers → VaultAU LTI tool
   - Look for configured "audience" or "client_id" field in tool settings
   - Ensure Bridge generates tokens with same audience claim

2. **Check recent config changes:**
   ```bash
   # Did audience get changed recently?
   git log -p netlify/functions/lti-session-exchange.js | grep -A5 -B5 "expectedAudience"
   ```

3. **If audience changed intentionally, update all systems:**
   - New audience = `new.vaultau.domain`
   - Set in Bridge: `railway env set LTI_HANDOFF_AUDIENCE=new.vaultau.domain`
   - Set in VaultAU: `netlify env:set LTI_HANDOFF_AUDIENCE=new.vaultau.domain`
   - Set in Moodle LTI tool config
   - Restart all: `railway restart && netlify deploy --prod`

4. **If unsure, use default:**
   ```bash
   # Remove custom audience, use default
   railway env unset LTI_HANDOFF_AUDIENCE
   netlify env:unset LTI_HANDOFF_AUDIENCE --scope production
   railway restart && netlify deploy --prod
   ```

---

## Prevention

- **Never change audience** without coordinating across Bridge, VaultAU, and Moodle config
- **Document audience choice** in Phase 7 runbook setup
- **Test audience changes on staging** before production

