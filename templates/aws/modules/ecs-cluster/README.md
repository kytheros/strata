# `aws/modules/ecs-cluster` — Fargate cluster + CMK-encrypted log group + Exec role

**Tool choice: Terraform (OpenTofu compatible).** Reason: matches the rest of the AWS deploy template, so a single `terraform plan` covers the whole stack. Module is account-agnostic and consumed by `examples/basic/` for dev today; staging and prod wire up identically when those accounts are provisioned (see "Multi-account expansion" below).

## What this creates

A Fargate-only ECS cluster with the operational primitives a service needs from day one:

| Resource | Count | Notes |
|---|---|---|
| ECS Cluster | 1 | `strata-{env}`. Container Insights ON. ECS Exec configured cluster-wide with KMS-encrypted session logs landing in this cluster's CloudWatch group. |
| Capacity providers | 2 | `FARGATE` + `FARGATE_SPOT`. Default strategy: 80% spot / 20% on-demand. Tunable via `fargate_spot_weight` or replaced wholesale via `capacity_provider_strategy`. |
| KMS CMK + alias | 1 + 1 | `alias/strata-{env}-ecs-logs`. Rotation enabled. Deletion window 7d (matches portfolio-demo cycle cadence; bump via `kms_deletion_window_days` for prod). Resource policy scopes CloudWatch Logs use to log groups under this cluster's prefix in this region/account. |
| CloudWatch Log Group | 1 | `/ecs/strata-{env}`, 30d retention (variable), encrypted with the per-cluster CMK. Cluster-scoped — services with their own log group bypass this and own their lifecycle. |
| ECS Exec operator role | 1 | `strata-{env}-ecs-exec-operator`. Trusted by the account root; permissions scoped tightly to this cluster's task ARNs + the cluster's log group + SSM Session Manager data plane. Operators assume to run `aws ecs execute-command`. |

All resources tagged with `Project=strata`, `Component=ecs-cluster`, `ManagedBy=terraform`, `Environment={env_name}`. The cluster carries an additional `Name = strata-{env}` tag for console legibility.

## Why no EC2 capacity providers

Per design §"Compute: ECS Fargate" — Fargate-only at this scale. EKS (and EC2 capacity providers as a stepping stone) is a v3 conversation, not v1. The capacity-provider variable validation explicitly rejects EC2 names so an accidental `vars.tfvars` typo doesn't silently introduce node ops.

## Why a per-cluster CMK, not a shared envelope key

A per-cluster key is destroy-safe: tearing down the cluster also tears down its key, no cross-module state to track. The portfolio-demo cycle (see `templates/aws/Taskfile.yml`) destroys and recreates the cluster routinely; a shared key would either need to outlive the cluster (bad — orphaned key bills) or get torn down by a different module (worse — fragile resource ownership).

The 7-day deletion window is the AWS minimum and matches that cycle cadence. In `PendingDeletion` state the key continues to bill at ~$1/mo until the window elapses, which is acceptable when destroy/recreate happens at most weekly. Production should bump to 30 days via `kms_deletion_window_days` for the recovery buffer — once-off destroy events in prod are rare enough that the higher bill from a longer window is worth the safety net.

## ECS Exec — what's enabled and how to use it

Cluster configuration sets `executeCommandConfiguration` so any task launched into this cluster *can* opt into Exec by setting `enableExecuteCommand = true` on its run-task call (or on its service definition). The configuration here doesn't force-enable Exec on every task — task definitions still own that bit — but it routes the session output through the cluster CMK and into the cluster's log group when a task does opt in.

To open a session against a running task:

```bash
# 1. Get the task ARN
aws ecs list-tasks --cluster strata-dev --query 'taskArns[0]' --output text

# 2. Open a shell (requires the operator's principal to be allowed to assume
#    arn:aws:iam::624990353897:role/strata-dev-ecs-exec-operator)
aws ecs execute-command --cluster strata-dev \
  --task <task-arn> \
  --container <container-name> \
  --interactive --command "/bin/sh"
```

The operator role's IAM policy is scoped to this cluster only. Tasks in a different cluster (or a future second strata cluster in the same account) won't be reachable from this role — that's by design.

## Inputs

See `variables.tf` for the full list.

| Variable | Required? | Default | Notes |
|---|---|---|---|
| `env_name` | yes | — | One of `dev`, `staging`, `prod`. Drives naming + tags. |
| `aws_region` | no | `us-east-1` | Used in the KMS key policy condition (`logs.<region>.amazonaws.com`) and to construct task ARNs in the exec role policy. |
| `fargate_spot_weight` | no | `80` | 0–100. Weight for `FARGATE_SPOT` in the default capacity provider strategy. The remainder goes to on-demand `FARGATE`. Ignored if `capacity_provider_strategy` is set. |
| `capacity_provider_strategy` | no | `null` | Optional explicit strategy override. List of `{capacity_provider, weight, base}`. Validation rejects EC2 capacity providers. |
| `log_retention_days` | no | `30` | Must be a CloudWatch-supported value (1, 3, 5, 7, 14, 30, 60, 90, …). |
| `kms_deletion_window_days` | no | `7` | 7–30. AWS minimum is 7; bump for prod. |
| `extra_tags` | no | `{}` | Merged into the default tag set. |

