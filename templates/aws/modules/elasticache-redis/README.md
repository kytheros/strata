# `aws/modules/elasticache-redis` — Serverless Redis with TLS + AUTH + per-cache CMK

**Tool choice: Terraform (OpenTofu compatible).** Reason: matches the rest of the AWS deploy template; the cache + KMS + Secrets Manager + SG wiring is a small graph that benefits from Terraform's plan-time visibility.

## What this creates

| Resource | When | Notes |
|---|---|---|
| `aws_kms_key` (CMK) + `aws_kms_alias` | always | Per-cache CMK at `alias/strata-{env}-cache`. 7-day deletion window, automatic rotation on. Account-root admin (escape hatch) + ElastiCache + Secrets Manager service principals via `kms:ViaService`. Encrypts the cache at-rest AND the AUTH-token secret. |
| `random_password` (AUTH token) | always | 64 chars, `override_special` set to ElastiCache-safe symbols (excludes `@`, `"`, `/`). Plaintext never output. |
| `aws_secretsmanager_secret` (AUTH token) | always | Provisioned via the shipped `secrets` module at `strata/{env}/cache/auth-token`. Encrypted with the per-cache CMK so all cache material lives under one key. Initial value seeded from the random password. Rotation NOT wired (rotating an ElastiCache AUTH token requires cache recreation; explicit operator action). |
| `aws_security_group` (cache) | always | Attached to cache ENIs. Egress empty (cache nodes don't initiate outbound). |
| `aws_vpc_security_group_ingress_rule` (per-SG) | when `var.allowed_security_group_ids` non-empty | TCP/6379 from each consumer SG. Preferred path. |
| `aws_vpc_security_group_ingress_rule` (CIDR fallback) | when `var.allowed_security_group_ids` empty | TCP/6379 from `var.vpc_cidr`. Used by the example deploy and one-off operator access. Production callers should pass real consumer SGs. |
| `aws_elasticache_user` + `aws_elasticache_user_group` | always | Default user with the AUTH token attached (`access_string = "on ~* +@all"`). Bound into a one-user group referenced by the cache. |
| `aws_elasticache_serverless_cache` | always | Engine `redis`, major version from `var.engine_version` (default `7`), data-storage + ECPU caps from `var.cache_usage_limits`, daily snapshot retention from `var.daily_snapshot_retention_limit`. KMS-encrypted at rest. TLS-only (Serverless enforces). |

All resources tagged `Project=strata`, `Component=elasticache-redis`, `ManagedBy=terraform`, `Environment={env_name}`.

## Why ElastiCache Serverless (not Memcached, not DynamoDB-with-DAX)

- **Closer port of the Cloudflare KV / GCP Memorystore code paths than DynamoDB.** Strata's existing JWKS cache and license cache speak `GET`/`SETEX` — the Redis API drops in unchanged.
- **No idle floor beyond the Serverless minimum (~$10/mo).** A `t4g.small` cluster is cheaper at sustained load but runs ~$13/mo even at zero QPS, and the `task up` / `task down` cadence in the dev account means we rarely sustain anything.
- **TLS + AUTH are not optional in Serverless.** The provider spec keeps wanting to expose `transit_encryption_enabled` flags from the older cluster-mode resource — Serverless rejects any value other than `required`. Documented in `main.tf` rather than coded as a knob.

## Why Redis (not Valkey) — for now

Valkey is the AWS-blessed Redis fork (post-license change), is now generally available on ElastiCache, and is roughly 20% cheaper for the same throughput. The design spec (`specs/2026-04-25-strata-deploy-aws-design.md`) calls for **Redis**, and we ship Redis to match.

**Valkey swap.** When we're ready, this is a one-flag change in `main.tf`:

```hcl
resource "aws_elasticache_serverless_cache" "this" {
  engine = "valkey"   # was: "redis"
  ...
}
```

Plus a re-roll of `var.engine_version` to a Valkey-supported value (Valkey starts at `7.2`). Everything downstream — the AUTH token, the user group, the security group, the IAM patterns — is identical between the two engines.

## Why per-cache CMK (not the AWS-managed key)

Same logic as the `secrets` module:
- Auditable per-cache key policy (one key, one cache, one secret).
- ~$1/mo cost is negligible against the ~$10/mo Serverless floor.
- The CMK *also* encrypts the AUTH token secret, so all cache material lives under one auditable key.

For high-fanout multi-cache deploys (>5 caches per env), revisit and consider a shared per-service CMK passed in via the secrets module's `kms_key_id` variable.

## Why no egress rules on the cache SG

ElastiCache cache nodes do not initiate outbound connections. The Terraform `aws_security_group` resource defaults to creating a `0.0.0.0/0` allow-all egress rule when no egress is specified — we override that by managing egress out-of-band via `aws_vpc_security_group_egress_rule` resources (none, in our case) plus `lifecycle.create_before_destroy`. Net result: zero egress rules attached to the cache SG. This keeps the blast radius tight if the cache process is ever compromised.

## Inputs

| Variable | Required? | Default | Notes |
|---|---|---|---|
| `env_name` | yes | — | `dev|staging|prod`. |
| `aws_region` | no | `us-east-1` | Used in `kms:ViaService` conditions. |
| `vpc_id` | yes | — | From the network module's `vpc_id` output. |
| `vpc_cidr` | yes | — | Used as the fallback ingress source when no consumer SGs are passed. From the network module's `vpc_cidr` output. |
| `subnet_ids` | yes | — | Typically the network module's `isolated_subnet_ids`. Minimum 2; Strata deploys across all 3 isolated subnets. |
| `allowed_security_group_ids` | no | `[]` | Preferred ingress source. Each SG ID gets its own ingress rule on TCP/6379. When empty, falls back to VPC-CIDR ingress. |
| `engine_version` | no | `"7"` | Major Redis version. Auto-upgrades disabled on the cache resource. |
| `cache_usage_limits` | no | `{ data_storage_max_gb = 1, ecpu_per_second_max = 5000 }` | Dev defaults. Bump for prod. |
| `daily_snapshot_retention_limit` | no | `1` | Days. Set 7 for prod via `terraform.tfvars`. |
| `extra_tags` | no | `{}` | Merged into the default tag set. |

## Outputs

`cache_id`, `cache_arn`, `endpoint`, `port`, `reader_endpoint`, `auth_secret_arn`, `auth_secret_consumer_iam_policy_json`, `security_group_id`, `kms_key_arn`, `kms_key_alias`, `user_group_id`.

`auth_secret_consumer_iam_policy_json` is the load-bearing one: attach to consumer task roles to grant least-privilege read on the AUTH token.

## How to run (dev account, today)

```bash
# 1. Confirm identity
aws sts get-caller-identity   # → <ACCOUNT_ID> / <your-cli-user>

# 2. Make sure the network module is up first
cd ../../../network/examples/basic
terraform output isolated_subnet_ids
# Update the `local.isolated_subnet_ids` placeholder list in
# elasticache-redis/examples/basic/main.tf with the real subnet IDs.

# 3. Apply this example
cd ../../elasticache-redis/examples/basic
terraform init
terraform plan -out plan.tfplan
terraform apply plan.tfplan   # ~5–7 min
```

## Consumer wiring pattern

The Strata Fargate service (AWS-2.1) and the example-agent (AWS-3.3) both consume this module. The shape is:

```hcl
module "cache" {
  source = "../../modules/elasticache-redis"

  env_name = var.env_name
  vpc_id   = module.network.vpc_id
  vpc_cidr = module.network.vpc_cidr
  subnet_ids = module.network.isolated_subnet_ids

  # Mutual SG scoping: cache SG allows our service SG; our service SG
  # allows egress to the cache SG.
  allowed_security_group_ids = [module.strata_service.security_group_id]
}

# Wire up consumer egress to the cache.
resource "aws_vpc_security_group_egress_rule" "service_to_cache" {
  security_group_id            = module.strata_service.security_group_id
  referenced_security_group_id = module.cache.security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
  description                  = "Strata service → Redis cache"
}

# Grant the task role read on the AUTH token.
resource "aws_iam_role_policy" "task_read_cache_auth" {
  name   = "read-cache-auth"
  role   = module.strata_service.task_role_id
  policy = module.cache.auth_secret_consumer_iam_policy_json
}

# Inject the endpoint + secret ARN into the task definition.
# Service container reads the secret at boot via the SDK and connects via:
#   redis://default:${authToken}@${endpoint}:6379  (TLS — note rediss://)
```

## Security notes

- **TLS is required.** Serverless rejects clear-text connections at the API level. Consumers connect via `rediss://` (note the double-s).
- **AUTH token plaintext never leaves Secrets Manager.** It's marked sensitive at the `random_password` level, stored in Secrets Manager, and only the secret ARN is output. State files still contain it (Terraform's state model has no way around this) — the bootstrap S3 backend SSE-encrypts state and locks down access.
- **AUTH token rotation requires cache recreation.** AWS does not support in-place rotation of the AUTH token on a Serverless cache. We do not auto-rotate; rotating is an explicit operator action: regenerate via `terraform apply -replace=module.cache.random_password.auth` and accept the cache rebuild.
- **No internet path.** The cache lives in isolated subnets (no NAT route), and the SG egress is empty. The only path in is from the consumer SGs on TCP/6379.
- **Account-root in the KMS key policy is intentional.** AWS-recommended escape hatch — without it, a key can become unmanageable if all IAM admins are revoked. Scoped to this key only (KMS key policies' `Resource: "*"` semantically means "this key"). Documented via `checkov:skip` annotations.

## Cost (dev, idle)

| Component | Monthly |
|---|---|
| ElastiCache Serverless minimum (1 GB-hr storage + idle ECPU) | ~$10 |
| Per-cache KMS CMK | ~$1 |
| Secrets Manager secret (AUTH token) | ~$0.40 + ~$0.05 per 10k reads |
| **Idle floor** | **~$11–12 / month** |

The $10 Serverless minimum is the dominant cost. ECPU rate caps protect against runaway bills if a consumer goes wrong. Production caches with sustained throughput will cost more, dominated by ECPU consumption (1 ECPU = 1 simple GET/SET).

> Note (2026-05-04): AWS quietly adjusted Serverless storage minimums in early 2026. The ~$10 figure is conservative and reflects the data-storage floor + a small idle ECPU baseline. Use `aws-pricing get_pricing` against `AmazonElastiCache` filter `cacheUsageType=ServerlessRedis*` for the live number before committing to a long-running deploy.

## Reviewers required before apply

- **`security-compliance`** — KMS key policy (account-root admin + service principals), AUTH-token secret access pattern, SG ingress source choice (consumer SG vs CIDR fallback).
- **`finops-analyst`** — `cache_usage_limits` choice for the consumer's expected throughput. ECPU cap is the primary cost lever.

## Verification (post-apply)

```bash
# Cache exists and is encrypted
aws elasticache describe-serverless-caches --serverless-cache-name strata-dev-cache \
  --query 'ServerlessCaches[0].{Status:Status,Engine:Engine,KmsKeyId:KmsKeyId,Endpoint:Endpoint}'

# CMK exists with rotation on
aws kms describe-key --key-id alias/strata-dev-cache \
  --query 'KeyMetadata.{KeyState:KeyState,KeyManager:KeyManager,KeyRotationEnabled:KeyRotationEnabled}'

# AUTH token secret exists and is encrypted under the cache CMK
aws secretsmanager describe-secret --secret-id strata/dev/cache/auth-token \
  --query '{Name:Name,KmsKeyId:KmsKeyId}'

# Round-trip test from a Fargate one-off (TLS + AUTH):
# AUTH=$(aws secretsmanager get-secret-value --secret-id strata/dev/cache/auth-token \
#   --query SecretString --output text)
# redis-cli --tls -h <endpoint> -p 6379 -a "$AUTH" PING   # → PONG
```

## Related tickets

- **This:** AWS-1.5 (`specs/2026-04-25-strata-deploy-aws-plan.md`).
- **Blocked-by:** AWS-1.1 (`network` — vpc_id, vpc_cidr, isolated subnets).
- **Unblocks on apply:** AWS-2.1 (Strata service consumes `endpoint`, `port`, `auth_secret_arn`), AWS-1.10 (`observability` adds Redis-side alarms — engine CPU, byte-engine usage, ECPU consumed).
- **Coordinates with:** AWS-1.9 (`secrets` — used as a child module for the AUTH-token secret).
