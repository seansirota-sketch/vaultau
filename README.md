
follow this flow in the pdf to install the emulator - https://drive.google.com/file/d/1p__LqvVg8e-2BXFK6hxlGNzr4R3XSr86/view?usp=sharing

# VaulTau — Exam Bank for TAU Students

A Firebase-backed exam bank app for Tel Aviv University students. Students can browse and filter past exams; admins can upload, manage, and set permissions.

---

## Architecture

- **Frontend:** Vanilla JS, hosted on Netlify
- **Database:** Firebase Firestore
- **Storage:** Firebase Storage (exam PDFs)
- **Auth:** Firebase Authentication
- **Functions:** Netlify Functions (Claude AI exam parsing)
- **Admin access:** Role-based (`role` field on user document — `admin` or `student`)

---

## Role-Based Admin System

Admin access is controlled by a `role` field on each user's Firestore document (`users/{uid}`).

- New users automatically get `role: 'student'` on first login
- Admins have `role: 'admin'` set manually in Firestore (or via migration script)
- There are no hardcoded admin email lists anywhere in the code
- Firestore security rules enforce `isAdmin()` server-side using the role field

To grant admin access: go to Firebase Console → Firestore → `users` collection → find the user doc → set `role` to `admin`.

---

## Local Development Setup (Sterile Environment)

A safe local environment that mirrors production. All database operations stay on your machine — the live site is never affected.

### Prerequisites

| Tool | Install |
|------|---------|
| Node.js | [nodejs.org](https://nodejs.org/) |
| Java JDK 11+ | [Adoptium](https://adoptium.net/) |
| Firebase CLI | `npm install -g firebase-tools` |
| Netlify CLI | `npm install -g netlify-cli` |

### First-Time Setup

1. Clone the repo and `cd` into it
2. `npm install`
3. `firebase login`
4. `netlify login`
5. `netlify env:pull` (downloads API keys into `.env` — requires Netlify project access)

### Running Locally

Open **two terminals** in the project root:

**Terminal 1 — Firebase Emulator:**
```
npm run emulator
```

**Terminal 2 — Netlify Dev (website + functions):**
```
npm run dev
```

Open **localhost:8888/admin.html** in your browser. You'll see an orange banner confirming you're in the safe local environment.

### Seeding the Local Database

The first time you run the emulator (or after wiping `emulator-data/`), seed it with test data:

```
npm run seed
```

This creates:
- 2 sample courses (Mathematics, Computer Science)
- 10 Hebrew exam documents
- 3 test users: `admin@admin.com` (admin), `student@tau.ac.il` (student), `student2@tau.ac.il` (student)

Password for all seed users: `password123`

### How It Works

- `localhost` → all reads/writes go to the local Firebase Emulator
- `vaultau.netlify.app` → all reads/writes go to real production Firebase
- Switching is **automatic** based on hostname — no manual steps
- Emulator uses open security rules (`*.rules.local`) so local dev is frictionless
- Production uses strict Firestore rules (committed as `firestore.rules`)
- Emulator data is saved to `emulator-data/` when you Ctrl+C and restored on next startup
- The Claude exam parsing API works locally via Netlify Dev

### When You're Done Editing

Once you're happy with a course or exam in the local environment, open the **live admin panel** (`vaultau.netlify.app/admin.html`) and add the final version there.

---

## Security

- `emulator-data/`, `.env`, `*.rules.local`, and `service-account.json` are all gitignored
- Production Firestore rules require authentication for all reads and admin role for all writes
- Admin role is verified server-side in Firestore rules (not just client-side)
- The Claude API is the only thing that hits the internet locally (uses real Anthropic credits)

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm run emulator` | Start Firebase Emulator with local rules and saved data |
| `npm run dev` | Start Netlify Dev server (website + functions) |
| `npm run seed` | Seed the emulator with test courses, exams, and users |
| `node seed/migrate-roles.js --dry-run` | Preview role migration (production) |
| `node seed/migrate-roles.js` | Run role migration on production (requires `service-account.json`) |
| `node seed/migrate-roles.js --emulator` | Run role migration on emulator |
