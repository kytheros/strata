#!/usr/bin/env bash
set -euo pipefail

# Deploy Strata MCP to Google Cloud Run
#
# Usage:
#   ./deploy/deploy.sh --project my-gcp-project [--region us-central1] [--service strata-mcp] [--dry-run]

SERVICE_NAME="strata-mcp"
REGION="us-central1"
PROJECT=""
DRY_RUN=false

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --project)
      PROJECT="$2"
      shift 2
      ;;
    --region)
      REGION="$2"
      shift 2
      ;;
    --service)
      SERVICE_NAME="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      echo "Usage: deploy.sh --project <gcp-project> [--region <region>] [--service <name>] [--dry-run]"
      echo ""
      echo "Options:"
      echo "  --project   GCP project ID (required)"
      echo "  --region    GCP region (default: us-central1)"
      echo "  --service   Cloud Run service name (default: strata-mcp)"
      echo "  --dry-run   Print commands without executing"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

if [[ -z "$PROJECT" ]]; then
  echo "Error: --project is required"
  echo "Usage: deploy.sh --project <gcp-project> [--region <region>] [--dry-run]"
  exit 1
fi

# Validate prerequisites
echo "==> Checking prerequisites..."

if ! command -v gcloud &>/dev/null; then
  echo "Error: gcloud CLI is not installed. Install from https://cloud.google.com/sdk/docs/install"
  exit 1
fi

if ! command -v docker &>/dev/null; then
  echo "Error: Docker is not installed. Install from https://docs.docker.com/get-docker/"
  exit 1
fi

# Check gcloud auth
if ! gcloud auth print-access-token &>/dev/null; then
  echo "Error: gcloud is not authenticated. Run: gcloud auth login"
  exit 1
fi

REPO="strata"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/${SERVICE_NAME}"

run_cmd() {
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[dry-run] $*"
  else
    "$@"
  fi
}

echo "==> Configuring Docker for Artifact Registry..."
run_cmd gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

echo "==> Enabling Vertex AI API..."
run_cmd gcloud services enable aiplatform.googleapis.com --project "$PROJECT"

SA_EMAIL="${SERVICE_NAME}@${PROJECT}.iam.gserviceaccount.com"
echo "==> Granting Vertex AI user role to service account..."
run_cmd gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/aiplatform.user" \
  --quiet 2>/dev/null || true

echo "==> Creating Artifact Registry repository (if needed)..."
run_cmd gcloud artifacts repositories create "$REPO" \
  --repository-format=docker \
  --location="$REGION" \
  --project="$PROJECT" \
  --quiet 2>/dev/null || true

echo "==> Building Docker image..."
run_cmd docker build -t "$IMAGE" .

echo "==> Pushing to Artifact Registry..."
run_cmd docker push "$IMAGE"

echo "==> Deploying to Cloud Run..."
run_cmd gcloud run deploy "$SERVICE_NAME" \
  --image "$IMAGE" \
  --region "$REGION" \
  --project "$PROJECT" \
  --port 8080 \
  --memory 512Mi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 1 \
  --set-env-vars "STRATA_DATA_DIR=/data,GOOGLE_CLOUD_PROJECT=$PROJECT,GOOGLE_CLOUD_LOCATION=$REGION" \
  --allow-unauthenticated \
  --quiet

if [[ "$DRY_RUN" == "true" ]]; then
  echo ""
  echo "==> Dry run complete. No changes were made."
  exit 0
fi

# Get the service URL
SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
  --region "$REGION" \
  --project "$PROJECT" \
  --format "value(status.url)")

echo ""
echo "==> Deployed successfully!"
echo "    URL: ${SERVICE_URL}"
echo ""
echo "==> Claude Code MCP config (~/.claude/settings.json):"
echo ""
cat <<EOF
{
  "mcpServers": {
    "strata": {
      "type": "sse",
      "url": "${SERVICE_URL}/sse"
    }
  }
}
EOF
