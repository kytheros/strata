# Deploying Strata MCP

## Prerequisites

- [Google Cloud SDK](https://cloud.google.com/sdk/docs/install) (`gcloud` CLI)
- [Docker](https://docs.docker.com/get-docker/)
- A GCP project with billing enabled
- Cloud Run API enabled: `gcloud services enable run.googleapis.com`
- Artifact Registry API enabled: `gcloud services enable artifactregistry.googleapis.com`

## Local Development with Docker Compose

```bash
# Start the server on port 3000
docker compose up -d

# With a license key
STRATA_LICENSE_KEY=your-key docker compose up -d

# View logs
docker compose logs -f

# Stop
docker compose down
```

Data is persisted in a named Docker volume (`strata-data`).

### Claude Code config for local Docker

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "strata": {
      "type": "sse",
      "url": "http://localhost:3000/sse"
    }
  }
}
```

## GCP Deployment

### Quick Deploy

```bash
./deploy/deploy.sh --project my-gcp-project --region us-central1
```

The script will:
1. Validate prerequisites (gcloud, Docker, authentication)
2. Create an Artifact Registry repository (if needed)
3. Build and push the Docker image
4. Deploy to Cloud Run
5. Print the service URL and MCP config snippet

### Deploy Options

| Flag | Default | Description |
|------|---------|-------------|
| `--project` | (required) | GCP project ID |
| `--region` | `us-central1` | GCP region |
| `--service` | `strata-mcp` | Cloud Run service name |
| `--dry-run` | `false` | Print commands without executing |

### Configuration Options

| Environment Variable | Description | Default |
|---------------------|-------------|---------|
| `STRATA_DATA_DIR` | Data directory path | `/data` (container) / `~/.strata/` (local) |
| `STRATA_LICENSE_KEY` | Pro license key | (none) |
| `PORT` | HTTP server port | `8080` |

### License Key

To use Pro features, set the `STRATA_LICENSE_KEY` secret:

```bash
echo -n "your-license-key" | gcloud secrets create strata-license-key --data-file=-
gcloud run services update strata-mcp \
  --set-secrets="STRATA_LICENSE_KEY=strata-license-key:latest"
```

### Claude Code MCP Config for Cloud Run

After deploying, add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "strata": {
      "type": "sse",
      "url": "https://strata-mcp-HASH-uc.a.run.app/sse"
    }
  }
}
```

Replace the URL with the one printed by the deploy script.

## Troubleshooting

### Container fails to start

Check logs:
```bash
gcloud run services logs read strata-mcp --region us-central1 --project my-project
```

### Health check failing

The container exposes a `/health` endpoint on port 8080. Verify it works locally:
```bash
docker compose up -d
curl http://localhost:3000/health
```

### Permission denied on /data

The container runs as a non-root `strata` user. Ensure the `/data` directory is writable:
```bash
docker compose exec strata ls -la /data
```

### Artifact Registry authentication

If `docker push` fails, re-authenticate:
```bash
gcloud auth configure-docker us-central1-docker.pkg.dev
```

### Cloud Run cold starts

With `minScale: 0`, the first request after idle will have a cold start (~2-5s). Set `--min-instances 1` in the deploy script to keep one instance warm (incurs cost).
