# End-to-end tests

Playwright drives the real frontend against the real backend and a real
Postgres. Only the services we don't own are stood in for:

| Real | Stand-in |
|------|----------|
| Vue SPA (Vite dev server, `:5180`) | — |
| FastAPI backend (uvicorn, `:8010`) | — |
| Postgres (private cluster, `:54350`) | — |
| Supabase Auth | `stack/stub_server.py` (`:54340`): GoTrue-shaped endpoints issuing **real ES256 JWTs**, so the backend's JWKS verification runs unmodified |
| Supabase Storage | same stub, in-memory objects |
| DeepSeek | same stub, OpenAI-compatible `/deepseek/chat/completions` (streaming too), scripted per test |
| Google TTS / Gemini images | backend `FAKE_PROVIDERS=true`: a tone WAV and a flat PNG, generated locally |

Nothing touches the network, nothing costs money, and the backend refuses to
start in `FAKE_PROVIDERS` mode against a non-local database.

## Running

```bash
cd e2e
pnpm install                     # once
pnpm test                        # everything, desktop + mobile viewports
pnpm test --project=desktop      # one viewport
pnpm test tests/review.spec.ts   # one file
pnpm test:ui                     # Playwright UI mode — best for writing tests
pnpm report                      # last HTML report (traces for failures)
```

Playwright boots the whole stack itself and tears it down afterwards. For a
quicker edit-and-rerun loop, keep the backend half running in a second
terminal; Playwright reuses whatever is already listening:

```bash
pnpm stack     # Postgres + fresh DB + stub + backend; Ctrl-C to stop
```

The backend runs without `--reload`, so restart `pnpm stack` after backend
changes. Frontend changes hot-reload as usual.

Requirements: PostgreSQL server binaries on `PATH` (`initdb`, `pg_ctl`), the
backend's virtualenv (`flashcard-backend/.venv`, else `venv/`, or set
`E2E_PYTHON`), and a Chromium (`/usr/bin/chromium` is used when present;
otherwise `pnpm exec playwright install chromium` and set `PW_USE_BUNDLED=1`).

Environment knobs: `E2E_DEBUG=1` shows backend and Vite output;
`E2E_LOG_LEVEL=INFO` makes the backend chattier; `E2E_VIDEO=1` records video
of failures (needs `pnpm exec playwright install ffmpeg`);
`E2E_{STUB,API,WEB,PG}_PORT` move the ports.

## How state works

- **Database.** Each stack boot clones `baistudy_e2e` from a template database
  that already holds the schema and the 2,496-word HSK catalog. The template
  is rebuilt only when `models.py`, `database.py`, `prompts.py`,
  `import_catalog.py` or the catalog JSON change (fingerprint in
  `.data/template.fingerprint`). `.data/` is disposable; delete it to start
  over.
- **Isolation.** Every test gets a brand-new account (the `account` fixture),
  so tests never see each other's decks and run in parallel without resets.
- **LLM replies** are global to the stub. Key each scripted reply to text only
  your test sends (see `reading.spec.ts`, which puts `info.testId` in the
  topic).

## Writing tests

```ts
import { test, expect } from '../support/fixtures';

test('…', async ({ authedPage: page, backend, llm }) => {
  await backend.onboard(1, 30);              // arrange through the API
  await page.goto('/session/start');         // act through the UI
  // …
  expect((await backend.get('/stats')).total_reviews).toBe(1);  // assert what persisted
});
```

| Fixture | What it is |
|---------|-----------|
| `account` | A fresh stub user: `email`, `password`, `uid`, `accessToken`, `session` |
| `authedPage` | `page` with that account's session already in localStorage |
| `page` | Plain page; fails the test on any uncaught page error |
| `backend` | API client authenticated as `account`: `get`, `send`, `onboard(level, deckSize)` |
| `llm` | `reply(content, { match, sticky })` scripts the next DeepSeek answer; `requests()` returns what was sent |

Prefer role- and label-based locators (`getByRole`, `getByLabel`): they
survive the redesign's markup changes and double as an accessibility check.
Arrange state through `backend` rather than clicking through setup screens,
except in the test that is about those screens.

This suite complements `flashcard-frontend/e2e/visual`, which renders every
screen against mocked APIs for visual review; this one checks that flows work
end to end.
