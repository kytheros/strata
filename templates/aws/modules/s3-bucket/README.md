# `aws/modules/s3-bucket` — versioned, SSE-KMS encrypted, optional CloudFront OAC

**Tool choice: Terraform (OpenTofu compatible).** Reason: matches the rest of the AWS deploy template; `aws_s3_bucket_*` resources have first-class provider coverage and the OAC integration plays cleanly with `cloudfront-dist` (AWS-1.7) downstream.

## What this creates

A reusable, opinionated S3 bucket primitive consumed three times by the design (per `2026-04-25-strata-deploy-aws-design.md` §"Storage layout"):

| Caller | `purpose` | Versioning | OAC | Lifecycle |
|---|---|---|---|---|
| `strata-artifacts-…` | `artifacts` | on | **on** (CloudFront origin) | none (or transitions for old releases) |
| `strata-user-data-…` | `user-data` | on | off (private; future Litestream replication target) | none (app-controlled retention) |
| `strata-logs-…` | `logs` | **off** (rotation handled by lifecycle) | off | expire 90d, transition to GLACIER_IR at 30d |

Resources, default config:

| Resource | Notes |
|---|---|
| `aws_s3_bucket` | Default name `strata-${purpose}-${account_id}-${env_name}`. The account-id segment is **mandatory** — S3 names share a single global namespace. Override only for imports of pre-existing names. |
| `aws_s3_bucket_ownership_controls` | `BucketOwnerEnforced` — disables ACLs entirely. |
| `aws_s3_bucket_versioning` | `Enabled` by default; `Suspended` when `versioning_enabled = false`. |
| `aws_s3_bucket_server_side_encryption_configuration` | `aws:kms` with bucket-key on (~99% fewer KMS calls). |
| `aws_s3_bucket_public_access_block` | All four toggles `true`. |
| `aws_s3_bucket_policy` | `DenyInsecureTransport` (mandatory) + optional `AllowCloudFrontServicePrincipalReadOnly`. |
| `aws_s3_bucket_lifecycle_configuration` | Conditional on `length(var.lifecycle_rules) > 0`. |
| `aws_kms_key` + `aws_kms_alias` | Conditional on `var.kms_key_id == ""`. 7-day deletion window, key rotation on, alias `alias/strata-${purpose}-${env_name}`. |
| `aws_cloudfront_origin_access_control` | Conditional on `var.cloudfront_oac_enabled = true`. |

All resources tagged `Project=strata`, `Component=s3-bucket`, `ManagedBy=terraform`, `Environment={env_name}`, `Purpose={purpose}`.

## Why an account-id-suffixed name

S3 bucket names live in **one global namespace across all AWS accounts**. `strata-artifacts-dev` would conflict the moment a second account tries the same name. Every Strata bucket therefore embeds the 12-digit account id, which is unique by definition. The suffix is invisible to users (CloudFront and IAM see ARNs, not names) and trivial to grep in CloudTrail.

## Why a per-bucket CMK by default

Three buckets × three envs = nine CMKs at full multi-account fan-out. That's ~$9/month — the price of total blast-radius isolation. If `strata-user-data` is ever compromised, rotating its key doesn't invalidate `strata-artifacts` or `strata-logs` content. Pass `var.kms_key_id` to share a CMK across buckets when the security model permits.

## Inputs

See `variables.tf` for the full list with validations.

| Variable | Required? | Default | Notes |
|---|---|---|---|
| `env_name` | yes | — | One of `dev`, `staging`, `prod`. |
| `purpose` | yes | — | Short label (`artifacts` / `user-data` / `logs`). Drives bucket name + tags. Must match `[a-z0-9-]+`. |
| `aws_region` | no | `us-east-1` | Used in CMK alias and provider sanity. |
| `bucket_name_override` | no | `""` | Use only for imports of buckets whose existing names don't match the pattern. |
| `versioning_enabled` | no | `true` | Set `false` for log-style buckets. |
| `kms_key_id` | no | `""` | Empty → module creates a CMK. Pass an ARN to bring your own. |
| `cloudfront_oac_enabled` | no | `false` | Set `true` when this bucket is a CloudFront origin. |
| `cloudfront_distribution_arn` | no | `""` | Tightens the OAC bucket-policy `SourceArn` to a single distribution. Falls back to account-scope when empty. |
| `lifecycle_rules` | no | `[]` | List of `{ id, enabled, prefix?, expiration_days?, noncurrent_version_expiration_days?, transitions? }`. |
| `extra_tags` | no | `{}` | Merged into default tags. |

