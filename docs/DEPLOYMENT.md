# Deployment

Strata can run in four configurations: local stdio (default), HTTP server, Docker container, and Cloud Run. This document covers each option with setup instructions, configuration, and production considerations.

---

## Local (Default) -- stdio Transport

The default mode. Strata runs as a child process of your AI coding assistant, communicating over stdin/stdout via the MCP protocol. No network, no ports, no configuration files.

### Install and Run

```bash
# Via npx (no install required)
npx strata-mcp

# Or install globally
npm install -g strata-mcp
strata
```

### Register as MCP Server

**Claude Code:**
```bash
claude mcp add strata -- npx strata-mcp
```

**Manual MCP configuration** (for other tools):
```json
{
  "mcpServers": {
    "strata": {
      "command": "npx",
      "args": ["strata-mcp"]
    }
  }
}
```

When run with no arguments, Strata starts the MCP server on stdio. The AI tool spawns it as a subprocess and sends JSON-RPC messages over stdin/stdout.

### Data Location

All data is stored in `~/.strata/` by default:
```
~/.strata/
  strata.db          # SQLite database (FTS5 index, knowledge, entities)
  summaries/         # Session summary cache
  meta.json          # Index metadata
  recurring-issues.json
```

Override with the `STRATA_DATA_DIR` environment variable:
```bash
STRATA_DATA_DIR=/custom/path npx strata-mcp
```

---

## HTTP Server

Run Strata as a standalone HTTP server for agentic workflows, multi-client access, or remote deployment. Uses the MCP SDK's Streamable HTTP transport with session management.

### Start the Server

```bash
# Default port 3000
strata serve

# Custom port
strata serve --port 8080

# Or use the PORT environment variable
PORT=8080 strata serve
```

Port resolution order:
1. `--port` flag
2. `PORT` environment variable
3. Default: `3000`

### Endpoint Routes

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | Health check (always available) |
| `POST` | `/mcp` | MCP JSON-RPC: initialize a session or send tool calls |
| `GET` | `/mcp` | SSE stream for an existing session (requires `mcp-session-id` header) |
| `DELETE` | `/mcp` | Terminate an MCP session (requires `mcp-session-id` header) |

### Session Lifecycle

1. **Initialize:** Send a POST to `/mcp` with an `initialize` JSON-RPC request (no `mcp-session-id` header). The response includes an `mcp-session-id` header with a UUID.
2. **Tool calls:** Send POST requests to `/mcp` with the `mcp-session-id` header and a `tools/call` JSON-RPC body.
3. **SSE stream (optional):** Send a GET to `/mcp` with the `mcp-session-id` header to open a server-sent events stream for notifications.
4. **Terminate:** Send a DELETE to `/mcp` with the `mcp-session-id` header.

### Example: Initialize and Call a Tool

```bash
# Initialize
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {},
      "clientInfo": {"name": "curl-test", "version": "1.0.0"}
    }
  }' -v 2>&1 | grep mcp-session-id
# Note the mcp-session-id header value

# Call a tool
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "mcp-session-id: <session-id-from-above>" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "search_history",
      "arguments": {"query": "docker compose networking"}
    }
  }'
```

---

## Docker

Run Strata in a container with persistent storage via volume mounts.

### Dockerfile

```dockerfile
FROM node:20-slim

WORKDIR /app

# Install Strata
RUN npm install -g strata-mcp

# Create data directory
RUN mkdir -p /data/strata

# Set environment
ENV STRATA_DATA_DIR=/data/strata
ENV PORT=3000

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["strata", "serve"]
```

### Build and Run

```bash
# Build
docker build -t strata-mcp .

# Run with persistent storage
docker run -d \
  --name strata \
  -p 3000:3000 \
  -v ~/.strata:/data/strata \
  -v ~/.claude:/root/.claude:ro \
  strata-mcp
```

### Volume Mounts

| Host Path | Container Path | Purpose | Mode |
|-----------|---------------|---------|------|
| `~/.strata` | `/data/strata` | Database and index files | read-write |
| `~/.claude` | `/root/.claude` | Claude Code conversation data (for indexing) | read-only |
| `~/.codex` | `/root/.codex` | Codex CLI conversation data (optional) | read-only |
| `~/.gemini` | `/root/.gemini` | Gemini CLI conversation data (optional) | read-only |

Mount only the conversation directories for tools you actually use. The Claude Code directory is the most common. Cline and Aider data require mounting the VS Code globalStorage and project directories respectively.

---

## Cloud Run

Deploy Strata as a serverless container on Google Cloud Run for remote access.

### Deploy

