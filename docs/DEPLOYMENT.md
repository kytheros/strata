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

## AWS

Deploy Strata as a multi-tenant MCP server on AWS using ECS Fargate, Aurora PostgreSQL Serverless v2, ElastiCache Redis Serverless, and API Gateway with Cognito JWT authentication. The template also ships a self-aware example agent (an AWS-introspection chat app) that demonstrates the full stack working end-to-end. This configuration targets production-like memory infrastructure for AI coding assistants with per-tenant isolation; it is appropriate for an enterprise self-host or a portfolio demo account. It is not a fire-and-forget production deployment -- see the [Production hardening checklist](#production-hardening-checklist) below for what is deliberately omitted from the dev template.

Full design rationale: `specs/2026-04-25-strata-deploy-aws-design.md`.

### Architecture

```
Internet
   |
   v
API GW HTTP API       (dev; API GW + Cognito JWT authorizer)
ALB / CloudFront      (staging/prod; swap via ingress.backend = "alb")
   |
   v  JWT validated; X-Strata-Verified injected
VPC Link --> Internal NLB
   |
   v
Strata Fargate (STRATA_REQUIRE_AUTH_PROXY=1, Postgres mode)
   |
   +--> Aurora Serverless v2 (0.5-8 ACU, auto-pause in dev)
   |         + RDS Proxy
   +--> ElastiCache Redis Serverless (JWKS + license cache)

Example-agent Fargate (Next.js, Cognito federation)
   |
   +--> Strata (via Service Connect / Envoy, not through NLB)
   +--> AWS SDK read-only tools (~10 wrappers, ElastiCache LRU)
   +--> Cognito User Pool (Google federation, allowlist pre-signup Lambda)
```

External MCP clients reach Strata through the API GW + NLB path. The example agent reaches Strata over Service Connect -- these are two distinct paths with different security surfaces.

### Cost expectations

| State | Monthly cost | Notes |
|---|---|---|
| Bootstrap only | ~$0 | S3 state bucket + DynamoDB lock; stays up between sessions |
| Fully deployed, idle | ~$361 | NAT Gateways ~$66, VPC endpoints ~$197, NLB ~$16, other |
| 4 hr/wk active | ~$2 | Typical light-use cadence |
| 8 hr/wk active | ~$4-5 | Typical dev / interview cadence |
| 24/7 | ~$361 | Not the intended operating model |

The operating model is: destroy the stack when not actively working, keep bootstrap up always. Apply time is approximately 6-25 minutes depending on how many modules are dirty.

### Prerequisites

- AWS CLI v2, profile `default` configured for the target account
- Terraform >= 1.7
- `task` (https://taskfile.dev) -- wraps the up/down cadence
- `tflint`, `checkov` (optional; CI enforces both)

Install `task` on Windows:

```bash
winget install Task.Task
```

### Quick start

```bash
# One time per account: provision state bucket + OIDC roles. Never destroy.
task bootstrap:up

# One time before first dev:up: copy and edit tfvars.
cp envs/dev/terraform.tfvars.example envs/dev/terraform.tfvars
# Edit: google_client_id, google_client_secret_arn, container image refs.

# Start a work session.
task dev:up

# Inspect live outputs (ingress URL, dashboard URLs, secret ARNs).
task dev:output

# End the work session -- destroys everything except bootstrap.
task dev:down
```

All commands run from `templates/aws/`.

### Authentication setup

The dev stack uses Cognito federation with Google as the primary IdP. Access is restricted to an allowlist stored in SSM Parameter Store.

Register a Google OAuth client:

1. Go to https://console.cloud.google.com/apis/credentials and create an OAuth 2.0 client ID (Web application type).
2. Add the Cognito Hosted UI callback URL as an authorized redirect URI:
   `https://<cognito-domain>.auth.us-east-1.amazoncognito.com/oauth2/idpresponse`
3. Store the client secret in Secrets Manager manually (not via Terraform -- never commit OAuth secrets):

```bash
aws secretsmanager create-secret \
  --name "strata/dev/google-oauth-client-secret" \
  --secret-string "your-client-secret-here"
```

4. Set `google_client_id` and `google_client_secret_arn` in `envs/dev/terraform.tfvars`.

Allowlist mechanism: a `PreSignUp` Lambda reads `/example-agent/dev/allowed-emails` from SSM (KMS-encrypted JSON array). Unmatched federated emails are rejected before account creation. A `PostConfirmation` Lambda auto-assigns successful signups to the `approved` Cognito group, which the example-agent's JWT middleware verifies on every request. Update the allowlist without redeploying:

```bash
aws ssm put-parameter \
  --name "/example-agent/dev/allowed-emails" \
  --value '["you@example.com"]' \
  --type SecureString \
  --overwrite
```

### Two-pass apply (first deploy only)

`example_agent_app_url` is a chicken-and-egg input: Cognito needs it at create time, but it is the API Gateway endpoint this apply produces. On first deploy:

1. Run `task dev:up` with the placeholder URL already in tfvars.
2. Run `task dev:output` and copy `ingress_endpoint_dns`.
3. Update `terraform.tfvars`: `example_agent_app_url = "https://<that>"`.
4. Run `task dev:up` again to wire Cognito callback / logout URLs.

Full checklist: `templates/aws/envs/dev/README.md`.

### Secret seeding after first apply

Two secrets are created empty at apply time and must be seeded manually:

```bash
# Anthropic API key (used by the example-agent tool loop)
aws secretsmanager put-secret-value \
  --secret-id "$(task dev:output -- anthropic_api_key_secret_arn)" \
  --secret-string "sk-ant-..."

# Canary test-user credentials (for the synthetic tools/list canary)
aws secretsmanager put-secret-value \
  --secret-id "$(task dev:output -- canary_credentials_secret_arn)" \
  --secret-string '{"username":"canary@example.com","password":"..."}'
```

The canary secret is provisioned even when `canary_enabled = false` so credentials can be staged before enabling the canary. See `templates/aws/envs/dev/README.md` for the full 7-step operational checklist.

### Observability

Two CloudWatch dashboards are provisioned by `modules/observability`:

| Dashboard | Name pattern |
|---|---|
| SLO | `strata-<env>-slo` |
| Ops (broad) | `strata-<env>-ops` |

Both URLs are surfaced as outputs from `task dev:output` (`observability_dashboard_url`, `observability_ops_dashboard_url`). The ops dashboard covers ECS utilization, API GW request/error/latency, internal NLB flows, Aurora ACU + connections + replica lag, Redis usage, NAT egress, VPC endpoint usage, and the JWT authentication funnel.

Active alarms and runbooks:

| Alarm | Runbook |
|---|---|
| JWT auth error rate > 5% (2 of 3 periods) | `templates/aws/runbooks/jwt_auth_error_rate.md` |
| Synthetic canary failure (tools/list) | `templates/aws/runbooks/canary_mcp_tools_list.md` |
| ALB 5xx rate | `templates/aws/runbooks/alb_5xx_rate.md` |
| ALB p99 latency | `templates/aws/runbooks/alb_p99_latency.md` |
| ECS task shortfall | `templates/aws/runbooks/ecs_task_shortfall.md` |
| Aurora ACU at max | `templates/aws/runbooks/aurora_acu_max.md` |
| Aurora CPU high | `templates/aws/runbooks/aurora_cpu_high.md` |
| Redis CPU high | `templates/aws/runbooks/redis_cpu_high.md` |
| Redis storage high | `templates/aws/runbooks/redis_storage_high.md` |
| NAT bytes-out anomaly | `templates/aws/runbooks/nat_bytes_out_anomaly.md` |
| Cognito auth failure rate | `templates/aws/runbooks/cognito_auth_failure_rate.md` |
| Cost anomaly alert | `templates/aws/runbooks/cost-investigation.md` |
| Auth-proxy token rotation needed | `templates/aws/runbooks/rotate-auth-proxy-token.md` |

### Logs

CloudWatch Logs groups are provisioned per service with 30-day retention. The API GW access log format includes `sub` (JWT subject) and `authError` fields (wired in `modules/ingress`, AWS-1.6.4). Useful Logs Insights queries:

```
# 5xx errors in the last hour
fields @timestamp, @message
| filter status >= 500
| sort @timestamp desc
| limit 50
```

```
# JWT authentication failures
fields @timestamp, authError, sub
| filter authError = "Unauthorized"
| sort @timestamp desc
| limit 50
```

```
# Slow requests (> 2000 ms)
fields @timestamp, path, responseLatency
| filter responseLatency > 2000
| sort responseLatency desc
| limit 20
```

X-Ray tracing is not wired in the dev template. These queries against CloudWatch Logs are the primary debugging surface.

### Cost guardrails

Three layers of cost protection are provisioned:

| Layer | Threshold | Managed by |
|---|---|---|
| AWS Budget `strata-dev-cap` | $30/mo; alerts at 50/80/100% forecast | Operator (manual console setup) |
| Cost Anomaly Detection (CE monitor + subscription) | $5 absolute above baseline | Terraform (`services/cost-anomaly/`) |
| NAT egress anomaly alarm | 3-sigma CloudWatch anomaly band | Terraform (`modules/observability`) |

The AWS Budget must be created manually in the AWS Billing console -- Terraform requires additional permissions the dev OIDC role does not have. The anomaly detection and NAT alarm are fully Terraform-managed.

Cost-allocation tags applied to every resource:

| Tag key | Dev value | Purpose |
|---|---|---|
| Project | strata | Identifies all Strata-on-AWS resources |
| Environment | dev | Differentiates spend in Cost Explorer |
| ManagedBy | terraform | Signals IaC control |
| CostCenter | demo | Cost allocation unit |

Activate these in the AWS Billing console (Billing > Cost Allocation Tags > Activate) to filter spend in Cost Explorer.

For future AWS Organizations adoption, a Service Control Policy stub that enforces required tags at the OU level is at `templates/aws/governance/required-tags-scp/`.

### Production hardening checklist

The dev template is explicitly not production-ready. Known gaps:

- Single-AZ Aurora write path in dev. `min_capacity = 0.5` with auto-pause; no Multi-AZ writer. Promote to provisioned `db.r7g.large` + Multi-AZ when sustained load warrants.
- No backup / restore drill. Aurora automated backups are on, but no restore procedure has been tested. Run a restore drill before relying on this for real data.
- No WAF. The `modules/cloudfront-dist` module ships WAFv2 with three managed rule groups, but CloudFront is not wired into the dev orchestrator (requires a real ACM certificate). Dev traffic reaches API GW directly.
- No GuardDuty. GuardDuty and Security Hub are not provisioned by this template. Enable them at the account level separately.
- OIDC deploy role is over-privileged. `strata-cicd-deploy-role` has `AdministratorAccess` (scaffold phase). Least-privilege replacement is tracked as a follow-up. The read-only CI role (`strata-cicd-readonly-role`) is already least-privilege.
- Single region. Route 53 failover record is pre-wired with a primary slot and an empty secondary. Multi-region becomes a record flip in v2, not a redesign.
- Third canary (example-agent end-to-end OAuth flow) is not complete. The `tools/list` canary is running. The full federated-login -> `/chat` canary requires a Playwright-shaped runner and is an open ticket.

See `specs/2026-04-25-strata-deploy-aws-design.md` §"Phased Rollout" and §"Production-readiness polish" for the full scope.

### Multi-environment expansion

Adding staging and prod environments is documented in `templates/aws/README.md` under "Multi-environment expansion (deferred)". The modules are env-parameterized -- no module code changes needed.

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

The `/health` endpoint is available on the HTTP server as a liveness probe.

### Single-tenant health check

```
GET /health
```

Response:
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

### Multi-tenant health check

In multi-tenant mode (`--multi-tenant`), `/health` returns a minimal liveness signal only:

```
GET /health
```

Response:
```json
{ "status": "ok" }
```

Pool internals (open DB count, hits, misses) are intentionally omitted — they are operational metadata that should not be accessible from an unauthenticated public endpoint.

### Multi-tenant pool stats (admin only)

Full pool statistics are available behind `STRATA_ADMIN_TOKEN`:

```
GET /admin/pool
Authorization: Bearer <STRATA_ADMIN_TOKEN>
```

Response:
```json
{
  "open": 12,
  "maxOpen": 200,
  "hits": 4821,
  "misses": 47,
  "hitRate": "99.0%",
  "uptime": 3600,
  "entries": [
    { "userId": "...", "lastAccess": 1715000000000, "alive": true }
  ]
}
```

If `STRATA_ADMIN_TOKEN` is not set in the environment, `/admin/pool` returns 404 and the endpoint is disabled.

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
