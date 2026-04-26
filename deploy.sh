#!/bin/bash
set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
PROJECT_ID="${GCP_PROJECT:-baistudy}"
REGION="${GCP_REGION:-europe-west3}"
REGISTRY="${REGION}-docker.pkg.dev/${PROJECT_ID}/flashcard"

BACKEND_IMAGE="${REGISTRY}/backend:latest"
FRONTEND_IMAGE="${REGISTRY}/frontend:latest"

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
  --set-env-vars "^|^DATABASE_URL=${DATABASE_URL}|DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY}|UNSPLASH_ACCESS_KEY=${UNSPLASH_ACCESS_KEY}"

BACKEND_URL=$(gcloud run services describe flashcard-backend \
  --region "$REGION" \
  --project "$PROJECT_ID" \
  --format "value(status.url)")
echo "Backend: $BACKEND_URL"

# ── Frontend ──────────────────────────────────────────────────────────────────
echo "==> Building frontend..."
docker build -t "$FRONTEND_IMAGE" flashcard-frontend

echo "==> Pushing frontend..."
docker push "$FRONTEND_IMAGE"

echo "==> Deploying frontend to Cloud Run..."
gcloud run deploy flashcard-frontend \
  --image "$FRONTEND_IMAGE" \
  --region "$REGION" \
  --project "$PROJECT_ID" \
  --platform managed \
  --allow-unauthenticated \
  --port 80 \
  --set-env-vars "BACKEND_URL=${BACKEND_URL}"

FRONTEND_URL=$(gcloud run services describe flashcard-frontend \
  --region "$REGION" \
  --project "$PROJECT_ID" \
  --format "value(status.url)")
echo "Frontend: $FRONTEND_URL"
