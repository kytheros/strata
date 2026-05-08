# `services/example-agent/infrastructure` — example-agent Terraform composition

**Tool choice: Terraform (OpenTofu compatible).** Reason: this composition stitches three things together — the `cognito-user-pool` module (with Google federation), the `ecs-service` module (Fargate + autoscaling + IAM + ingress wiring), and a thin SSM-allowlist + CMK pair owned directly by this composition. Terraform's plan model surfaces the cross-module data flow cleanly; mixing CDK or Pulumi here would add review friction without proportional benefit.

## What this creates

| Resource | Owner | Notes |
|---|---|---|
| `aws_kms_key` (allowlist CMK) | this composition | 7-day deletion window, key rotation on. |
| `aws_kms_alias` | this composition | `alias/example-agent-{env}-allowlist`. |
| `aws_ssm_parameter` (SecureString) | this composition | `/example-agent/{env}/allowed-emails`. JSON-encoded array. `lifecycle.ignore_changes = [value]` so operators can edit it post-apply without `terraform plan` fighting the change. |
| `module.cognito_user_pool` | `modules/cognito-user-pool` | User pool, App Client, 5 groups, 3 Lambda triggers. AWS-3.2 wires the real PreSignUp + PostConfirmation handlers (replacing the module's inert stubs). Federation IdPs wired when `var.google_client_id` + `var.google_client_secret_arn` are set. |
| `aws_lambda_function.pre_signup` | this composition | Allowlist-enforcer Lambda (AWS-3.2). Source under `../lambdas/pre-signup/`. Throws `"Not authorized"` for non-allowlisted federated emails. |
| `aws_lambda_function.post_confirmation` | this composition | Group-assigner Lambda (AWS-3.2). Source under `../lambdas/post-confirmation/`. Adds confirmed users to the `approved` group; logs (does not throw) on AdminAddUserToGroup failure. |
| `module.cognito_client_secret` | `modules/secrets` | Wraps the Cognito App Client secret as a Secrets Manager entry; consumed by the task definition's `secrets[]` block as `COGNITO_CLIENT_SECRET`. |
| `module.anthropic_api_key` | `modules/secrets` | Empty Secrets Manager entry reserved for the Anthropic API key. Operator seeds the value post-apply; AWS-3.3 reads it at runtime. |
| `module.ecs_service` | `modules/ecs-service` | Task definition, ECS service, autoscaling, IAM task role, security group, ALB / API GW attachment. Container image is the Next.js standalone build from `services/example-agent/app/`. |

## AWS-3.1 scope vs AWS-3.2 / AWS-3.3 scope

This composition is the **first** of three Phase 3 tickets. Two carry-overs are documented inline as `# AWS-3.X will...` comments:

| Carry-over | Owner ticket | What changes |
|---|---|---|
| PreSignUp + PostConfirmation Lambdas | AWS-3.2 | Caller will pass real Lambda ARNs into `var.pre_signup_lambda_arn` + `var.post_confirmation_lambda_arn`. The cognito-user-pool module's inert stubs handle dev sign-ins until then. |
| Cognito client secret → Secrets Manager | AWS-3.2 | The Next.js server needs `COGNITO_CLIENT_SECRET` server-side. AWS-3.2 creates a Secrets Manager entry, populates it from `module.cognito_user_pool.user_pool_client_secret`, and adds it to the task definition's `secrets[]` block. Until then the secret only exists in Terraform state. |
| Task role IAM policy | AWS-3.3 (hardened) | The customer-managed `example-agent-{env}-task-read` policy (defined inline in `main.tf` via `data.aws_iam_policy_document.task_read_scoped`) replaces the prior AWS-managed `ReadOnlyAccess`. It grants exactly the SDK calls the 10 tools in `app/lib/tools/*.ts` make, scoped to `strata-{env}-*` resource ARNs. The `deny-iam-secrets-kms-reads` inline policy is retained as defense-in-depth. See `services/example-agent/README.md` §"IAM task role (hardened)" for the per-tool mapping and the residual broad-scope surface. |
| `/api/chat` route body | AWS-3.3 | Currently a stub returning `{message: "AWS-3.3 will populate this..."}`. AWS-3.3 wires the Anthropic SDK tool-use loop with the ~10-tool SDK catalog and the ElastiCache LRU cache wrapper. |
| Strata memory dogfooding | AWS-3.2 | The `STRATA_INTERNAL_URL` env var is passed through but the Next.js server doesn't read it yet. AWS-3.2 adds a `lib/strata-client.ts` that calls `store_memory` / `search_history` against the internal endpoint. |

## Auth flow (AWS-3.1)

```
Browser                    Next.js                    Cognito                Google
   │                           │                          │                     │
   │  GET /chat                │                          │                     │
   ├──────────────────────────►│                          │                     │
   │                           │ middleware: no session   │                     │
   │                           │ cookie → 302 to /        │                     │
   │ ◄─────────────────────────┤                          │                     │
   │  GET / (with reason=…)    │                          │                     │
   │                           │  renders "Sign in" btn   │                     │
   │  click "Sign in"          │                          │                     │
   ├──────────────────────────►│                          │                     │
   │  GET /api/auth/login      │                          │                     │
   │                           │ generate state nonce     │                     │
   │                           │ set state cookie         │                     │
   │                           │ 302 to authorize URL     │                     │
   │ ◄─────────────────────────┤                          │                     │
   │  GET /oauth2/authorize    │                          │                     │
   ├──────────────────────────────────────────────────────►│                     │
   │                           │   Cognito presents       │                     │
   │                           │   federation choices     │                     │
   │  click "Continue with     │                          │                     │
   │   Google"                 │                          │                     │
   │                           │                          │   federate          │
   │                           │                          ├────────────────────►│
   │                           │                          │                     │
   │                           │                          │   user authenticates│
   │                           │                          │ ◄───────────────────┤
   │                           │   PreSignUp Lambda:      │                     │
   │                           │     allowlist check      │                     │
   │                           │     (AWS-3.2)            │                     │
   │                           │   PostConfirmation:      │                     │
   │                           │     add to `approved`    │                     │
   │                           │     (AWS-3.2)            │                     │
   │                           │                          │                     │
   │  302 /api/auth/callback   │                          │                     │
   │  ?code=...&state=...      │                          │                     │
   │ ◄──────────────────────────────────────────────────────┤                     │
   │  GET /api/auth/callback   │                          │                     │
   ├──────────────────────────►│                          │                     │
   │                           │ check state cookie       │                     │
   │                           │ POST /oauth2/token       │                     │
   │                           ├─────────────────────────►│                     │
   │                           │ ◄─────────────────────────┤                     │
   │                           │   {access_token,id_token}│                     │
   │                           │ verify access token      │                     │
   │                           │ assert `approved` group  │                     │
   │                           │ set session cookie       │                     │
   │                           │   HttpOnly Secure        │                     │
   │                           │   SameSite=Lax           │                     │
   │                           │ 302 to /chat             │                     │
   │ ◄─────────────────────────┤                          │                     │
   │  GET /chat                │                          │                     │
   ├──────────────────────────►│                          │                     │
   │                           │ deep-verify session JWT  │                     │
   │                           │ render chat surface      │                     │
   │ ◄─────────────────────────┤                          │                     │
```

A request that arrives without the `approved` group (because the Pre-signup Lambda hasn't been wired yet, or the user is genuinely pending approval) gets a 403 from `/api/chat` and a redirect to `/?error=not_approved` from `/chat`.

## Inputs

See `variables.tf` for the full set with descriptions.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `env_name` | yes | — | `dev|staging|prod`. |
| `aws_region` | no | `us-east-1` | Cognito + SSM region. |
| `google_client_id` | no | `""` | Google OAuth app — empty skips Google federation. |
| `google_client_secret_arn` | no | `""` | Secrets Manager ARN. |
| `initial_allowlist` | no | `["mkavalich@gmail.com"]` | Seeded into the SSM parameter. Mutate in-place after apply. |
| `app_url` | no | `https://localhost:3000` | Public URL — used as Cognito callback base + APP_URL container env. |
| `container_image` | no | sentinel | Real applies pass an ECR-pushed image tag. |
| `cluster_arn` | yes | — | From the `ecs-cluster` module. |
| `execution_role_arn` | yes | — | Task execution role (image pull + log writes). |
| `log_group_name` | yes | — | CloudWatch log group for container logs. |
| `vpc_id` | yes | — | From the `network` module. |
| `vpc_cidr` | yes | — | From the `network` module. |
| `subnet_ids` | yes | — | Private subnets for Fargate task ENIs. |
| `ingress_backend` | no | `apigw` | `alb` or `apigw`. |
| `attach_to_alb_listener_arn` / `alb_listener_priority` | conditional | `""` / `200` | When `ingress_backend = alb`. |
| `attach_to_apigw_vpc_link_id` / `apigw_api_id` / `apigw_integration_uri` | conditional | `""` | When `ingress_backend = apigw`. |
| `callback_urls` / `logout_urls` | no | localhost defaults | Override per-env. |
| `strata_internal_url` | no | `""` | Explicit override. When unset, derived from `cluster_service_connect_namespace` + `strata_internal_port`. |
| `cluster_service_connect_namespace` | no | `""` | Cloud Map namespace for ECS Service Connect (e.g. `strata-dev`). |
| `strata_internal_port` | no | `3000` | Strata service port for the derived URL. |
| `strata_auth_proxy_token_secret_arn` | no | `""` | Pass `module.strata.auth_proxy_secret_arn` from the Phase 2 strata service. |
| `cpu` / `memory` / `desired_count` / `container_port` | no | `512` / `1024` / `1` / `3000` | Fargate task shape. |
| `extra_tags` | no | `{}` | Merged into default tag set. |

## Outputs

`service_arn`, `service_name`, `task_role_arn`, `task_role_name`, `security_group_id`, `app_url`, `user_pool_id`, `user_pool_arn`, `user_pool_client_id`, `user_pool_client_secret` (sensitive), `cognito_hosted_ui_url`, `cognito_hosted_ui_domain`, `cognito_jwks_uri`, `cognito_issuer_url`, `google_federation_enabled`, `approved_group_arn`, `allowlist_ssm_path`, `allowlist_ssm_arn`, `allowlist_kms_key_arn`, `allowlist_kms_alias`.

## How to plan (dev account, today)

```powershell
cd E:\strata\strata\templates\aws\services\example-agent\infrastructure

# 1. Confirm identity (must be mike-cli @ 624990353897)
aws sts get-caller-identity

# 2. Validate
terraform fmt -check -recursive
terraform init -backend=false
terraform validate
tflint
checkov -d .

# 3. Plan-only validation against the dev example
cd examples\dev
terraform init
terraform validate
# `terraform plan` requires Phase 1 to be applied — sentinel ARNs in the
# example fail at plan time. Do NOT apply during AWS-3.1 verification.
```

## Cost (dev idle)

| Component | Monthly cost (dev idle) |
|---|---|
| Cognito User Pool (Essentials, ≤ 50K MAU) | $0.00 |
| Cognito Plus tier (advanced security AUDIT, ≤ 50 MAU) | $0.00 |
| 3 Lambda triggers (Cognito-invoked, dev volume) | ~$0.00 |
| 3 Lambda log groups (7-day retention) | ~$0.00 |
| Allowlist CMK | ~$1.00 |
| Allowlist SSM SecureString (Standard tier) | $0.00 |
| Fargate Spot task (1× 0.5 vCPU / 1 GB) | ~$5.00 |
| **Total at idle** | **~$6.00** |

NAT-egress charges for the Cognito Hosted UI redirects are negligible at portfolio scale.

## Reviewers required before apply

- **`security-compliance`** — federation IdP wiring, App Client OAuth flow restriction, allowlist CMK key policy, SSM parameter access pattern. The cognito-user-pool module's own security checklist still applies — review `modules/cognito-user-pool/README.md` §"Security notes".
- **`finops-analyst`** — Plus-tier cost projection if MAU is expected to exceed 50.

## Verification (post-apply)

```bash
# Service is running
aws ecs describe-services --cluster <cluster> --services example-agent-dev

# Allowlist parameter exists and is the right shape
aws ssm get-parameter --name /example-agent/dev/allowed-emails --with-decryption \
  --query 'Parameter.Value' --output text | jq .

# Cognito Hosted UI loads
curl -I "$(terraform output -raw cognito_hosted_ui_url)/login?response_type=code&client_id=$(terraform output -raw user_pool_client_id)&redirect_uri=$(terraform output -raw app_url)/api/auth/callback&scope=email+openid+profile&state=verify"

# Smoke test: hitting /chat without a session redirects (curl follows
# redirects with -L, so we look for the Location header instead)
curl -I "$(terraform output -raw app_url)/chat"
# Expect: HTTP/1.1 307 Temporary Redirect, Location: /?reason=unauthenticated

# Without `approved` group: hitting /api/chat with a fresh-signup token
# returns 403
curl -X POST "$(terraform output -raw app_url)/api/chat" \
  -H "Cookie: eag_session=<paste-fresh-token>" -i
# Expect: HTTP/1.1 403 Forbidden, body: {"error":"User is not in the 'approved' group..."}
```

## Related tickets

- **This:** AWS-3.1 (`specs/2026-04-25-strata-deploy-aws-plan.md`).
- **Blocks:** AWS-3.2 (Lambdas + Strata memory wiring), AWS-3.3 (SDK tool catalog + IAM policy).
- **Blocked-by:** AWS-1.3 (`ecs-service`), AWS-1.8 (`cognito-user-pool`), AWS-1.11 (`ingress`).
