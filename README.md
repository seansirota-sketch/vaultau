# exam-bank

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

### How It Works

- `localhost` → all reads/writes go to the local Firebase Emulator
- `vaultau.netlify.app` → all reads/writes go to real production Firebase
- Switching is **automatic** based on hostname — no manual steps
- Emulator data is saved to `emulator-data/` when you Ctrl+C and restored on next startup
- The Claude exam parsing API works locally via Netlify Dev

### When You're Done Editing

Once you're happy with a course or exam in the local environment, open the **live admin panel** (`vaultau.netlify.app/admin.html`) and add the final version there.

### Notes

- `emulator-data/` and `.env` are gitignored — they stay on your machine
- The Claude API is the only thing that hits the internet locally (uses real Anthropic credits)
- If you don't need exam parsing, you can skip the Netlify CLI and just run `npm run emulator`