## Outputs

`cluster_id`, `cluster_name`, `cluster_arn`, `log_group_name`, `log_group_arn`, `kms_key_arn`, `kms_key_alias`, `exec_role_arn`, `exec_role_name`.

The `cluster_name` and `cluster_arn` outputs are the primary consumers of this module — `ecs-service` (AWS-1.3) takes both. `log_group_arn` is consumed by the `observability` module (AWS-1.10) as a metric-filter target.

## How to run (dev account, today)

```bash
# 1. Confirm identity (must be mike-cli @ 624990353897)
aws sts get-caller-identity

# 2. From modules/ecs-cluster/examples/basic/
terraform init
terraform plan -out plan.tfplan
# Review carefully — KMS key + IAM role — before applying.
terraform apply plan.tfplan
```

## How to expand to staging / prod (later)

The module is account-agnostic. When staging and prod accounts exist:

1. Create `modules/ecs-cluster/examples/staging/main.tf` and `examples/prod/main.tf` as copies of `examples/basic/main.tf`, changing:
   - `env_name = "staging"` (or `"prod"`)
   - Backend `bucket` → the env's state bucket from its bootstrap apply
   - Backend `key` → `examples/ecs-cluster-basic/terraform.tfstate` (still namespaced per account-bucket)
   - `allowed_account_ids = ["<env-account-id>"]`
   - For prod, bump `kms_deletion_window_days` to `30` and consider lowering `fargate_spot_weight` toward 50 (or 0 for stability-critical workloads).
2. Run `terraform init / plan / apply` against the env's AWS profile.

When the real `envs/{env}/main.tf` files come online (Phase 2+), they consume `module "ecs_cluster"` directly with the same source path. The example-folder pattern is for module-development testing; the production wiring will live in `envs/`.

## Cost summary (always-on, dev account, this module only)

| Component | Monthly |
|---|---|
| ECS Cluster | $0 (no charge for the cluster object itself) |
| Capacity providers | $0 (charged per-task-hour at the service layer, not here) |
| KMS CMK | ~$1 (flat $1/mo per CMK in `Enabled` state) |
| CloudWatch Logs (idle, no tasks) | $0 (charged on ingest + storage; cluster with no tasks ingests nothing) |
| **Total at idle** | **~$1 / month** |

Once services land on the cluster, the dominant costs are Fargate task-hours, log ingest ($0.50/GB), and Container Insights metrics ($0.30/metric/month — `finops-analyst` reviews at the AWS-1.10 / AWS-2.x boundary).

## Reviewers required before apply

- **`security-compliance`** — KMS key resource policy (account root + scoped CW Logs principal), ECS Exec role trust policy + permissions scope.
- **`observability-sre`** (after first apply) — wire the cluster's log group + Container Insights metrics into the SLO dashboard built in AWS-1.10.

## Verification (post-apply)

```bash
# Cluster active with Container Insights ON
aws ecs describe-clusters --clusters strata-dev \
  --include SETTINGS \
  --query 'clusters[0].{name:clusterName,status:status,settings:settings}'

# Capacity providers attached
aws ecs describe-clusters --clusters strata-dev \
  --query 'clusters[0].{providers:capacityProviders,strategy:defaultCapacityProviderStrategy}'

# KMS key + alias
aws kms describe-key --key-id alias/strata-dev-ecs-logs \
  --query '{arn:KeyMetadata.Arn,rotation:KeyMetadata.KeyRotationStatus,state:KeyMetadata.KeyState}'
aws kms get-key-rotation-status --key-id alias/strata-dev-ecs-logs

# Log group encrypted with the CMK
aws logs describe-log-groups --log-group-name-prefix /ecs/strata-dev \
  --query 'logGroups[0].{name:logGroupName,kms:kmsKeyId,retention:retentionInDays}'

# Exec role exists and trusts the account root
aws iam get-role --role-name strata-dev-ecs-exec-operator \
  --query 'Role.{name:RoleName,trust:AssumeRolePolicyDocument}'
```

## Related tickets

- **This:** AWS-1.2 (`specs/2026-04-25-strata-deploy-aws-plan.md`).
- **Blocked-by:** AWS-1.1 (`network`) per the plan's sequencing graph; this module does not consume network outputs directly (Fargate clusters are regional, not VPC-bound) but services on the cluster will, so the dependency is enforced at the next module up the chain.
- **Unblocks on apply:** AWS-1.3 (`ecs-service`), AWS-1.10 (`observability` — pairs cluster log group + Container Insights metrics with alarms once `aurora-postgres` and `elasticache-redis` are also live).
- **Coordinates with:** AWS-1.10 (`observability`) — that module attaches alarms (ECS task shortfall, ALB-side metrics for services on this cluster).
