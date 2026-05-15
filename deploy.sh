#!/usr/bin/env bash
# Deploy both backend (Fly.io) and frontend (Cloudflare Pages).
# See deploy-backend.sh and deploy-frontend.sh for prerequisites.

set -euo pipefail

cd "$(dirname "$0")"

bash ./deploy-backend.sh

BACKEND_URL=$(cd flashcard-backend && fly status --json | python3 -c 'import json,sys; print("https://"+json.load(sys.stdin)["Hostname"])')
echo "Backend URL detected: $BACKEND_URL"

bash ./deploy-frontend.sh "$BACKEND_URL"
