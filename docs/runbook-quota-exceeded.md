# Runbook: Firestore Quota Exceeded

**Symptom:** LTI exchange failures show `lti_exchange_error` + error mentions "quota" or "permission denied" in logs.

**Root Cause:** Firestore quota exceeded (read/write operations), or Firestore rules blocking writes to LTI collections.

---

## Quick Diagnosis (5 minutes)

### Step 1: Check Firestore Quota Usage
```bash
# Go to Firebase Console:
# vaultau project → Storage → Quotas tab

# Look for:
# - Daily Write Quota: X% of limit (if >80%, likely issue)
# - Daily Read Quota: Y% of limit
# - Document Create Operations: Z/24h

# If >90% of any quota, you're quota-limited
```

### Step 2: Check Recent Firestore Activity
```bash
# Firebase Console → Firestore Database → Requests tab
# Filter by: Last 24h
# Look for: Spike in write operations (should be ~10/min, not 1000/min)
```

### Step 3: Check Firestore Rules
```bash
# Firebase Console → Firestore Database → Rules tab
# Verify `lti_users` and `lti_handoff_jtis` collections are writable by admin or service account
# Rule should look like:
match /lti_users/{document=**} {
  allow write: if isAdmin();  // or request.auth != null
}
match /lti_handoff_jtis/{document=**} {
  allow write: if isAdmin();
}
```

---

## Quick Fixes (2-5 minutes, in order)

### Option 1: Upgrade Firestore (if on Spark/Free tier)
```bash
# Firebase Console → Storage → Plan
# Change: Spark (free, limited 50K read/day) → Blaze (pay-as-you-go, no limits)
# Time: ~2 min
# Cost: Should be negligible if LTI traffic is reasonable (~1K exchanges/day = <$0.10/day)
```

### Option 2: Check for Errant Write Loop
```bash
# Sentry → Errors → Filter by `lti_exchange_error`
# Look at error details:
# - Is error happening once per request? (normal)
# - Or hundreds of times per single request? (errant loop)

# If loop detected in code:
git log --oneline -20 netlify/
# Rollback recent changes:
git revert [recent-commit]
git push
```

### Option 3: Clear Quota by Reducing Test Volume
```bash
# If in testing phase with harness:
# Don't run 1000s of test exchanges simultaneously
# Slow down: Add delay between requests
# Or disable tests until quota resets (midnight UTC)
```

### Option 4: Verify Firestore Rules Are Correct
```bash
# If rules show "write blocked", update:
firebase deploy --only firestore:rules
# (This redeploys rules from firestore.rules file in repo)
```

---

## If Still Quota-Limited After Upgrades

1. **Wait for midnight UTC quota reset:**
   - Quotas reset every 24h UTC at 00:00
   - If you hit quota at 11pm UTC, only 1 hour until reset

2. **Temporarily disable LTI:**
   - Set `LTI_ENTRY_ENABLED=false` to stop exchanges
   - Allows Firestore quota to recover
   - Users use email/password login instead

3. **File incident review:**
   - Why did quota spike? 
   - Was there a legitimate surge in LTI signups?
   - Or errant code loop?
   - If legitimate, Blaze tier cost should be justified

---

## Prevention

- **Monitor quota usage daily:**
  - Set Sentry alert for Firestore write operations >500/min
  - Set dashboard widget for quota usage >70%

- **Set aggressive quotas if using Spark tier:**
  - Firestore → Settings → Quotas → Set soft limits
  - Alert when soft limit hit (before hard limit causes outages)

- **Review Firestore indexes:**
  - Some query patterns create too many indexes
  - Firebase Console → Firestore Database → Indexes
  - Delete unused indexes to reduce quota usage

- **Batch LTI writes where possible:**
  - Instead of writing `authMethods` as separate collection, consider adding to user doc
  - Reduces write operation count

