# Phase 7 Setup: Sentry Error Tracking Integration

**Goal:** Set up Sentry to catch and alert on LTI errors in Bridge + VaultAU.

**Time:** ~30 minutes total  
**Cost:** Free tier sufficient for Phase 7 (<5K events/month)

---

## Step 1: Create Sentry Account (5 minutes)

1. **Sign up:**
   - Go to [sentry.io](https://sentry.io/signup/)
   - Email: [your email]
   - Create organization: `vaultau` (or your org name)
   - Create team: `lti` or `operations`

2. **Create two projects:**
   - **Project 1:** `LTI Bridge` (Node.js runtime)
   - **Project 2:** `LTI VaultAU` (Node.js runtime for Netlify)

3. **For each project:**
   - Sentry will generate a **DSN** (Data Source Name): `https://[KEY]@sentry.io/[PROJECT_ID]`
   - **Save both DSNs** to a secure location (password manager)

---

## Step 2: Add Sentry to Bridge (10 minutes)

### 2.1 Install Sentry SDK
```bash
cd /path/to/lti-tool  # Bridge repository
npm install @sentry/node
```

### 2.2 Initialize Sentry in Bridge Entry Point

**File:** `lti-tool/index.js` or `app.js` (wherever server starts)

```javascript
// At the VERY TOP, before any other code:
import * as Sentry from "@sentry/node";

Sentry.init({
  dsn: process.env.SENTRY_DSN_BRIDGE,
  environment: process.env.NODE_ENV || "development",
  tracesSampleRate: 0.1,  // Sample 10% of transactions for perf monitoring
  debug: false,
});

// Rest of your code...
const express = require('express');
const app = express();

// Add Sentry request handler EARLY in middleware chain:
app.use(Sentry.Handlers.requestHandler());

// ... your routes ...

// Add Sentry error handler AFTER routes but BEFORE 404 handler:
app.use(Sentry.Handlers.errorHandler());

// Catch-all 404:
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});
```

### 2.3 Manually Capture Errors

**File:** `lti-tool/routes/exchange.js` or similar

```javascript
import * as Sentry from "@sentry/node";

export async function handleLtiExchange(req, res) {
  try {
    const { handoffToken } = req.body;
    
    // Verify token
    const decoded = verifyJwtHs256(handoffToken);
    
    // Create Firebase custom token
    const customToken = await firebaseAdmin.auth().createCustomToken(decoded.sub);
    
    res.json({ customToken });
  } catch (error) {
    // Capture error with context:
    Sentry.captureException(error, {
      contexts: {
        lti: {
          handoffToken: handoffToken?.substring(0, 20) + '...',  // Redact for privacy
          iss: req.body.iss,
          sub: req.body.sub,
        },
      },
      level: 'error',
    });
    
    res.status(500).json({ error: 'lti_exchange_error' });
  }
}
```

### 2.4 Set Environment Variable
```bash
# On Railway:
railway env set SENTRY_DSN_BRIDGE="https://[KEY]@sentry.io/[PROJECT_ID]"

# Or via Railway dashboard:
# Environment → Variables → Add SENTRY_DSN_BRIDGE
```

### 2.5 Deploy Bridge
```bash
git add package.json package-lock.json index.js routes/exchange.js
git commit -m "feat(observability): add Sentry error tracking to bridge"
git push
railway deploy
```

### 2.6 Test Error Capturing
```bash
# On Railway, create a test error:
railway run node -e "
const Sentry = require('@sentry/node');
Sentry.init({ dsn: process.env.SENTRY_DSN_BRIDGE });
Sentry.captureException(new Error('Test error from Bridge'));
setTimeout(() => process.exit(0), 2000);
"

# Check Sentry UI:
# Your organization → LTI Bridge project → Issues
# Should see "Test error from Bridge" within 10 seconds
```

---

## Step 3: Add Sentry to VaultAU Functions (10 minutes)

### 3.1 Install Sentry SDK
```bash
cd /path/to/vaultau/netlify/functions
npm install @sentry/node
```

### 3.2 Initialize Sentry in Each Function

**File:** `netlify/functions/lti-session-exchange.js`

```javascript
// At the TOP:
const Sentry = require('@sentry/node');

Sentry.init({
  dsn: process.env.SENTRY_DSN_VAULTAU,
  environment: process.env.CONTEXT || 'development',
  tracesSampleRate: 0.1,
});

// In your handler:
exports.handler = Sentry.Handlers.wrapHandler(async (event, context) => {
  try {
    // Your exchange logic
    const customToken = await exchangeHandoffToken(event.body);
    return {
      statusCode: 200,
      body: JSON.stringify({ customToken }),
    };
  } catch (error) {
    Sentry.captureException(error, {
      contexts: {
        lti_exchange: {
          iss: event.body?.iss,
          sub: event.body?.sub,
          aud: event.body?.aud,
        },
      },
    });
    
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'lti_exchange_error' }),
    };
  }
});
```

### 3.3 Set Environment Variable
```bash
# Via Netlify UI:
# vaultau project → Settings → Build & Deploy → Environment
# Add: SENTRY_DSN_VAULTAU = https://[KEY]@sentry.io/[PROJECT_ID]

# Or via CLI:
netlify env:set SENTRY_DSN_VAULTAU "https://[KEY]@sentry.io/[PROJECT_ID]" --scope production
```

### 3.4 Deploy VaultAU
```bash
git add netlify/functions/lti-session-exchange.js package.json
git commit -m "feat(observability): add Sentry error tracking to VaultAU functions"
git push
netlify deploy --prod
```

### 3.5 Test Error Capturing
```bash
# In browser console on VaultAU:
const Sentry = require('@sentry/node');
Sentry.init({ dsn: process.env.SENTRY_DSN_VAULTAU });
Sentry.captureException(new Error('Test error from VaultAU'));

# Or trigger a real error:
# 1. Go to `course.js` maybeBootstrapLtiSession()
# 2. Purposely break token signing temporarily
# 3. Run Phase 3 harness (expect failures)
# 4. Check Sentry: Should see errors from both Bridge and VaultAU
```

---

## Step 4: Configure Sentry Dashboard (5 minutes)

### 4.1 Set Up Alerts

**In Sentry UI:**

1. Go to **Alerts** → **Create Alert Rule** → **New Alert**

2. **Alert 1: High Error Rate**
   - Conditions: `LTI Bridge` project, error count > 10 in 5 minutes
   - Actions: Send to Slack (see Step 5)

3. **Alert 2: Exchange Errors Spike**
   - Conditions: `LTI VaultAU` project, error rate increases by 50% in 10 minutes
   - Actions: Send to Slack + Email

4. **Alert 3: Critical Errors (Quota, Firebase)**
   - Conditions: Any project, issue `[lti_exchange_error, firestore_quota_exceeded]`
   - Actions: Send to Slack + Email + PagerDuty (if available)

### 4.2 Create Dashboard

**In Sentry UI:**

1. **Dashboards** → **Create New Dashboard** → Name: `LTI Operations`

2. **Add Widgets:**
   - **Errors by Type:** (Bar chart) Shows top error codes over time
   - **Error Rate:** (Time series) Shows success rate %
   - **Slowest Transactions:** (Table) Shows exchange latency
   - **Errors by Project:** (Pie chart) Bridge vs VaultAU

3. **Example query for widget:**
   ```
   transaction:lti-session-exchange
   ```

---

## Step 5: Set Up Slack Notifications (5 minutes)

### 5.1 Connect Slack to Sentry

**In Sentry UI:**

1. **Settings** → **Integrations** → **Slack**
2. **Authorize** (will prompt to connect your Slack workspace)
3. **Select channels:**
   - `#lti-alerts` (or create new channel)
   - `#operations` (optional)

### 5.2 Route Alerts to Slack

**For each alert rule (from Step 4):**

1. Edit alert → **Actions** section
2. Add: **Send Slack Message**
3. Select channel: `#lti-alerts`
4. Include context: Error type, count, project

---

## Step 6: Test Full Integration (5 minutes)

### 6.1 Simulate Error in Bridge
```bash
# SSH into Railway:
railway run node -e "
const Sentry = require('@sentry/node');
Sentry.init({ dsn: process.env.SENTRY_DSN_BRIDGE });

// Simulate an error:
Sentry.captureException(new Error('Simulated signing key mismatch'));
console.log('Error sent to Sentry');
setTimeout(() => process.exit(0), 2000);
"
```

### 6.2 Verify in Sentry
- Go to **LTI Bridge** project → **Issues**
- You should see the error appear within 5 seconds
- Check grouping: Should be deduplicated if same error appears multiple times

### 6.3 Verify Slack Notification
- Check `#lti-alerts` channel
- Alert should arrive: `[Error] Simulated signing key mismatch (LTI Bridge)`

### 6.4 Run Full Phase 3 Harness with Correct Key
```bash
$env:LTI_HANDOFF_SIGNING_KEY="PAcVxtlroZuASUZdKmTNxkn/teHKwnSxQMLi0aSShRYJTDN9Wxus0bPlhUsG20ba"; 
node tests/phase3-test-harness.js
```

- All 6/6 launch tests should pass
- Sentry error count should remain ~0 (no errors on successful exchanges)
- Slack should stay quiet (no false alarms)

---

## Step 7: Document Sentry Access

Create a **credentials document** (store securely):

```
SENTRY SETUP - LTI Integration
==============================

Organization: https://sentry.io/organizations/vaultau/
Team: lti
Owner: [your email]

Projects:
  Bridge: https://sentry.io/projects/vaultau/lti-bridge/
    DSN: https://[KEY]@sentry.io/[PROJECT_ID_BRIDGE]
    Environment: production (Railway)

  VaultAU: https://sentry.io/projects/vaultau/lti-vaultau/
    DSN: https://[KEY]@sentry.io/[PROJECT_ID_VAULTAU]
    Environment: production (Netlify)

Slack Integration:
  Channel: #lti-alerts
  Alerts configured: High error rate, quota exceeded, critical errors

On-Call Access:
  Share this doc with on-call runbook (see LTI-INCIDENT-RESPONSE.md)
```

---

## Validation Checklist

- [ ] Sentry account created with 2 projects
- [ ] Bridge has @sentry/node installed and initialized
- [ ] VaultAU has @sentry/node installed and initialized
- [ ] Both projects have SENTRY_DSN_* env vars set
- [ ] Test error from Bridge appears in Sentry UI within 5 sec
- [ ] Test error from VaultAU appears in Sentry UI within 5 sec
- [ ] Slack alert fires and appears in #lti-alerts
- [ ] Sentry dashboard created with 4+ widgets
- [ ] Phase 3 harness run shows 6/6 pass, Sentry stays quiet
- [ ] Credentials document created and shared with on-call team

---

**Next Step:** Continue to alerting rules and runbook drill (Phase 7 tasks 5-7).

