# VaulTau — Exam Bank for TAU Students

[![Netlify Status](https://api.netlify.com/api/v1/badges/YOUR_BADGE_ID/deploy-status)](https://app.netlify.com/sites/vaultau/deploys)

> A exam archive for Tel Aviv University students. Browse, search, and filter past exams by course — all in one place.

🔗 **Live site:** [vaultau.netlify.app](https://vaultau.netlify.app)

<!-- SCREENSHOT: Replace the line below with a real screenshot -->
<!-- ![VaulTau App Screenshot](./docs/screenshot.png) -->

---
## Table of Contents

- [Features](#features)
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

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla JavaScript, HTML, CSS |
| Hosting | [Netlify](https://netlify.com) |
| Database | [Firebase Firestore](https://firebase.google.com/docs/firestore) |
| Storage | [Firebase Storage](https://firebase.google.com/docs/storage) (exam PDFs) |
| Auth | [Firebase Authentication](https://firebase.google.com/docs/auth) |
| Serverless Functions | [Netlify Functions](https://docs.netlify.com/functions/overview/) |
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
├── netlify/                # Netlify serverless functions (Claude AI)
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

## Deployment

The project auto-deploys to Netlify on every push to `main`.

---

---

<p align="center">Built with ❤️ for TAU students</p>