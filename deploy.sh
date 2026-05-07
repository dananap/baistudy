#!/bin/bash
set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
PROJECT_ID="${GCP_PROJECT:-baistudy}"
REGION="${GCP_REGION:-europe-west3}"
REGISTRY="${REGION}-docker.pkg.dev/${PROJECT_ID}/flashcard"

BACKEND_IMAGE="${REGISTRY}/backend:latest"

# ── Load backend env vars from .env ──────────────────────────────────────────
set -a; source flashcard-backend/.env; set +a

# ── Ensure Artifact Registry repo exists ─────────────────────────────────────
gcloud artifacts repositories describe flashcard \
  --location "$REGION" --project "$PROJECT_ID" &>/dev/null \
|| gcloud artifacts repositories create flashcard \
     --repository-format docker \
     --location "$REGION" \
     --project "$PROJECT_ID"

gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

# ── Backend ───────────────────────────────────────────────────────────────────
echo "==> Building backend..."
docker build -t "$BACKEND_IMAGE" flashcard-backend

echo "==> Pushing backend..."
docker push "$BACKEND_IMAGE"

echo "==> Deploying backend to Cloud Run..."
gcloud run deploy flashcard-backend \
  --image "$BACKEND_IMAGE" \
  --region "$REGION" \
  --project "$PROJECT_ID" \
  --platform managed \
  --allow-unauthenticated \
  --ingress all \
  --network default \
  --subnet default \
  --vpc-egress private-ranges-only \
  --memory 256Mi \
  --cpu 1000m \
  --min-instances 0 \
  --max-instances 3 \
  --set-env-vars "^|^DATABASE_URL=${DATABASE_URL}|DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY}|UNSPLASH_ACCESS_KEY=${UNSPLASH_ACCESS_KEY}"

BACKEND_URL=$(gcloud run services describe flashcard-backend \
  --region "$REGION" \
  --project "$PROJECT_ID" \
  --format "value(status.url)")
echo "Backend: $BACKEND_URL"

# ── Frontend ──────────────────────────────────────────────────────────────────
echo "==> Building frontend..."
(cd flashcard-frontend && VITE_API_BASE="${BACKEND_URL}" pnpm build)

echo "==> Deploying frontend to Firebase Hosting..."
firebase deploy --only hosting --project "$PROJECT_ID"

FRONTEND_URL="https://${PROJECT_ID}.web.app"
echo "Frontend: $FRONTEND_URL"