```bash
# Build and push
gcloud builds submit --tag gcr.io/YOUR_PROJECT/strata-mcp

# Deploy
gcloud run deploy strata-mcp \
  --image gcr.io/YOUR_PROJECT/strata-mcp \
  --port 3000 \
  --memory 512Mi \
  --min-instances 1 \
  --max-instances 1 \
  --set-env-vars "STRATA_DATA_DIR=/data/strata" \
  --allow-unauthenticated
```

### Important Considerations

- **Persistent storage:** Cloud Run containers are ephemeral. You must attach a persistent volume (Cloud Storage FUSE, Filestore, or a mounted disk) for `STRATA_DATA_DIR`. Without persistent storage, the database is rebuilt on every cold start.
- **Min instances:** Set `--min-instances 1` to avoid cold starts. Strata's SQLite database needs to be loaded into memory, which takes time on large datasets.
- **Single instance:** SQLite does not support concurrent write access from multiple processes. Set `--max-instances 1` to prevent data corruption.
- **Health checks:** Cloud Run uses the `/health` endpoint automatically when configured on port 3000.

### Cloud Run with Cloud Storage FUSE

For persistent storage without a dedicated disk:

```bash
gcloud run deploy strata-mcp \
  --image gcr.io/YOUR_PROJECT/strata-mcp \
  --port 3000 \
  --memory 512Mi \
  --min-instances 1 \
  --max-instances 1 \
  --execution-environment gen2 \
  --set-env-vars "STRATA_DATA_DIR=/mnt/strata" \
  --add-volume name=strata-data,type=cloud-storage,bucket=YOUR_BUCKET \
  --add-volume-mount volume=strata-data,mount-path=/mnt/strata
```

Note: Cloud Storage FUSE adds latency to SQLite operations. For best performance, use a Filestore or persistent disk instead.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `STRATA_DATA_DIR` | `~/.strata` | Directory for SQLite database, summaries, and metadata |
| `PORT` | `3000` | HTTP server port (used by `strata serve`) |
| `STRATA_LICENSE_KEY` | (none) | License key for Pro/Team features (alternative to `strata activate`) |
| `STRATA_EXTRA_WATCH_DIRS` | (none) | Comma-separated additional directories to watch for conversation files |
| `STRATA_API_URL` | (none) | Cloud sync API endpoint (Pro feature) |
| `STRATA_API_KEY` | (none) | Cloud sync API key (Pro feature) |
| `STRATA_TEAM_ID` | (none) | Team identifier for team sync (Team feature) |
| `NO_COLOR` | (none) | Disable colored CLI output (any value) |

---

## Health Checks

The `/health` endpoint is available on the HTTP server and returns the server's status, version, and uptime.

### Request

```
GET /health
```

### Response

```json
{
  "status": "ok",
  "version": "1.0.0",
  "uptime": 3600
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | `"ok"` or `"error"` | Server health status |
| `version` | `string` | Strata version from package.json |
| `uptime` | `number` | Seconds since the server started |

### Usage in Monitoring

**Docker:**
```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1
```

**Kubernetes:**
```yaml
livenessProbe:
  httpGet:
    path: /health
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 30
```

**Cloud Run:** Automatically detected when the service responds to HTTP requests on the configured port.

---

## Security

### Default Behavior

The HTTP server has **no authentication** by default. Anyone who can reach the port can read and write to your Strata database.

### Recommendations

**For local development (localhost only):**

By default, the HTTP server binds to `0.0.0.0`. If you only need local access, use a firewall rule or bind to loopback only by placing a reverse proxy in front. The server logs a warning when listening on a non-loopback address:

```
WARNING: Server is listening on a non-loopback address without TLS.
For production use, place behind a reverse proxy with HTTPS.
```

**For production deployment:**

1. **Use a reverse proxy with TLS.** Place nginx, Caddy, or a cloud load balancer in front of Strata. Terminate TLS at the proxy.

2. **Add authentication at the proxy layer.** Use API key validation, OAuth, or mTLS at the reverse proxy. Strata does not implement auth itself.

3. **Restrict network access.** Use firewall rules, VPC service controls, or Cloud Run's IAM to limit who can reach the server.

4. **Use read-only mounts for conversation data.** When running in Docker, mount `~/.claude` and other conversation directories as read-only (`:ro`) to prevent the container from modifying source data.

5. **Run as non-root.** Add a `USER` directive to your Dockerfile:
   ```dockerfile
   RUN adduser --disabled-password --gecos "" strata
   USER strata
   ```

---

## Related Documentation

- [USE-CASES.md](./USE-CASES.md) -- Usage modes (personal, agentic, agent development)
- [MULTI-TOOL.md](./MULTI-TOOL.md) -- Supported AI coding tools and auto-detection
- [TOOLS.md](./TOOLS.md) -- Full reference for all MCP tools
- [ARCHITECTURE.md](./ARCHITECTURE.md) -- Internal architecture and data flow
