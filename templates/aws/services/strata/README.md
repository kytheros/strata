# `services/strata` — Strata-on-AWS service composition

Composition module that runs the community Strata MCP server
(`ghcr.io/kytheros/strata-mcp:latest`) on AWS Fargate in multi-tenant
Postgres mode behind a Cognito-authenticated ingress.

## Tool choice

**Terraform / OpenTofu.** Same rationale as the rest of `templates/aws/`:
multi-account, cross-cloud surface area (Strata also ships to Cloudflare and
GCP), and the IaC is consumed by external customers — a typed-DSL fence (CDK)
would constrain the consumer's tooling without commensurate benefit. This
module composes existing Phase 1 modules; it owns no new low-level
resources beyond two service-scoped Secrets Manager entries and an optional
S3 bucket for the v2 SQLite path.

## What this module IS

A *composition layer*. It instantiates:

- `modules/secrets` × 2 — synthesized `DATABASE_URL` + `STRATA_AUTH_PROXY_TOKEN`
- `modules/ecs-service` × 1 — the Strata Fargate service, wired to the cluster + ingress
- `modules/s3-bucket` × 0 or 1 — optional, off by default; reserved for v2 Litestream

It does **not** define any `aws_ecs_*`, `aws_db_*`, `aws_elasticache_*`,
`aws_cognito_*`, or `aws_lb_*` resources directly. Consumers wire those via
the corresponding Phase 1 module instances and pass the relevant outputs
into this module's variables.

## What this module IS NOT

- **A container build.** The community image at
  `ghcr.io/kytheros/strata-mcp` already supports `STORAGE_BACKEND=pg` (per
  `strata/CLAUDE.md` §"Transport Modes"). No new Dockerfile lives here.
- **A schema migration runner.** Aurora Postgres 15.x is wire-compatible with
  Strata's existing migration scripts. The migrations run unchanged — the
  one-time bootstrap procedure is documented below in §"Aurora schema
  parity". Cycling the dev account between `task up` / `task down` does not
  re-run migrations; they run once per Aurora cluster lifetime.
- **A JWT verifier.** Cognito JWT verification happens at the ingress layer
  (API GW Cognito authorizer or ALB `authenticate-cognito` action) — see
  `modules/ingress/README.md` and §"Auth flow" below.

## Auth flow

Strata's HTTP transport runs in *trusted-proxy mode* on AWS:

```
                 Cognito User Pool
                        ▲
                        │ (1) JWT issued
                        │
   Browser ──── Hosted UI redirect ────→ Cognito
      │                                     │
      │ (2) auth code                       │
      ▼                                     │
   Browser ←────── access token ────────────┘
      │
      │ (3) Authorization: Bearer <jwt>
      ▼
   ┌──────────────────────────────────────────────┐
   │  Ingress (API GW HTTP API or ALB HTTPS)      │
   │  - Cognito authorizer / authenticate-cognito │  (4) verify jwt
   │  - Map sub → X-Strata-User                   │      via JWKS at
   │  - Set X-Strata-Verified: $TOKEN             │      cognito_jwks_uri
   └─────────────────┬────────────────────────────┘
                     │ (5) request + headers
                     ▼
   ┌──────────────────────────────────────────────┐
   │  Strata Fargate task                         │
   │  STRATA_REQUIRE_AUTH_PROXY=1                 │  (6) verifies header
   │  STRATA_AUTH_PROXY_TOKEN=<from secret>       │      sentinel,
   │  STRATA_MULTI_TENANT=1                       │      then trusts
   │  → opens per-tenant DB by X-Strata-User      │      X-Strata-User
   └──────────────────────────────────────────────┘
```

The two halves of (4) — JWT verification AND header injection — are owned
by the ingress module. The Cognito authorizer in `modules/ingress` does
the verification half on the API GW backend; on the ALB backend, the
`authenticate-cognito` listener action does it.

### Header-injection follow-up (not blocking AWS-2.1)

The ingress module's Cognito authorizer (apigw) and `authenticate-cognito`
listener rule (alb) cover the JWT *verification* half cleanly. The
*header-injection* half — mapping the verified caller's `sub` claim into
`X-Strata-User` and writing `X-Strata-Verified: <token>` — is a separate
piece of wiring:

| Backend | Mechanism |
|---|---|
| API GW HTTP API | Request mapping templates on the Cognito authorizer's integration response. Templates pull `$context.authorizer.claims.sub` into `X-Strata-User` and the static `var.auth_proxy_token` into `X-Strata-Verified`. |
| ALB | Lambda@Edge (CloudFront) or a small auth-rewrite Lambda fronting the ALB. ALB listener rules can't manipulate request headers directly; the rewrite Lambda is the AWS-recommended pattern. |

