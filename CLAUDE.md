# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout

This is a monorepo containing two git submodules and a shared Python virtualenv:

| Path | Repo | Role |
|------|------|------|
| `flashcard-backend/` | `dananap/lla-backend` | FastAPI REST API (Python) |
| `flashcard-frontend/` | `dananap/lla-frontend` | Vue 3 + TypeScript SPA |
| `venv/` | — | Shared Python virtualenv (not committed) |

Each submodule has its own `CLAUDE.md` with detailed commands and architecture. Read those first when working inside a submodule.

## Running the full stack

### With Docker (production-like)

```bash
docker compose up --build
# Frontend served by Nginx on http://localhost:8088
# Backend only reachable internally (no host port mapping)
```

### Locally for development

Start both processes independently:

```bash
# Terminal 1 — backend
cd flashcard-backend
uvicorn main:app --reload --port 8000

# Terminal 2 — frontend
cd flashcard-frontend
pnpm dev   # http://localhost:5173, proxies /api/* → localhost:8000
```

## Submodule workflow

```bash
# After cloning, initialise submodules
git submodule update --init --recursive

# Pull latest upstream changes for both submodules
git submodule update --remote

# Commit a submodule pointer bump from the root
git add flashcard-backend flashcard-frontend
git commit -m "bump submodule refs"
```


## Deploying to GCP (Cloud Run + Firebase Hosting)

```bash
bash deploy.sh   # reads flashcard-backend/.env + flashcard-frontend/.env.local; deploys backend to Cloud Run, frontend to Firebase Hosting
```

**Prerequisites:**
- `gcloud` CLI authenticated; `GCP_PROJECT` / `GCP_REGION` defaults: `baistudy` / `europe-west3`
- `firebase-tools` installed (`npm install -g firebase-tools`) and logged in (`firebase login`)
- `flashcard-frontend/.env.local` with Firebase web app config (see frontend env vars below)

To enable new user signups during a deploy: `VITE_ALLOW_SIGNUP=true bash deploy.sh`

## Environment variables

The backend reads from `flashcard-backend/.env`. Required keys:

| Variable | Used by |
|----------|---------|
| `DEEPSEEK_API_KEY` | LLM word generation |
| `UNSPLASH_ACCESS_KEY` | Word image search |
| `GOOGLE_APPLICATION_CREDENTIALS` | Google Cloud / Gemini TTS |

The frontend reads from `flashcard-frontend/.env.local` (not committed). Required keys:

| Variable | Used by |
|----------|---------|
| `VITE_FIREBASE_API_KEY` | Firebase Auth |
| `VITE_FIREBASE_AUTH_DOMAIN` | Firebase Auth (default: `baistudy.firebaseapp.com`) |
| `VITE_FIREBASE_PROJECT_ID` | Firebase Auth (default: `baistudy`) |
| `VITE_ALLOW_SIGNUP` | Set `true` to show "Create account" tab; omit to hide it |

## Architecture overview

In development, Vite proxies `/api/*` → `http://localhost:8000` (stripping the `/api` prefix). In production, the frontend is a static SPA hosted on Firebase Hosting and calls the Cloud Run backend directly via `VITE_API_BASE` with a Firebase ID token in the `Authorization: Bearer` header.

The backend is stateless between requests; all study state lives in PostgreSQL (`DATABASE_URL`). Authentication uses Firebase ID tokens — `deps.py` verifies the token, then looks up or auto-creates the corresponding `User` row by `firebase_uid`.

See `flashcard-backend/CLAUDE.md` for the full data model, FSRS algorithm details, and router map. See `flashcard-frontend/CLAUDE.md` for the Pinia store layout, design-token system, and component conventions.
