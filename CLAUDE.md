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


## Deploying (Fly.io + Cloudflare Pages + Supabase)

```bash
bash deploy.sh           # both: backend → Fly, frontend → Cloudflare Pages
bash deploy-backend.sh   # just the backend
bash deploy-frontend.sh  # just the frontend (auto-reads VITE_API_BASE from .env.local)
```

**Prerequisites:**
- `flyctl` installed and authenticated (`fly auth login`). First-time setup: `cd flashcard-backend && fly launch --no-deploy`.
- `wrangler` installed (`npm i -g wrangler`) and authenticated (`wrangler login`).
- Supabase project provisioned (see `migration/README.md`).
- `flashcard-frontend/.env.local` with the keys below.
- Backend secrets configured on Fly: `fly secrets set DATABASE_URL=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... DEEPSEEK_API_KEY=... UNSPLASH_ACCESS_KEY=... AZURE_SPEECH_KEY=... GCP_SERVICE_ACCOUNT_JSON="$(cat sa.json)"`. See `flashcard-backend/fly.toml` for the full list. User-JWT verification fetches the project's JWKS from `SUPABASE_URL/auth/v1/.well-known/jwks.json` — no shared secret needed.

To enable new user signups during a deploy: `VITE_ALLOW_SIGNUP=true bash deploy.sh`.

## Comprehensible Input (/read)

A second learning mode alongside flashcards. Users complete an onboarding placement test (`/onboarding`), then the `/read` page generates short Chinese texts calibrated to their level — targeting a configurable known-word ratio based on their flashcard deck, HSK level, and a static function-word allowlist. Texts are segmented by `ci_engine.py` (jieba) and each token is classified (mature/borderline/learning/unknown). Audio is synthesized lazily on demand and streamed with per-sentence timestamps for highlighting.

Key backend files: `ci_engine.py`, `ci_baseline.py`, `routers/ci.py`, `routers/ci_audio.py`, `routers/onboarding.py`. Frontend: `src/stores/ci.ts`, `ReadView.vue`, `ReadDetailView.vue`, `ReadOnboardingView.vue`.

## Environment variables

Backend (`flashcard-backend/.env` for local dev, `fly secrets` in prod):

| Variable | Used by |
|----------|---------|
| `DATABASE_URL` | Supabase Postgres — session pooler (supavisor, port 5432 on `aws-0-{region}.pooler.supabase.com`, `sslmode=require`) in prod. *Not* the transaction pooler on 6543 — that disables prepared statements and breaks SQLAlchemy. `database.py` sets `pool_pre_ping`, `pool_recycle=1800`. |
| `SUPABASE_URL` | Supabase project URL — also resolves the JWKS endpoint for verifying user JWTs in `deps.py` |
| `SUPABASE_SERVICE_ROLE_KEY` | Uploading audio/image blobs to Supabase Storage |
| `DEEPSEEK_API_KEY` | LLM word generation |
| `UNSPLASH_ACCESS_KEY` | Word image search |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to GCP service-account JSON (Google/Gemini TTS) |
| `GCP_SERVICE_ACCOUNT_JSON` | Raw JSON contents; Fly entrypoint writes this to `/secrets/gcp.json` |

Frontend (`flashcard-frontend/.env.local`, not committed):

| Variable | Used by |
|----------|---------|
| `VITE_SUPABASE_URL` | Supabase auth + storage |
| `VITE_SUPABASE_ANON_KEY` | Supabase auth (public anon key) |
| `VITE_API_BASE` | Full backend URL in prod (Fly app URL); omit in dev (Vite proxy handles it) |
| `VITE_ALLOW_SIGNUP` | Set `true` to show "Create account" tab; omit/`false` to hide it |

## Architecture overview

In development, Vite proxies `/api/*` → `http://localhost:8000` (stripping the `/api` prefix). In production, the frontend is a static SPA hosted on Cloudflare Pages and calls the Fly.io backend directly via `VITE_API_BASE` with a Supabase JWT in the `Authorization: Bearer` header.

The backend is stateless between requests; all study state lives in PostgreSQL (`DATABASE_URL` → Supabase). Audio/image blobs live in Supabase Storage (private buckets `word-audio`, `word-images`), accessed via the service-role key from the FastAPI layer. Authentication uses Supabase JWTs — `deps.py` verifies them against the project's JWKS (ES256/EdDSA, fetched from `{SUPABASE_URL}/auth/v1/.well-known/jwks.json` and cached in-process), then looks up or auto-creates the corresponding `User` row by `supabase_uid`.

See `flashcard-backend/CLAUDE.md` for the full data model, FSRS algorithm details, and router map. See `flashcard-frontend/CLAUDE.md` for the Pinia store layout, design-token system, and component conventions.
