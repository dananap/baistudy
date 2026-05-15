#!/usr/bin/env bash
# Deploy the FastAPI backend to Fly.io.
#
# Prerequisites:
#   - flyctl installed and authenticated (`fly auth login`)
#   - First time only: `cd flashcard-backend && fly launch --no-deploy` to
#     create the app (or `fly apps create baistudy-backend`).
#   - Secrets set: `fly secrets set DATABASE_URL=... SUPABASE_URL=... ...`
#     See flashcard-backend/fly.toml for the full list.
#
# Usage: bash deploy-backend.sh

set -euo pipefail

cd "$(dirname "$0")/flashcard-backend"

echo "==> Deploying backend to Fly.io..."
fly deploy --remote-only

BACKEND_URL=$(fly status --json | python3 -c 'import json,sys; print("https://"+json.load(sys.stdin)["Hostname"])')
echo "Backend: $BACKEND_URL"
