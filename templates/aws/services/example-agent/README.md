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

## Handoff to AWS-3.2

AWS-3.2 lands the access-control Lambdas + Strata memory wiring. Concretely the next agent will:

1. Implement `lambdas/pre-signup/index.mjs` and `lambdas/post-confirmation/index.mjs` (Node 22) with their IAM roles + SSM allowlist read permission scoped to `module.example_agent.allowlist_ssm_arn` + `kms:Decrypt` against `module.example_agent.allowlist_kms_key_arn`.
2. Pass the resulting Lambda ARNs into `module "example_agent"` via `pre_signup_lambda_arn` + `post_confirmation_lambda_arn`. The cognito-user-pool module replaces its inert stubs at re-apply time.
3. Create a Secrets Manager entry for `COGNITO_CLIENT_SECRET` (populated from `module.example_agent.user_pool_client_secret`) and add it to the task definition's `secrets[]` block — the AWS-3.1 stub does not wire this through the secrets layer.
4. Implement `app/lib/strata-client.ts` that calls `store_memory` / `search_history` against `STRATA_INTERNAL_URL`, and call it from `/api/chat`.

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
