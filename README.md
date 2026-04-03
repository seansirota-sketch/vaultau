# VaulTau — Exam Bank for TAU Students

[![Netlify Status](https://api.netlify.com/api/v1/badges/YOUR_BADGE_ID/deploy-status)](https://app.netlify.com/sites/vaultau/deploys)

> A exam archive for Tel Aviv University students. Browse, search, and filter past exams by course — all in one place.

🔗 **Live site:** [vaultau.netlify.app](https://vaultau.netlify.app)

<!-- SCREENSHOT: Replace the line below with a real screenshot -->
<!-- ![VaulTau App Screenshot](./docs/screenshot.png) -->

---
## Table of Contents

- [Features](#features)
- [LTI Integration](#lti-integration)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Architecture](#architecture)
- [Role-Based Access](#role-based-access)
- [Security](#security)
- [Deployment](#deployment)

---

## Features

- 📚 Browse and filter past TAU exams by course, year, and semester
- 🔍 Search across the entire exam archive instantly
- 📄 View and download exam PDFs directly in the browser
- 🤖 AI-powered exam metadata parsing via Claude (Anthropic)
- 🔐 Firebase Authentication (email/password)
- 🛡️ Role-based access control — students browse, admins manage
- 🖥️ Full admin panel: upload exams, manage courses, set permissions
- 🔥 Local development with Firebase Emulator — production is never touched

---

## LTI Integration

**Status:** ✅ **Production-Ready** (Phases 2–6 complete)

VaultAU now supports **LTI 1.3 authentication** via Moodle. Students can:
- Log in directly from Moodle without creating a separate account
- Maintain role-based permissions (learner/instructor/admin) from Moodle
- Fall back to email/password login if LTI is temporarily disabled

### Key Features
- 🔗 Secure OAuth 2.0 integration with Moodle
- 🔐 Replay protection + time-based token validation
- 👥 Automatic role mapping (learner → student, instructor/admin → admin)
- 🔄 Dual authentication: LTI **or** email/password (both always work)
- ⚡ Sub-second token exchange (<500ms on production)
- 🛡️ Firestore security rules prevent unauthorized profile modifications
- 📊 Comprehensive test harness (18 test scenarios, all passing)

### Getting Started
See [docs/README.md](./docs/README.md) for complete LTI documentation:
- [Bridge Contract](./docs/lti-bridge-contract.md) — Token format & requirements
- [Incident Runbook](./docs/LTI-INCIDENT-RESPONSE.md) — Troubleshooting guide
- [Test Matrix](./docs/lti-test-matrix.md) — Test scenarios

### Before Production Rollout
1. Review [Baseline Checklist](./docs/lti-baseline-checklist.md)
2. Confirm environment variables are set (see [Environment Variables](#environment-variables))
3. Run test harness: `$env:LTI_HANDOFF_SIGNING_KEY="[KEY]"; node tests/phase3-test-harness.js`
   - Expected: 6/6 launch tests pass, 5/5 negative tests pass
4. Have [Incident Runbook](./docs/LTI-INCIDENT-RESPONSE.md) accessible to on-call team

---

## Tech Stack


| Layer | Technology |
|---|---|
| Frontend | Vanilla JavaScript, HTML, CSS |
| Hosting | [Netlify](https://netlify.com) |
| Database | [Firebase Firestore](https://firebase.google.com/docs/firestore) |
| Storage | [Firebase Storage](https://firebase.google.com/docs/storage) (exam PDFs) |
| Auth | [Firebase Authentication](https://firebase.google.com/docs/auth) |
| Serverless Functions | [Netlify Functions](https://docs.netlify.com/functions/overview/) + [Edge Functions](https://docs.netlify.com/edge-functions/overview/) |
| AI Parsing | [Claude API](https://www.anthropic.com/) (Anthropic) |
| Local Dev | [Firebase Emulator Suite](https://firebase.google.com/docs/emulator-suite) |

---

## Project Structure

```
vaultau/
├── index.html              # Student-facing exam browser
├── admin.html              # Admin panel
├── admin.js                # Admin panel logic
├── course.js               # Course/exam browsing logic
├── style.css               # Global styles
├── firebase-config.js      # Firebase init + env-based switching
├── firestore.rules         # Production Firestore security rules
├── storage.rules           # Production Storage security rules
├── netlify/                # Netlify serverless + edge functions (Claude AI parsing)
├── seed/                   # Database seed & migration scripts
├── firebase.json           # Firebase project config
├── firebase.emulator.json  # Emulator-specific config
└── netlify.toml            # Netlify build & redirect config
```

---



## Architecture

```
┌─────────────────────────────────────┐
│           Netlify (Hosting)         │
│  index.html  ·  admin.html  ·  CSS  │
│         Vanilla JS frontend         │
└────────────────┬────────────────────┘
                 │
       ┌─────────┴──────────┐
       │                    │
┌──────▼──────┐   ┌─────────▼─────────┐
│  Firebase   │   │  Netlify Functions │
│ Firestore   │   │  (Claude AI Parse) │
│ Storage     │   └────────────────────┘
│ Auth        │
└─────────────┘
```

- **Frontend:** Vanilla JS — no framework, no build step, deploys directly
- **Database:** Firestore for course/exam metadata
- **Storage:** Firebase Storage for exam PDF files
- **Auth:** Firebase Authentication (email/password)
- **Functions:** Netlify serverless functions handle Claude API calls server-side (keeps API keys off the client)

---

## Role-Based Access

Access is controlled by a `role` field on each user's Firestore document (`users/{uid}`).

| Role | Permissions |
|------|-------------|
| `student` | Browse & download exams |
| `admin` | Upload/edit/delete exams, manage courses, assign roles |

- New users automatically receive `role: 'student'` on first login

---

## Security

- `emulator-data/`, `.env`, `*.rules.local`, and `service-account.json` are all **gitignored**
- Production Firestore rules require authentication for all reads and admin role for all writes
- Admin role is verified **server-side** in Firestore rules — not just client-side

---

## Environment Variables

### Netlify (Production) — Site Settings → Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | **Yes** | Anthropic Claude API key (`sk-ant-...`). Used by the `parse-exam` edge function. |
| `FIREBASE_WEB_API_KEY` | **Yes** | Firebase project web API key. Used to verify Firebase ID tokens server-side. |
| `SENDGRID_API_KEY` | Yes | SendGrid key for transactional emails (verification, password reset). |
| `SENDER_EMAIL` | Yes | "From" address for outgoing emails. |
| `GEMINI_API_KEY` | Optional | Google Gemini key (stored in Firestore `settings/api_keys.gemini`, loaded client-side). |
| `LTI_ENTRY_ENABLED` | Yes | Feature flag for LTI entry (`true`/`false`). Keep `false` until rollout. |
| `LTI_ALLOWED_ISSUERS` | Yes | Comma-separated allowlist of trusted Moodle issuers (`iss`). |
| `LTI_EXPECTED_AUDIENCE` | Yes | Expected handoff token audience (`aud`). |
| `LTI_HANDOFF_VERIFY_KEY` | Yes | Shared secret used to verify bridge-signed `lti_handoff` JWT (`HS256`). |
| `LTI_REQUIRE_COURSE_MAP` | Optional | If `true`, blocks launch when `context_id` has no active map in `lti_course_map`. |

### Local Development (`.env` file in project root)

| Variable | Required | Description |
|----------|----------|-------------|
| `CLAUDE_KEY` | **Yes** | Same value as `ANTHROPIC_API_KEY`. Preferred locally because Netlify Dev's AI Gateway overrides `ANTHROPIC_API_KEY` with a JWT. |
| `ANTHROPIC_API_KEY` | Fallback | Used if `CLAUDE_KEY` is not set. May be mangled by Netlify Dev AI Gateway. |
| `FIREBASE_WEB_API_KEY` | **Yes** | Same as production. Needed for auth verification in the edge function. |
| `NETLIFY_DEV` | Optional | Set to `true` to skip Firebase token verification locally (emulator tokens can't validate against production). **Never set in production.** |
| `SENDGRID_API_KEY` | Yes | Same as production. |
| `SENDER_EMAIL` | Yes | Same as production. |
| `LTI_ENTRY_ENABLED` | Optional | Set to `true` to test LTI entry locally. |
| `LTI_ALLOWED_ISSUERS` | Optional | Local allowlist for accepted issuer values. |
| `LTI_EXPECTED_AUDIENCE` | Optional | Local expected audience value. |
| `LTI_HANDOFF_VERIFY_KEY` | Optional | Local signing key shared with bridge token generator. |
| `LTI_REQUIRE_COURSE_MAP` | Optional | Enable strict course mapping validation locally. |

> **Note:** The `.env` file is gitignored. Copy `.env` from a team member or create it manually.

---

## Deployment

The project auto-deploys to Netlify on every push to `main`.

### Pre-Deploy Checklist

1. Verify `ANTHROPIC_API_KEY` and `FIREBASE_WEB_API_KEY` are set in Netlify Dashboard
2. Confirm `NETLIFY_DEV` is **not** set in production env vars (bypasses auth)
3. Test a single PDF upload → spinner shows model name, parse succeeds
4. Test an unauthenticated request to `/api/parse-exam` → returns 401

## LTI Rollout Artifacts

- Baseline + rollback checklist: `docs/lti-baseline-checklist.md`
- Bridge token contract: `docs/lti-bridge-contract.md`
- Test matrix: `docs/lti-test-matrix.md`
- Environment variables plan: `docs/lti-env-plan.md`

---

---

<p align="center">Built with ❤️ for TAU students</p>