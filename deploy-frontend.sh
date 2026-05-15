#!/usr/bin/env bash
# Build the frontend and deploy to Cloudflare Pages.
#
# Prerequisites:
#   - wrangler installed (`npm i -g wrangler`) and authenticated (`wrangler login`)
#   - First time only: `wrangler pages project create baistudy` (or via dashboard)
#   - flashcard-frontend/.env.local with VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY,
#     VITE_API_BASE (the Fly URL), and VITE_ALLOW_SIGNUP.
#
# Usage: bash deploy-frontend.sh [<VITE_API_BASE>]
#   If VITE_API_BASE is not in .env.local, pass it as the first argument.

set -euo pipefail

cd "$(dirname "$0")/flashcard-frontend"

[ -f .env.local ] && set -a && source .env.local && set +a

if [ -n "${1:-}" ]; then
  export VITE_API_BASE="$1"
fi

: "${VITE_SUPABASE_URL:?VITE_SUPABASE_URL not set}"
: "${VITE_SUPABASE_ANON_KEY:?VITE_SUPABASE_ANON_KEY not set}"
: "${VITE_API_BASE:?VITE_API_BASE not set (pass as arg or set in .env.local)}"

echo "==> Building frontend..."
VITE_ALLOW_SIGNUP="${VITE_ALLOW_SIGNUP:-false}" pnpm build

echo "==> Deploying to Cloudflare Pages..."
wrangler pages deploy dist --project-name="${CF_PAGES_PROJECT:-baistudy}" --branch=main

echo "Frontend deployed."
