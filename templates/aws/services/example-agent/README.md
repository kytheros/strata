# `services/example-agent` — AWS-introspection chat surface

A small Next.js 14 app deployed on Fargate behind Cognito federation. The agent's tools are read-only `@aws-sdk/client-*` calls (wired in AWS-3.3), so anyone evaluating the Strata-on-AWS deploy can ask the agent about itself and watch the full stack respond. Strata-on-AWS is the conversational memory backend (wired in AWS-3.2).

## Layout

```
services/example-agent/
├── app/                          # Next.js 14 application (this ticket: AWS-3.1)
│   ├── package.json              # next, react, aws-jwt-verify, @aws-sdk/client-ssm,
│   │                             # @aws-sdk/client-cognito-identity-provider
│   ├── tsconfig.json             # strict mode, ES2022, moduleResolution=bundler
│   ├── next.config.mjs           # output: 'standalone'
│   ├── middleware.ts             # /chat gate — Edge runtime, cookie presence only
│   ├── Dockerfile                # multi-stage Node 22, --ignore-scripts npm ci
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx              # Landing — "Sign in" or "Open chat"
│   │   ├── globals.css
│   │   ├── chat/page.tsx         # Authenticated chat surface (placeholder UI)
│   │   ├── api/
│   │   │   ├── auth/login/route.ts     # 302 → Cognito Hosted UI authorize
│   │   │   ├── auth/callback/route.ts  # OAuth code → tokens → session cookie
│   │   │   ├── auth/logout/route.ts    # Clear cookie + 302 to Cognito /logout
│   │   │   └── chat/route.ts           # Stub backend — AWS-3.3 wires the real loop
│   │   └── lib/
│   │       ├── config.ts                  # Env-var-driven runtime config
│   │       ├── jwt-verify.ts              # aws-jwt-verify wrapper
│   │       ├── cognito-client.ts          # OAuth code exchange (native fetch)
│   │       └── auth-middleware.ts         # API-route auth gate (Node runtime)
│   └── public/                   # Static assets (empty)
├── infrastructure/
│   ├── versions.tf               # Terraform ~> 1.7, AWS provider ~> 5.0
│   ├── variables.tf              # Inputs (federation, allowlist, cluster wiring, etc.)
│   ├── main.tf                   # Composition: cognito-user-pool + ecs-service +
│   │                             # SSM allowlist + CMK
│   ├── outputs.tf                # service_arn, app_url, cognito_hosted_ui_url,
│   │                             # allowlist_ssm_path, allowlist_kms_key_arn, ...
│   ├── README.md                 # Module-level docs + auth-flow diagram
│   └── examples/dev/main.tf      # Plan-only example for the dev account
└── README.md                     # This file
```

## What this service is

Per design spec §"Phase 3 — Example-agent service: AWS introspection chat":

- **Single chat surface** at `/chat`.
- **Cognito federation** — Google primary (GitHub deferred per the cognito-user-pool README §"GitHub federation").
- **Allowlist-gated access** via the `approved` Cognito group. Pre-signup Lambda (AWS-3.2) checks the SSM allowlist; PostConfirmation Lambda (AWS-3.2) assigns the group.
- **AWS-introspection tool catalog** — wired in AWS-3.3 — calls `@aws-sdk/client-*` read-only against the very deploy the agent runs in.
- **Strata-on-AWS as memory backend** — wired in AWS-3.2 — every chat turn is stored via `store_memory`, recalled via `search_history`, scoped to the active user.

## Auth flow (AWS-3.1)

```
Browser  →  middleware.ts  →  /api/auth/login  →  Cognito Hosted UI (federation)
                                                          ↓
Browser  ←  /chat  ←  /api/auth/callback  ←  Cognito redirect (code)
                            ↓
                     POST /oauth2/token
                     verify access token
                     assert `approved` group
                     set HttpOnly Secure SameSite=Lax cookie
```

Without `approved`: 403 from `/api/chat`, redirect to `/?error=not_approved` from `/chat`. See `infrastructure/README.md` for the full ASCII sequence diagram.

## Dev iteration

The Next.js app can run locally against a Cognito pool deployed to dev — useful when iterating on the auth flow without rebuilding + pushing the container image on every change.