Both paths are **deferred to a follow-up ticket** that lands alongside the
ingress module's hardening (and the AWS-3.x example-agent's wiring of the
same pattern). The Strata service is plumbed correctly to *enforce* the
contract today — `STRATA_REQUIRE_AUTH_PROXY=1` will reject any request
that doesn't carry the verified header — so the security boundary is
correctly closed even before the rewrite layer ships. The behavior pre-
follow-up is: every request returns `401 missing X-Strata-Verified` until
the rewrite layer is wired. That is the correct fail-closed default.

## Why DATABASE_URL is a synthesized secret

Strata's Postgres adapter reads `DATABASE_URL` on boot. We could have set
host/user/db as plaintext env vars and the password as a separate
`*_PASSWORD` secret — but Strata expects one URL string. This module
therefore synthesizes a `postgres://...?sslmode=require` value and stores
it in Secrets Manager; the `password` portion uses a dynamic-reference
pointer (`{{resolve:secretsmanager:<arn>:SecretString:password}}`) into the
AWS-managed Aurora master credential JSON. ECS resolves the pointer at task
launch — the password never crosses Terraform state, and rotation of the
Aurora master credential is picked up on the next task restart without any
re-apply here.

## Aurora schema parity (one-time ops step)

Strata's Postgres mode runs migrations from `strata/src/storage/pg/`. Aurora
Postgres 15.x is wire-compatible with the schemas Strata already produces
on Cloud SQL, so the same migrations run unchanged. **This is a one-time
manual ops step**, not part of this module's Terraform — running migrations
on every apply would cause drift and slow plans.

After the first apply:

```bash
# 1. Ensure Phase 1 + this service are up.
task up
task strata-service:up

# 2. Pin the Strata image we want to migrate against.
IMAGE=ghcr.io/kytheros/strata-mcp:latest

# 3. Run the one-shot migration as a Fargate task using the same task role
#    and network shape as the running service. Override the entrypoint to the
#    migration tool and let the container exit when done.
TASK_DEF=$(aws ecs describe-services \
  --cluster strata-dev \
  --services strata-dev \
  --query 'services[0].taskDefinition' \
  --output text)

SUBNETS=$(terraform -chdir=modules/network/examples/basic output -json private_subnet_ids | jq -r 'join(",")')
SVC_SG=$(terraform -chdir=services/strata/examples/dev output -raw security_group_id)

aws ecs run-task \
  --cluster strata-dev \
  --launch-type FARGATE \
  --task-definition "$TASK_DEF" \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SVC_SG],assignPublicIp=DISABLED}" \
  --overrides '{
    "containerOverrides": [{
      "name": "strata",
      "command": ["node", "dist/cli/migrate.js", "up"]
    }]
  }' \
  --started-by mike-cli/migrate

# 4. Verify schema landed.
#    Open a one-shot psql via session-manager or a temporary debug task; or
#    use the RDS query editor in the console. Expected output: ~10 strata_*
#    tables plus knowledge_entries / events / etc.
psql "postgres://strata_admin@<proxy-endpoint>:5432/strata?sslmode=require" -c '\dt'
```

If Strata's migration entrypoint name diverges from `dist/cli/migrate.js`,
update the `command` override above. The community image's Dockerfile is
the source of truth for the actual binary path.

This procedure runs **once per Aurora cluster lifetime**, not once per
deploy. Cycling `task strata-service:down` / `task strata-service:up`
during dev does not require re-running it; cycling `task aurora-postgres:down`
followed by `aurora-postgres:up` does (the data is gone with the cluster).

## Inputs

