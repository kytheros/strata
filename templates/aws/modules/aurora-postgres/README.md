# `aws/modules/aurora-postgres` — Aurora Serverless v2 + RDS Proxy + per-cluster CMK

**Tool choice: Terraform (OpenTofu compatible).** Reason: matches the rest of the AWS deploy template; the cluster + proxy + KMS + parameter-group graph benefits from Terraform's plan-time visibility.

## What this creates

| Resource | When | Notes |
|---|---|---|
| `aws_kms_key` (CMK) + `aws_kms_alias` | always | Per-cluster CMK at `alias/strata-{env}-aurora`. 7-day deletion window, automatic rotation on. Account-root admin (escape hatch) + RDS service principal + Secrets Manager service principal via `kms:ViaService`. Encrypts cluster storage + Performance Insights data + the AWS-managed master credential secret. |
| `aws_db_subnet_group` | always | Across `var.subnet_ids` (typically the network module's three isolated subnets, no internet path). |
| `aws_security_group` (cluster + proxy) | always | Single SG fronts both the cluster ENIs and the RDS Proxy ENIs. Self-ingress on TCP/5432 lets the proxy reach the cluster. Egress empty — neither cluster nor proxy initiate outbound. |
| `aws_vpc_security_group_ingress_rule` (per-SG) | when `var.allowed_security_group_ids` non-empty | TCP/5432 from each consumer SG. Preferred path. |
| `aws_vpc_security_group_ingress_rule` (CIDR fallback) | when `var.allowed_security_group_ids` empty | TCP/5432 from `var.vpc_cidr`. Used by the example deploy. |
| `aws_rds_cluster_parameter_group` | always | Family `aurora-postgresql{major}`. Preloads `pg_stat_statements`. Sets `log_statement = "ddl"` and `log_min_duration_statement = "1000"` for audit-grade slow-query capture. |
| `aws_rds_cluster` | always | Aurora PostgreSQL 15.x Serverless v2. `manage_master_user_password = true` — AWS auto-generates and rotates the master credential. Storage encrypted with the cluster CMK. CloudWatch log export `["postgresql"]`. |
| `aws_rds_cluster_instance` | `var.instance_count` times | `db.serverless` instance class. First is writer, rest are readers. Performance Insights enabled, 7-day retention. Auto minor version upgrade OFF (explicit upgrades only). |
| `aws_iam_role` (proxy) + `aws_iam_role_policy` | always | Proxy assumes this to read the master credential secret. Policy is scoped to exactly that secret + KMS Decrypt on the cluster CMK. |
| `aws_db_proxy` + `aws_db_proxy_default_target_group` + `aws_db_proxy_target` | always | Proxy in front of the cluster. Engine family POSTGRESQL, TLS required, idle timeout from `var.proxy_idle_client_timeout`, connection-pool max from `var.proxy_max_connections_percent`. Auth via the AWS-managed master credential secret (no IAM auth in v1). |

All resources tagged `Project=strata`, `Component=aurora-postgres`, `ManagedBy=terraform`, `Environment={env_name}`.

## Why Aurora Serverless v2 (not RDS, not provisioned Aurora)

- **Burst-friendly billing.** Strata's traffic is spiky — single-tester dev, periodic prod load. v2 scales 0–8 ACU per ACU-second, no idle commitment when paused.
- **Same connection model as provisioned Aurora.** RDS Proxy fronts both shapes identically — no consumer-side change if we ever promote.
- **Postgres parity.** Aurora Postgres 15.x supports the same extensions Strata uses on Cloud SQL. The `pg_stat_statements` GUC, `IF NOT EXISTS` migrations, and `pgcrypto` all work unchanged.
- **30s failover.** Multi-AZ at the storage layer; reader-promote-to-writer in ~30s on AZ failure (only when `instance_count >= 2`, hence the prod recommendation).

We do NOT use plain RDS Postgres because RDS doesn't support scale-to-zero, and the dev cycling cadence makes a paused Aurora cluster materially cheaper. We do NOT use provisioned Aurora because the `db.r7g.large` minimum is ~$170/mo idle — way over the dev-account ceiling.

## Why scale-to-zero (`min_capacity = 0`) by default

AWS provider 5.92+ (Feb 2025) supports `min_capacity = 0` paired with `seconds_until_auto_pause`. Our pinned provider (5.100.0 at module time) satisfies this. The combination yields:

- **~$0 idle** — Aurora storage charges still apply (see "Cost" below), but no ACU-hours.
- **Auto-resume on connect** — first request after pause sees a 5–15 second cold start while the cluster spins up. Acceptable for dev; document for prod.
- **30-min default auto-pause window** — short enough that idle hours pause cleanly, long enough that brief test-suite gaps don't cycle.

For prod, set `min_capacity = 0.5` and `seconds_until_auto_pause = null` in your `terraform.tfvars`. The cold-start penalty is unacceptable when real users are waiting.

## Why `manage_master_user_password = true` (no rotation Lambda)

The plan ticket asked for a 30-day master credential rotation Lambda. AWS-managed rotation (added in late 2023) handles this without a Lambda — see [`lambdas/rotation/README.md`](lambdas/rotation/README.md) for the full rationale and the trigger conditions for adding a custom rotator later.

TL;DR:
- One fewer Lambda to maintain.
- The rotated credential never leaves AWS — no Terraform state churn.
- RDS Proxy picks up rotated values transparently on next connection.
- Trade-off: rotation cadence is AWS-controlled, not operator-controlled.

If a future audit demands a custom cadence, the swap is wiring a Lambda ARN into the shipped `secrets` module and flipping the cluster's credential management mode.

## Why one shared SG for cluster + proxy (with self-ingress)

RDS Proxy ENIs need to reach Aurora cluster ENIs on TCP/5432. We could use two SGs (one for the cluster, one for the proxy, with the cluster SG allowing the proxy SG). We chose one SG with self-ingress instead because:

- The proxy and cluster always share the same blast radius (compromise of one means compromise of the other — they share the master credential).
- Two SGs would not improve segmentation — checkov's recommendation for distinct SGs is for distinct concerns, which this isn't.
- One SG halves the ingress-rule count. Less to audit.

Consumers reach the proxy on TCP/5432 via the same `var.allowed_security_group_ids` ingress, since the proxy uses the same SG.

## Why no IAM database authentication in v1

`iam_database_authentication_enabled = false` (default) means consumers connect using the master username + password (read from Secrets Manager). The alternatives:

- **IAM auth via `rds-db:connect`** — each consumer's task role gets a per-user grant; `aws rds generate-db-auth-token` produces a 15-min-lived token. More complex; better blast radius.
- **IAM auth through RDS Proxy** — the proxy validates IAM, then connects to Aurora using the master credential it already holds.

We default to off because (a) v1 has only one consumer (Strata Fargate), (b) RDS Proxy + Secrets-Manager-managed master cred is the canonical AWS pattern for this scale, and (c) flipping to IAM auth later is one cluster argument + per-consumer policy attachments — not a redesign.

`security-compliance` reviews this default before merge.

## Why no PII tagging in v1

The Strata data model is conversation-derived — every row is potentially PII. Tagging individual columns adds noise without changing the security model: every row needs the same protection. The encryption-at-rest CMK + IAM scope + RDS Proxy gating cover it. If a customer ever brings structured PII (PHI, financial), a future spec adds Glue Data Catalog tags + Secrets Manager column-level mapping — that's a much larger change than annotating columns here.

## Inputs

| Variable | Required? | Default | Notes |
|---|---|---|---|
| `env_name` | yes | — | `dev|staging|prod`. |
| `aws_region` | no | `us-east-1` | Used in `kms:ViaService` conditions. |
| `vpc_id` | yes | — | From the network module's `vpc_id` output. |
| `vpc_cidr` | yes | — | Fallback ingress source when no consumer SGs are passed. |
| `subnet_ids` | yes | — | Typically the network module's `isolated_subnet_ids`. Min 2; module deploys across all that are passed. |
| `allowed_security_group_ids` | no | `[]` | Preferred ingress source. When empty, falls back to VPC CIDR. |
| `engine_version` | no | `"15.5"` | Aurora Postgres major.minor. Pin a value rather than auto-select to keep plans stable. |
| `min_capacity` | no | `0` | Serverless v2 min ACU. `0` = scale-to-zero (requires AWS provider 5.92+). Use `0.5` in prod. |
| `max_capacity` | no | `8` | Serverless v2 max ACU. Burst cap. |
| `seconds_until_auto_pause` | no | `1800` | Idle seconds before auto-pause. Only meaningful when `min_capacity = 0`. Set `null` in prod. |
| `instance_count` | no | `1` | Number of cluster instances. 1 = writer-only (dev). 2+ = HA. |
| `database_name` | no | `"strata"` | Initial DB name. |
| `master_username` | no | `"strata_admin"` | Master DB user. Password is auto-generated by AWS. |
| `backup_retention_period` | no | `1` | Days. Bump to 7+ in prod. |
| `preferred_backup_window` | no | `"03:00-04:00"` | UTC. |
| `preferred_maintenance_window` | no | `"sun:04:30-sun:05:30"` | UTC. |
| `skip_final_snapshot` | no | `true` | Dev: true. Prod: false. |
| `deletion_protection` | no | `false` | Dev: false. Prod: true. |
| `apply_immediately` | no | `true` | Dev: true. Prod: false. |
| `performance_insights_retention_period` | no | `7` | Days. 7 is free tier. |
| `proxy_idle_client_timeout` | no | `1800` | Seconds. |
| `proxy_max_connections_percent` | no | `50` | % of cluster max-connections the proxy may hold open. |
| `extra_tags` | no | `{}` | Merged into the default tag set. |

## Outputs

`cluster_id`, `cluster_arn`, `cluster_resource_id`, `cluster_endpoint` (writer), `cluster_reader_endpoint`, `cluster_port`, `database_name`, `master_username`, `master_user_secret_arn`, `master_user_secret_kms_key_id`, `proxy_endpoint`, `proxy_arn`, `proxy_name`, `kms_key_arn`, `kms_key_alias`, `security_group_id`, `subnet_group_name`, `parameter_group_name`, `consumer_iam_policy_json`.

The load-bearing outputs for downstream service modules:
- `proxy_endpoint` — what consumers put in `DATABASE_URL`. NOT `cluster_endpoint`.
- `master_user_secret_arn` — what consumers read at runtime to get the password.
- `consumer_iam_policy_json` — attach to consumer task roles for least-privilege access.

## How to run (dev account, today)

```bash
# 1. Confirm identity
aws sts get-caller-identity   # → 624990353897 / mike-cli

# 2. Make sure the network module is up first
cd ../../../network/examples/basic
terraform output isolated_subnet_ids
# Update the `local.isolated_subnet_ids` placeholder list in
# aurora-postgres/examples/basic/main.tf with the real subnet IDs.

# 3. Apply this example
cd ../../aurora-postgres/examples/basic
terraform init
terraform plan -out plan.tfplan
terraform apply plan.tfplan   # ~10–15 min — Aurora cluster bootstrap is slow.
```

Connection string shape after apply:

```
DATABASE_URL=postgres://strata_admin:<password>@<proxy_endpoint>:5432/strata?sslmode=require
```

Where `<password>` is read at runtime from `master_user_secret_arn` and `<proxy_endpoint>` comes from the `proxy_endpoint` output.

## Post-apply: enable pg_stat_statements

The parameter group preloads the library, but the extension itself must be created per-database via SQL:

```bash
# One-off psql via a Fargate task or SSM session manager
psql "postgres://strata_admin:<pw>@<proxy_endpoint>:5432/strata?sslmode=require" \
  -c "CREATE EXTENSION IF NOT EXISTS pg_stat_statements;"
```

Future schema-migration tooling (Flyway/Liquibase/dbt) should include this in the bootstrap migration.

## Consumer wiring pattern

The Strata Fargate service (AWS-2.1) consumes this module like:

```hcl
module "aurora" {
  source = "../../modules/aurora-postgres"

  env_name = var.env_name
  vpc_id   = module.network.vpc_id
  vpc_cidr = module.network.vpc_cidr
  subnet_ids = module.network.isolated_subnet_ids

  # Mutual SG scoping: cluster SG allows our service SG; our service SG
  # allows egress to the cluster SG.
  allowed_security_group_ids = [module.strata_service.security_group_id]
}

# Wire up consumer egress to the cluster.
resource "aws_vpc_security_group_egress_rule" "service_to_aurora" {
  security_group_id            = module.strata_service.security_group_id
  referenced_security_group_id = module.aurora.security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "Strata service → Aurora proxy"
}

# Grant the task role read on the master credential secret.
resource "aws_iam_role_policy" "task_read_aurora_cred" {
  name   = "read-aurora-cred"
  role   = module.strata_service.task_role_id
  policy = module.aurora.consumer_iam_policy_json
}

# Inject the proxy endpoint + secret ARN into the task definition.
# Service container reads the secret at boot via the SDK and connects to:
#   postgres://${master_username}:${password}@${proxy_endpoint}:5432/${database_name}
```

## Security notes

- **TLS is required.** RDS Proxy is configured with `require_tls = true`. Consumers must connect with `sslmode=require` or stricter.
- **Master credential plaintext never leaves AWS.** `manage_master_user_password = true` keeps it in Secrets Manager; the proxy reads it via its IAM role; consumer apps read it via `secretsmanager:GetSecretValue` at runtime. Terraform state never sees it.
- **No internet path.** Cluster + proxy live in isolated subnets (no NAT route), and the SG egress is empty. Only path in is from approved consumer SGs on TCP/5432.
- **Storage encryption uses a per-cluster CMK.** Auditable per-cluster key policy. Account-root admin escape hatch is intentional (see `checkov:skip` annotations).
- **Performance Insights data is also CMK-encrypted.** Same key as storage.
- **CloudWatch log exports include only `postgresql`.** No `audit` or `slowquery` (the Postgres engine doesn't have those — they're MySQL-engine-specific). The `log_min_duration_statement = "1000"` parameter writes slow queries (>1s) into the `postgresql` log directly.

## Reviewers required before apply

- **`security-compliance`** — KMS key policy (account-root + RDS + Secrets Manager principals), proxy IAM role scope, IAM-auth-disabled default.
- **`finops-analyst`** — `min_capacity` choice for prod (0 vs 0.5), `seconds_until_auto_pause` cadence, `proxy_max_connections_percent` for expected consumer count.

## Cost (dev, idle)

| Component | Monthly |
|---|---|
| Aurora Serverless v2 ACU when paused (`min_capacity = 0`) | ~$0 |
| Aurora storage (10 GB minimum @ $0.10/GB-mo) | ~$1 |
| Aurora backup storage (1-day retention, equal to DB size) | ~$0 (free up to DB size) |
| **RDS Proxy (always-on, billed per ACU-eq even when cluster is paused)** | **~$15–25** |
| Per-cluster KMS CMK | ~$1 |
| Performance Insights (7-day retention, free tier) | $0 |
| CloudWatch logs (postgresql exports, low volume idle) | <$1 |
| **Idle floor** | **~$17–28 / month** |

The **RDS Proxy is the dominant idle cost** when the cluster is paused. The proxy does not pause — it bills continuously per ACU-equivalent (currently 0.015/hr per "compute unit", typically 1–2 units). For dev cycling sessions, consider including the proxy in the `task down` cycle rather than leaving it up between sessions.

> Note: the AWS-managed master credential secret is currently free (AWS does not charge for secrets it auto-creates as part of `manage_master_user_password`). Verify with `aws-pricing get_pricing` before committing to a long-running deploy if the policy changes.

## Verification (post-apply)

```bash
# Cluster exists and is encrypted
aws rds describe-db-clusters --db-cluster-identifier strata-dev \
  --query 'DBClusters[0].{Status:Status,Engine:Engine,EngineVersion:EngineVersion,KmsKeyId:KmsKeyId,ServerlessV2ScalingConfiguration:ServerlessV2ScalingConfiguration}'

# CMK exists with rotation on
aws kms describe-key --key-id alias/strata-dev-aurora \
  --query 'KeyMetadata.{KeyState:KeyState,KeyManager:KeyManager,KeyRotationEnabled:KeyRotationEnabled}'

# Master credential secret exists (AWS-managed)
aws rds describe-db-clusters --db-cluster-identifier strata-dev \
  --query 'DBClusters[0].MasterUserSecret'

# Proxy is online and targeted at the cluster
aws rds describe-db-proxies --db-proxy-name strata-dev-proxy \
  --query 'DBProxies[0].{Status:Status,EngineFamily:EngineFamily,RequireTLS:RequireTLS,Endpoint:Endpoint}'
aws rds describe-db-proxy-targets --db-proxy-name strata-dev-proxy \
  --query 'Targets[*].{Type:Type,Status:TargetHealth.State,Endpoint:Endpoint}'

# Round-trip test from a Fargate one-off:
# SECRET=$(aws rds describe-db-clusters --db-cluster-identifier strata-dev \
#   --query 'DBClusters[0].MasterUserSecret.SecretArn' --output text)
# PWD=$(aws secretsmanager get-secret-value --secret-id "$SECRET" \
#   --query SecretString --output text | jq -r .password)
# psql "postgres://strata_admin:$PWD@<proxy_endpoint>:5432/strata?sslmode=require" \
#   -c "SELECT version();"
```

## Related tickets

- **This:** AWS-1.4 (`specs/2026-04-25-strata-deploy-aws-plan.md`).
- **Blocked-by:** AWS-1.1 (`network` — vpc_id, vpc_cidr, isolated subnets), AWS-1.9 (`secrets` — composed for credential pattern; v1 uses AWS-native rotation rather than the secrets module's rotation Lambda hook).
- **Unblocks on apply:** AWS-2.1 (Strata service consumes `proxy_endpoint`, `master_user_secret_arn`), AWS-1.10 (`observability` adds Aurora-side alarms — ACU max, CPU, deadlocks, replica lag).
- **Coordinates with:** AWS-1.5 (`elasticache-redis` — both consume the network module's isolated subnets).
