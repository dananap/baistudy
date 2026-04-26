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

## Environment variables

The backend reads from `flashcard-backend/.env`. Required keys:

| Variable | Used by |
|----------|---------|
| `DEEPSEEK_API_KEY` | LLM word generation |
| `UNSPLASH_ACCESS_KEY` | Word image search |
| `GOOGLE_APPLICATION_CREDENTIALS` | Google Cloud TTS |

## Deploying to GCP (Cloud Run)

```bash
bash deploy.sh   # reads flashcard-backend/.env; pushes images, deploys both services
```

Requires `gcloud` CLI authenticated and `GCP_PROJECT` / `GCP_REGION` set (defaults: `baistudy` / `europe-west3`).

## Architecture overview

The frontend talks to the backend exclusively through `/api/*` routes. In development Vite proxies these to `http://localhost:8000` (stripping the `/api` prefix). In production the frontend Dockerfile bakes an Nginx config that proxies to the `backend` Docker service by hostname.

The backend is stateless between requests; all study state lives in a SQLite file (`flashcard-backend/chinese_srs.db`). Authentication is a simple `X-User-ID` header — no tokens or sessions.

See `flashcard-backend/CLAUDE.md` for the full data model, FSRS algorithm details, and router map. See `flashcard-frontend/CLAUDE.md` for the Pinia store layout, design-token system, and component conventions.