## Outputs

`bucket_id`, `bucket_name`, `bucket_arn`, `bucket_regional_domain_name`, `kms_key_arn`, `kms_key_alias` (null when consumer-provided), `oac_id` (null when OAC disabled).

## Examples

- `examples/basic/` — `purpose = "artifacts"` in dev. Default config (versioning on, module-created CMK, no OAC). Targets the dev account `<ACCOUNT_ID>`.
- `examples/with-oac/` — `purpose = "user-data"` in dev plus a stub `aws_cloudfront_distribution` consuming the OAC. Demonstrates end-to-end wiring; not a production-quality CDN config.

## Caller patterns

### `strata-artifacts` (CloudFront origin)

```hcl
module "artifacts_bucket" {
  source = "../../modules/s3-bucket"

  env_name = "dev"
  purpose  = "artifacts"

  cloudfront_oac_enabled      = true
  cloudfront_distribution_arn = module.cloudfront_dist.arn  # tightens SourceArn
}
```

### `strata-user-data` (private, future replication)

```hcl
module "user_data_bucket" {
  source = "../../modules/s3-bucket"

  env_name = "dev"
  purpose  = "user-data"
  # versioning on (default), no OAC, no lifecycle
}
```

### `strata-logs` (90-day expiration with GLACIER_IR transition)

```hcl
module "logs_bucket" {
  source = "../../modules/s3-bucket"

  env_name           = "dev"
  purpose            = "logs"
  versioning_enabled = false  # logs rotate via lifecycle, not versions

  lifecycle_rules = [
    {
      id              = "expire-90d"
      enabled         = true
      expiration_days = 90
      transitions = [
        { days = 30, storage_class = "GLACIER_IR" },
      ]
    },
  ]
}
```

## How to run (dev account, today)

```bash
# 1. Confirm identity
aws sts get-caller-identity   # <your-cli-user> @ <ACCOUNT_ID>

# 2. From modules/s3-bucket/examples/basic/
terraform init
terraform plan -out plan.tfplan
# Review carefully — bucket + CMK + alias + 5 supporting resources.
terraform apply plan.tfplan
```

## Cost (always-on, per bucket)

| Component | Monthly |
|---|---|
| CMK (when module-created) | $1.00 |
| Storage at idle | $0 |
| Requests at idle | $0 |
| **Total at idle** | **~$1 / month** |

Add S3 storage + request fees per actual usage. The CMK is the only mandatory floor cost; everything else scales from zero.

## Reviewers required before apply

- **`security-compliance`** — Bucket policy `DenyInsecureTransport` is mandatory; CloudFront OAC `SourceArn` scoping; KMS key policy least-privilege (S3 service principal scoped to `aws:SourceAccount`).
- **`finops-analyst`** — Lifecycle rules for `logs` and `artifacts` callers; CMK-per-bucket vs shared-CMK trade-off if the bucket count balloons.

## Verification (post-apply)

```bash
# Bucket exists, encryption + versioning visible
aws s3api get-bucket-encryption --bucket strata-artifacts-<ACCOUNT_ID>-dev
aws s3api get-bucket-versioning --bucket strata-artifacts-<ACCOUNT_ID>-dev
aws s3api get-public-access-block --bucket strata-artifacts-<ACCOUNT_ID>-dev

# Bucket policy denies non-TLS
aws s3api get-bucket-policy --bucket strata-artifacts-<ACCOUNT_ID>-dev --query 'Policy' --output text | jq .

# CMK alias resolves
aws kms describe-key --key-id alias/strata-artifacts-dev

# (with OAC) OAC exists
aws cloudfront list-origin-access-controls --query 'OriginAccessControlList.Items[?Name==`strata-user-data-<ACCOUNT_ID>-dev-oac`]'
```

## Related tickets

- **This:** AWS-1.6 (`specs/2026-04-25-strata-deploy-aws-plan.md`).
- **Blocked-by:** AWS-0.1 (bootstrap state backend).
- **Unblocks on apply:** AWS-1.7 (`cloudfront-dist`) — uses this module's `bucket_regional_domain_name` and `oac_id` outputs.
- **Coordinates with:** Three Phase-2/3 callers (`strata-artifacts`, `strata-user-data`, `strata-logs`).
