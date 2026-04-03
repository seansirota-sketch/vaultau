# Runbook: Process Crash or Instability

**Symptom:** LTI errors are random/varied, OR Bridge process repeatedly restarting (uptime <5 min), OR high latency spikes.

**Root Cause:** Bridge process crash (OutOfMemory, uncaught exception), VaultAU function timeout, or too many simultaneous requests.

---

## Quick Diagnosis (3 minutes)

### Step 1: Check Bridge Uptime
```bash
# SSH into Railway console:
railway status

# Output example:
# Service: lti-tool
# Status: running
# Uptime: 2 weeks 3 days
# ^ Good, not crashing

# vs.

# Uptime: 3 minutes
# ^ Bad, process restarted recently
```

### Step 2: Check Bridge Logs for Crashes
```bash
railway logs -f | head -100
# Look for:
# - FATAL errors
# - OutOfMemory (heap allocation failed)
# - Uncaught exceptions
# - Segmentation faults

# Example crash pattern:
# [INFO] Starting LTI tool server
# [INFO] Listening on port 3000
# [ERROR] Unhandled exception in token signing
# [ERROR] Cannot read property 'sub' of undefined
# [FATAL] Process exiting with code 1
# [INFO] Starting LTI tool server  <-- immediate restart
```

### Step 3: Check VaultAU Function Logs
```bash
# Netlify UI → vaultau project → Functions → lti-session-exchange
# Filter: Last 50 errors
# Look for: Function timeouts (>26 sec), memory errors, crashes

# Or via CLI:
netlify logs --function=lti-session-exchange --limit=50
```

### Step 4: Check for Memory Leaks
```bash
# Bridge memory usage:
railway env list | grep -i memory

# VaultAU memory (Netlify is limited to 3GB per function):
# Netlify UI → Logs → Runtime errors section
```

---

## Quick Fixes (1-5 minutes, in order)

### Option 1: Restart Bridge (cold restart)
```bash
railway restart
# Wait 30 seconds
# Check status:
railway status | grep Uptime
# If uptime <1 min again, proceed to Option 2
```

### Option 2: Check Recent Deployments
```bash
# Bridge recent deployments:
railway logs --limit 20 | grep -i "deploy\|push"
# Example: "Deployed commit abc123 at 2026-04-03 13:45:00"

# If deployed in last 30 min AND errors started after deployment, rollback:
railway rollback
```

### Option 3: Scale Up Bridge Resources
```bash
# If Bridge is hitting memory limit:
# Railway dashboard → Environment → Settings → Resources
# Increase: CPU (increment by 0.1) or Memory (add 256MB)
# Restart:
railway restart
```

### Option 4: Check for Infinite Loops in Code
```bash
# Look at recent commits:
git log --oneline -10 netlify/

# Did any recent commit add a loop or recursive call?
git diff [commit1] [commit2] -- netlify/functions/lti-session-exchange.js
# Look for: while(true), recursive calls without base case, promise chains without await

# If found, revert:
git revert [problematic-commit]
git push
```

### Option 5: Check for Coroutine Pool Exhaustion
```bash
# If Bridge uses async/await without proper concurrency limits:
# Example problem:
// BAD: Creates 1000 simultaneous Firebase operations
let exchangeRequests = [];
for (let i = 0; i < 1000; i++) {
  exchangeRequests.push(firestore.collection('lti_users').add(...));
}
await Promise.all(exchangeRequests);

# Look for this pattern in code, add concurrency limit:
// GOOD: Limits to 10 simultaneous operations
const pLimit = require('p-limit');
const limit = pLimit(10);
let exchangeRequests = [];
for (let i = 0; i < 1000; i++) {
  exchangeRequests.push(limit(() => firestore.collection('lti_users').add(...)));
}
await Promise.all(exchangeRequests);
```

---

## If Still Crashing After All Fixes

1. **Enable verbose logging temporarily:**
   ```bash
   railway env set LOG_LEVEL=DEBUG
   railway restart
   # Tail logs for 5 min:
   railway logs -f --since 0m --until 5m > /tmp/debug.log
   # Analyze: cat /tmp/debug.log | grep -i error
   ```

2. **Check external service health:**
   - Is Firebase/Firestore down? (check [Firebase Status](https://status.firebase.google.com/))
   - Is Moodle sandbox responding? (test curl)
   - Is network connectivity broken? (test ping from Railway)

3. **If issue persists, escalate to emergency rollback:**
   - Set `LTI_ENTRY_ENABLED=false` in VaultAU
   - Users fall back to email/password login
   - File incident report with crash logs for post-mortem

---

## Prevention

- **Add structured logging:**
  ```javascript
  // In lti-tool:
  console.log(JSON.stringify({ 
    level: 'info', 
    message: 'Exchange request received', 
    iss, sub, aud, timestamp: new Date().toISOString() 
  }));
  ```
  - Makes crash patterns easier to spot

- **Set up memory limits:**
  - Railway → Environment → Set memory limit to 512MB
  - If process exceeds, it restarts (easier to detect than silent memory leak)

- **Add integration tests to CI/CD:**
  - Before deployment, run Phase 3 harness against Bridge
  - Catches crashes before production

- **Monitor uptime:**
  - Set Sentry alert: "Bridge uptime <1 hour"
  - If uptime keeps resetting, you have a crash loop

