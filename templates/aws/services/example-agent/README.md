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

## Handoff to AWS-3.3

AWS-3.3 lands the SDK tool catalog + the IAM policy + the Anthropic loop:

1. Replace `task_role_inline_policies` (currently a stub allowing only SSM allowlist read + KMS decrypt + the secrets-module consumer policies) with the real policy: `arn:aws:iam::aws:policy/ReadOnlyAccess` (managed) plus an inline deny statement covering `iam:Get*/List*/Simulate*`, `secretsmanager:Get*/List*/Describe*`, `kms:Get*/List*/Describe*` per the design spec §"Example-agent IAM scope."
2. Implement the ~10 SDK tool wrappers under `app/app/lib/tools/` with rich descriptions, JSON-Schema inputs, post-processing, and per-tool ElastiCache TTLs.
3. Wire the wrappers into the Anthropic SDK tool-use loop on `/api/chat/route.ts`. The Anthropic API key is already present at `process.env.ANTHROPIC_API_KEY`, sourced from `module.anthropic_api_key.secret_arn` (operator seeds the value via `aws secretsmanager put-secret-value` post-apply).
4. Add a recall step that calls `strataClient.searchHistory({ query: userMessage })` and threads the results into the system prompt.
5. Add `iam-policy-simulator` CI gate that asserts the deny statements actually deny against fixture principals.

## Handoff to AWS-3.3

AWS-3.3 lands the SDK tool catalog + the IAM policy + the Anthropic loop:

1. Replace `task_role_inline_policies` (currently a stub allowing only SSM allowlist read + KMS decrypt) with the real policy: `arn:aws:iam::aws:policy/ReadOnlyAccess` (managed) plus an inline deny statement covering `iam:Get*/List*/Simulate*`, `secretsmanager:Get*/List*/Describe*`, `kms:Get*/List*/Describe*` per the design spec §"Example-agent IAM scope."
2. Implement the ~10 SDK tool wrappers under `app/app/lib/tools/` with rich descriptions, JSON-Schema inputs, post-processing, and per-tool ElastiCache TTLs.
3. Wire the wrappers into the Anthropic SDK tool-use loop on `/api/chat/route.ts`.
4. Add `iam-policy-simulator` CI gate that asserts the deny statements actually deny against fixture principals.

## Related tickets

- **AWS-3.1** — UI scaffold + Cognito federation. **This ticket.**
- **AWS-3.2** — Access-control Lambdas + Strata memory wiring.
- **AWS-3.3** — AWS SDK tool catalog + ElastiCache LRU + IAM policy.