```powershell
# 1. Apply the infrastructure (or use the live dev apply if it exists).
cd E:\strata\strata\templates\aws\services\example-agent\infrastructure\examples\dev
# (when Phase 1 + Phase 2 are applied; today this is plan-only)
# terraform apply

# 2. Pull the wiring values into env vars for local Next.
cd ..\..\..\app
$env:AWS_REGION = "us-east-1"
$env:COGNITO_USER_POOL_ID = (terraform -chdir=..\infrastructure\examples\dev output -raw user_pool_id)
$env:COGNITO_CLIENT_ID = (terraform -chdir=..\infrastructure\examples\dev output -raw user_pool_client_id)
$env:COGNITO_CLIENT_SECRET = (terraform -chdir=..\infrastructure\examples\dev output -raw user_pool_client_secret)
$env:COGNITO_HOSTED_UI_DOMAIN = (terraform -chdir=..\infrastructure\examples\dev output -raw cognito_hosted_ui_domain)
$env:APP_URL = "https://localhost:3000"

# 3. Run.
npm install
npm run dev
```

The Cognito App Client's `callback_urls` includes `https://localhost:3000/api/auth/callback` by default — enough for local OAuth round-trips.

## Deploy chain (when CI lands in AWS-4.1)

1. **Build container** — `docker build -t example-agent:$(git rev-parse --short HEAD) services/example-agent/app/`
2. **Push to ECR** — `docker tag` + `docker push` against the dev ECR repo (created by the cicd-engineer's pipeline).
3. **Terraform apply** — `task example-agent:up` from `templates/aws/`.
4. **Smoke test** — `curl -I "$(terraform output -raw app_url)/chat"` → expect 307 to `/?reason=unauthenticated`.

The pipeline rolls the ECS service via `aws ecs update-service --force-new-deployment` — the deployment circuit breaker enabled in the `ecs-service` module reverts on a failed health check.

## Access-control Lambdas (AWS-3.2)

The composition owns two Cognito Lambda triggers, packaged from `services/example-agent/lambdas/`:

| Lambda | Source | Trigger | What it does |
|---|---|---|---|
| `example-agent-{env}-pre-signup` | `lambdas/pre-signup/` | `PreSignUp` | Reads the SSM allowlist (60s in-memory cache), rejects non-allowlisted emails by throwing `Error("Not authorized")`. The thrown string is what users see in the Hosted UI — coordinate before changing it. |
| `example-agent-{env}-post-confirmation` | `lambdas/post-confirmation/` | `PostConfirmation` | Adds the confirmed user to the `approved` Cognito group via `AdminAddUserToGroup`. Failures are logged but DO NOT throw — see the silent-failure design note in `index.mjs`. |

Both are Node 22 ESM, native fetch only, with least-privilege IAM:

- Pre-signup role: `ssm:GetParameter` on the allowlist parameter ARN + `kms:Decrypt` on the allowlist CMK + CloudWatch Logs.
- Post-confirmation role: `cognito-idp:AdminAddUserToGroup` scoped to all user pools in the account+region (a tighter scope creates a Terraform-graph cycle — see the inline comment in `infrastructure/main.tf`) + CloudWatch Logs.

### How to add a new email to the dev allowlist

The SSM parameter has `lifecycle.ignore_changes = [value]` — operators mutate it in place, no re-apply needed.

```powershell
# Read the current value
aws ssm get-parameter `
  --name /example-agent/dev/allowed-emails `
  --with-decryption `
  --query 'Parameter.Value' --output text | ConvertFrom-Json

# Replace with a new array (note the JSON-encoded string)
aws ssm put-parameter `
  --name /example-agent/dev/allowed-emails `
  --type SecureString `
  --overwrite `
  --value '["mkavalich@gmail.com","new.person@example.com"]'

# Pre-signup Lambda picks up the new value within 60s (in-memory TTL).
# To force-refresh, briefly drop the Lambda's reserved concurrency to 0
# and back up — every container is then a cold start.
```

The `Not authorized` user-visible error string is named verbatim in the AWS-3.2 ticket exit criteria (`specs/2026-04-25-strata-deploy-aws-plan.md`). Don't reword it without coordinating with the plan owner.

## Strata memory client (AWS-3.2)

`app/app/lib/strata-client.ts` wraps Strata's MCP HTTP endpoint over Service Connect. Per chat turn:

1. The server reads the verified Cognito `sub` from the JWT (already done by `auth-middleware.ts`).
2. Constructs `new StrataClient(verifiedSub)`.
3. Calls `storeMemory({ memory_text, type: 'episodic', tags: [] })` for each user message.
4. (AWS-3.3) Will call `searchHistory({ query, ... })` to seed the Anthropic loop's recall context.

Strata trusts the upstream proxy (this service): it requires `X-Strata-User` + `X-Strata-Verified` (matching `STRATA_AUTH_PROXY_TOKEN`). The token comes from Secrets Manager via the Phase 2 strata service module, threaded through as `var.strata_auth_proxy_token_secret_arn`.

The internal URL is derived from `var.cluster_service_connect_namespace` + `var.strata_internal_port` (defaulting to 3000). When Service Connect isn't yet wired, callers can pass `var.strata_internal_url` directly to override.

## AWS-3.3 — SDK tool catalog + agent loop + IAM lockdown (shipped)

Phase 3 closer. The chat backend at `/api/chat` is now an Anthropic SDK
tool-use loop with 10 hand-tuned read-only AWS SDK wrappers, an
ElastiCache LRU, and a hardened IAM policy.

### Tool catalog

`app/app/lib/tools/` — 10 tools, one file each. Every tool follows the
same shape: an Anthropic `Tool` definition (purpose / when-to-use /
prerequisites / anti-pattern), an `execute(input, ctx)` async function,
ElastiCache caching via the shared `ToolCache`. The dispatcher lives at
`app/app/lib/tools/index.ts`.

| Tool | Returns | TTL |
|---|---|---|
| `who_am_i` | STS GetCallerIdentity | 1h |
| `list_ecs_services` | service summary + task counts | 60s |
| `describe_aurora_cluster` | engine/version/endpoint/capacity/encryption | 5m |
| `list_active_alarms` | CloudWatch alarms in ALARM | 60s |
| `tail_recent_logs` | last 50 events from a log group | 30s |
| `list_vpc_resources` | VPCs / subnets / NAT GWs / VPC endpoints | 5m |
| `describe_load_balancers` | ELBv2 + target group bindings | 5m |
| `s3_bucket_summary` | bucket inventory + encryption | 1h |
| `cost_last_7_days` | top services by spend (Cost Explorer) | 1h |
| `infrastructure_topology` | composite of vpc + ecs + aurora + lbs | 5m |

### Agent loop

`app/app/lib/agent-loop.ts`. Sonnet-4-6, 4096 max-tokens,
max 10 iterations. On `stop_reason === "tool_use"`, every `tool_use`
block is dispatched through `executeTool()` and threaded back as a
`tool_result` content block in the next user turn. Tool errors don't
throw — `executeTool` returns `{ error, message }` so the model can
recover or fall back.

### Cache

`app/app/lib/cache.ts` — Redis Serverless wrapper. Key shape:
`awstool:${toolName}:${shortHash(input)}` (12-char SHA-256). Lazy
singleton; reused across the Lambda / Fargate task lifetime.
`InMemoryToolCache` is the unit-test substitute.

### IAM task role (hardened)

- **Managed (customer-owned):** `example-agent-{env}-task-read` — a
  tightly-scoped read policy that grants exactly the SDK calls the 10
  tools in `app/lib/tools/*.ts` make, scoped to `strata-{env}-*` resource
  ARNs where the action supports resource-level IAM. Replaces the prior
  AWS-managed `ReadOnlyAccess`, which granted ~700 actions across every
  service in the account.
- **Inline `deny-iam-secrets-kms-reads`:** defense-in-depth deny on
  `iam:Get*/List*/Simulate*`, `secretsmanager:Get*/List*/Describe*`
  (with `NotResource` carve-outs for the runtime secrets the task
  definition resolves at start), and `kms:Get*/List*/Describe*`. The
  scoped read policy doesn't grant these in the first place; the deny
  is kept so any future managed-policy attachment can't widen the
  surface.
- **Inline `secret-cognito-client` / `secret-anthropic-api-key` /
  `secret-redis-auth`:** narrow Allow on the runtime-secret ARNs the
  task definition needs to start.
- **Inline `cloudwatch-put-metric-data`:** narrow Allow scoped via the
  `cloudwatch:namespace` condition key to `Concierge/Anthropic`.

The runtime-secret ARNs appear in the deny's `NotResource` list so the
Allow on those ARNs isn't shadowed.

#### Residual broad-scope surface

A handful of AWS APIs do not support resource-level IAM and therefore
remain at `Resource: "*"` in the scoped policy:

- `ce:GetCostAndUsage`, `ce:GetCostForecast` (Cost Explorer is
  account-scoped)
- `ec2:DescribeVpcs`, `ec2:DescribeSubnets`, `ec2:DescribeNatGateways`,
  `ec2:DescribeVpcEndpoints` (no ARN-level scoping for these read calls)
- `sts:GetCallerIdentity` (no resource ARN)
- `s3:ListAllMyBuckets` (account-scoped — but the per-bucket
  `s3:GetBucketEncryption` / `GetBucketLocation` / `GetBucketPolicy` /
  `GetLifecycleConfiguration` calls are scoped to `arn:aws:s3:::strata-*`)

### Policy simulator gate

`infrastructure/test/iam-policy-simulator.test.sh` — runs
`aws iam simulate-principal-policy` against the deployed task role:

- DENIED: `iam:ListUsers`, `iam:GetRole`, `iam:SimulatePrincipalPolicy`
- DENIED: `secretsmanager:GetSecretValue` (arbitrary ARN), `secretsmanager:ListSecrets`
- DENIED: `kms:DescribeKey`, `kms:GetKeyPolicy`, `kms:ListAliases`
- DENIED: `s3:GetBucketEncryption` against an unrelated bucket (was
  ALLOWED under ReadOnlyAccess)
- DENIED: `rds:DescribeDBClusters` against a non-strata cluster (was
  ALLOWED under ReadOnlyAccess)
- DENIED: `ecs:DescribeServices` against a non-strata cluster
- DENIED: `logs:FilterLogEvents` against a non-strata log group
- ALLOWED: `ecs:ListServices` on the `strata-{env}` cluster
- ALLOWED: `rds:DescribeDBClusters` on a `strata-{env}*` cluster
- ALLOWED: `ec2:DescribeVpcs` (irreducible broad surface)
- ALLOWED: `cloudwatch:DescribeAlarms` on a `strata-{env}-*` alarm
- ALLOWED: `s3:GetBucketEncryption` on a `strata-*` bucket
- ALLOWED: `logs:FilterLogEvents` on `/ecs/strata-{env}*`
- ALLOWED: `ce:GetCostAndUsage`, `sts:GetCallerIdentity`

Run via `task example-agent:simulate-iam` once the role is applied.
AWS-4.1 will wire this into the GitHub Actions PR workflow.

### Per-tool unit tests

`app/test/tools/*.test.ts` — vitest + `aws-sdk-client-mock`. Each tool
asserts the post-processing shape and cache-hit behavior (no second
SDK call after the first cached read). Run via:

```powershell
cd services\example-agent\app
npm run test
```

Or `task example-agent:test` from `templates/aws/`.

### Wiring it up

The example-agent composition takes four new optional inputs that the
caller threads in from the Phase 1 elasticache-redis module:

| Variable | Source |
|---|---|
| `redis_endpoint` | `module.cache.endpoint` |
| `redis_port` | `module.cache.port` (or 6379) |
| `redis_auth_secret_arn` | `module.cache.auth_secret_arn` |
| `redis_auth_secret_consumer_iam_policy_json` | `module.cache.auth_secret_consumer_iam_policy_json` |

When Redis vars are empty (the AWS-3.3 dev example default until
elasticache:up runs), the application falls back to direct SDK calls
on every request — slower, but functional.

## Related tickets

- **AWS-3.1** — UI scaffold + Cognito federation. **This ticket.**
- **AWS-3.2** — Access-control Lambdas + Strata memory wiring.
- **AWS-3.3** — AWS SDK tool catalog + ElastiCache LRU + IAM policy.