| Variable | Required | Default | Source |
|---|---|---|---|
| `env_name` | yes | — | caller |
| `aws_region` | no | `us-east-1` | caller |
| `vpc_id` | yes | — | `network` module |
| `vpc_cidr` | yes | — | `network` module |
| `private_subnet_ids` | yes | — | `network` module |
| `cluster_arn` | yes | — | `ecs-cluster` module |
| `cluster_execution_role_arn` | yes | — | caller (thin task-execution role) |
| `cluster_log_group_name` | yes | — | `ecs-cluster` module |
| `aurora_proxy_endpoint` | yes | — | `aurora-postgres` |
| `aurora_database_name` | no | `strata` | `aurora-postgres` |
| `aurora_master_username` | yes | — | `aurora-postgres` |
| `aurora_master_secret_arn` | yes | — | `aurora-postgres` |
| `aurora_consumer_iam_policy_json` | yes | — | `aurora-postgres` |
| `aurora_security_group_id` | yes | — | `aurora-postgres` |
| `redis_endpoint` | yes | — | `elasticache-redis` |
| `redis_port` | no | `6379` | `elasticache-redis` |
| `redis_auth_secret_arn` | yes | — | `elasticache-redis` |
| `redis_consumer_iam_policy_json` | yes | — | `elasticache-redis` |
| `redis_security_group_id` | yes | — | `elasticache-redis` |
| `cognito_user_pool_id` | yes | — | `cognito-user-pool` |
| `cognito_user_pool_client_id` | yes | — | `cognito-user-pool` |
| `cognito_jwks_uri` | yes | — | `cognito-user-pool` |
| `ingress_backend` | yes | — | `"alb"` or `"apigw"` |
| `ingress_listener_arn` | conditional | `""` | `ingress` (alb) |
| `ingress_alb_listener_priority` | no | `100` | caller |
| `ingress_alb_path_patterns` | no | `["/*"]` | caller |
| `ingress_alb_host_headers` | no | `[]` | caller |
| `ingress_vpc_link_id` | conditional | `""` | `ingress` (apigw) |
| `ingress_apigw_api_id` | conditional | `""` | `ingress` (apigw) |
| `ingress_apigw_integration_uri` | conditional | `""` | caller (apigw) |
| `ingress_endpoint_dns` | yes | — | `ingress` |
| `container_image` | no | `ghcr.io/kytheros/strata-mcp:latest` | caller |
| `container_port` | no | `3000` | caller |
| `cpu` | no | `512` | caller |
| `memory` | no | `1024` | caller |
| `desired_count` | no | `1` | caller |
| `autoscaling_min` | no | `1` | caller |
| `autoscaling_max` | no | `3` | caller |
| `log_level` | no | `info` | caller |
| `max_dbs` | no | `200` | caller (multi-tenant LRU pool) |
| `create_user_data_bucket` | no | `false` | v2 Litestream path |
| `extra_tags` | no | `{}` | caller |

## Outputs

| Output | Type | Notes |
|---|---|---|
| `service_name` | string | `strata-<env>` |
| `service_arn` | string | ECS service ARN |
| `task_role_arn` | string | IAM task role ARN |
| `task_definition_arn` | string | task def ARN with revision |
| `security_group_id` | string | service ENI SG; pass to Aurora/Redis as `allowed_security_group_ids` |
| `target_group_arn` | string \| null | non-null when backend=alb |
| `apigw_integration_id` | string \| null | non-null when backend=apigw |
| `health_check_url` | string | `https://<ingress_endpoint_dns>/health` |
| `database_url_secret_arn` | string | synthesized `DATABASE_URL` secret ARN |
| `auth_proxy_secret_arn` | string | `STRATA_AUTH_PROXY_TOKEN` secret ARN |
| `user_data_bucket_arn` | string \| null | non-null when create_user_data_bucket=true |

## Validation

```bash
cd services/strata
terraform fmt -check -recursive
terraform init -backend=false
terraform validate
tflint
checkov -d .

cd examples/dev
terraform init -backend=false
terraform validate
# `terraform plan` is intentionally NOT run from examples/dev. The example's
# default variable values are sentinel ARNs/IDs that do not exist in any
# account; `plan` would fail the data-source resolution against the live
# AWS APIs. Use this example as a wiring template only, or replace the
# sentinels with your own outputs (or terraform_remote_state lookups) before
# planning.
```

## Cost

When the dev stack is up:

| Component | Notes | $/mo idle |
|---|---|---|
| 1× Fargate Spot task (cpu=512, mem=1024) | desired_count=1, no traffic | ~$5 |
| 2× Secrets Manager secrets + per-secret CMKs | DATABASE_URL + STRATA_AUTH_PROXY_TOKEN | ~$2.80 |
| Service-scoped CloudWatch Logs | uses cluster's log group; metered with cluster | ~$0 |
| **Strata service total** | | **~$8/mo** |

This excludes the Phase 1 footprint underneath (network ~$265, Aurora ~$25,
Redis ~$11, ALB ~$16 if used). On-demand pricing roughly triples the
Fargate component (~$18/mo). The full stack idle is **~$345/mo** per the
top-level Taskfile cost block; this service contributes ~$8 of that.

## Related modules

- `modules/ecs-service` — the workhorse this composition wraps
- `modules/aurora-postgres` — the database-of-record for Strata's pg backend
- `modules/elasticache-redis` — JWKS / license / per-tenant cache layer
- `modules/cognito-user-pool` — JWT issuer (verification at ingress)
- `modules/ingress` — API GW (dev) or ALB (staging/prod)
- `modules/secrets` — re-used twice here for DATABASE_URL + auth-proxy token
