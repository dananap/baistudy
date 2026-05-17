#!/usr/bin/env bash
# One-shot Fly app rename + secret migration for the backend.
#
# What this does:
#   1. Reads the new app name from flashcard-backend/fly.toml
#   2. Creates that Fly app (idempotent — skips if it exists)
#   3. Generates ORIGIN_SECRET if not already in .env.prod
#   4. Imports flashcard-backend/.env.prod into Fly secrets
#   5. Deploys the backend
#   6. Issues a Fly cert for api.baistudy.online
#   7. Prints the manual Cloudflare steps you still need to do
#
# Prereqs:
#   - flyctl installed and authenticated
#   - flashcard-backend/.env.prod exists with production secrets, one per line:
#       DATABASE_URL=postgresql://...
#       SUPABASE_URL=https://....supabase.co
#       SUPABASE_SERVICE_ROLE_KEY=...
#       DEEPSEEK_API_KEY=...
#       UNSPLASH_ACCESS_KEY=...
#       AZURE_SPEECH_KEY=...
#       GCP_SERVICE_ACCOUNT_JSON={"type":"service_account",...}   # single line, raw JSON
#     (.env.prod is gitignored — see check below)
#
# Usage: bash migrate-fly-app.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$REPO_ROOT/flashcard-backend"
ENV_FILE="$BACKEND_DIR/.env.prod"
CUSTOM_DOMAIN="api.baistudy.online"

cd "$BACKEND_DIR"

# ── Sanity checks ────────────────────────────────────────────────────────────

if ! command -v fly >/dev/null 2>&1; then
  echo "ERROR: flyctl not found in PATH. Install: https://fly.io/docs/flyctl/install/" >&2
  exit 1
fi

if ! grep -qE '^\s*\.env\.prod' "$REPO_ROOT/.gitignore" 2>/dev/null \
  && ! grep -qE '^\s*\.env\.prod' "$BACKEND_DIR/.gitignore" 2>/dev/null; then
  echo "WARNING: .env.prod is not in .gitignore. Refusing to continue." >&2
  echo "Add '.env.prod' to flashcard-backend/.gitignore first." >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found. Create it with production secrets (see header)." >&2
  exit 1
fi

APP_NAME="$(awk -F'"' '/^app\s*=/{print $2; exit}' fly.toml)"
if [[ -z "$APP_NAME" ]]; then
  echo "ERROR: could not parse app name from fly.toml" >&2
  exit 1
fi
echo "==> Target Fly app: $APP_NAME"

# ── Ensure ORIGIN_SECRET is in .env.prod ─────────────────────────────────────

if ! grep -qE '^ORIGIN_SECRET=' "$ENV_FILE"; then
  SECRET="$(openssl rand -hex 32)"
  echo "ORIGIN_SECRET=$SECRET" >> "$ENV_FILE"
  echo "==> Generated ORIGIN_SECRET and appended to .env.prod"
  echo "    Save this value for the Cloudflare Transform Rule:"
  echo "    $SECRET"
else
  echo "==> ORIGIN_SECRET already present in .env.prod"
fi

# ── Create app (idempotent) ──────────────────────────────────────────────────

if fly apps list --json 2>/dev/null | grep -q "\"Name\":\"$APP_NAME\""; then
  echo "==> App $APP_NAME already exists, skipping create"
else
  echo "==> Creating Fly app $APP_NAME"
  fly apps create "$APP_NAME"
fi

# ── Import secrets ───────────────────────────────────────────────────────────

echo "==> Importing secrets from .env.prod into $APP_NAME"
# `fly secrets import` reads KEY=VALUE lines from stdin. Strips comments/blanks.
grep -vE '^(\s*#|\s*$)' "$ENV_FILE" | fly secrets import -a "$APP_NAME" --stage
# --stage defers restart; the deploy below picks them up.

# ── Deploy ───────────────────────────────────────────────────────────────────

echo "==> Deploying to $APP_NAME"
fly deploy --remote-only -a "$APP_NAME"

# ── Smoke test the direct Fly URL (with the secret) ──────────────────────────

ORIGIN_SECRET_VAL="$(grep -E '^ORIGIN_SECRET=' "$ENV_FILE" | cut -d= -f2-)"
echo "==> Smoke test: GET https://$APP_NAME.fly.dev/health (with X-Origin-Auth)"
if curl -fsS -H "X-Origin-Auth: $ORIGIN_SECRET_VAL" \
     "https://$APP_NAME.fly.dev/health" >/dev/null; then
  echo "    OK"
else
  echo "    FAILED — check 'fly logs -a $APP_NAME'" >&2
fi

echo "==> Smoke test: GET https://$APP_NAME.fly.dev/health (without header — should 403)"
status="$(curl -s -o /dev/null -w '%{http_code}' "https://$APP_NAME.fly.dev/health")"
if [[ "$status" == "403" ]]; then
  echo "    OK (got 403 as expected)"
else
  echo "    UNEXPECTED status=$status — ORIGIN_SECRET enforcement may not be active" >&2
fi

# ── Issue cert for custom domain ─────────────────────────────────────────────

echo "==> Requesting Fly cert for $CUSTOM_DOMAIN"
fly certs create "$CUSTOM_DOMAIN" -a "$APP_NAME" || \
  echo "    (cert may already exist — that's fine)"

# ── Manual follow-ups ────────────────────────────────────────────────────────

cat <<EOF

────────────────────────────────────────────────────────────────────────────
Done with the Fly side. Now do these in Cloudflare for baistudy.online:

1. DNS → edit CNAME for "api":
     api  →  $APP_NAME.fly.dev
   (keep the orange cloud / proxy ON)

2. Rules → Transform Rules → Modify Request Header → Create rule:
     Name:    Add origin auth to backend
     If:      Hostname equals $CUSTOM_DOMAIN
     Then:    Set static header
              Name:  X-Origin-Auth
              Value: $ORIGIN_SECRET_VAL
   Deploy the rule.

3. Verify: hit https://$CUSTOM_DOMAIN/health from a browser → 200.
           hit https://$APP_NAME.fly.dev/health directly  → 403.

4. Once everything works, retire the old app:
     fly apps destroy baistudy-backend
────────────────────────────────────────────────────────────────────────────
EOF
