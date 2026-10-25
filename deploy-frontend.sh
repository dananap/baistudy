#!/usr/bin/env bash
# Build the frontend and deploy it to the `baistudy` Cloudflare Worker
# (static assets, configured in flashcard-frontend/wrangler.jsonc), which
# serves baistudy.online.
#
# Prerequisites:
#   - Authenticated with the project's own wrangler:
#       cd flashcard-frontend && ./node_modules/.bin/wrangler login
#     (a global wrangler may run on an older Node that wrangler 4 rejects)
#   - flashcard-frontend/.env.local with VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY,
#     VITE_API_BASE (https://api.baistudy.online), and optionally VITE_ALLOW_SIGNUP.
#   - A CLOUDFLARE_API_TOKEN in the environment takes precedence over the OAuth
#     login; unset it if it is stale.
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

# Push reminders depend on the service worker pulling in sw-push.js.
grep -q 'sw-push.js' dist/sw.js || { echo "dist/sw.js does not import sw-push.js" >&2; exit 1; }

echo "==> Deploying to the baistudy Worker..."
./node_modules/.bin/wrangler deploy

echo "Frontend deployed."
