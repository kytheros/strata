# `aws/bootstrap` — per-account state + OIDC trust

**Tool choice: Terraform (OpenTofu compatible).** Reason: the rest of the AWS deploy template is Terraform; using the same tool for bootstrap keeps the toolchain singular and lets future automation (`terraform import`, `terraform plan -refresh-only`) operate on the bootstrap resources the same way it does on everything else.

## What this creates (per account)

| Resource | Name | Purpose |
|---|---|---|
| S3 bucket | `terraform-state-{env}-us-east-1` | Remote state storage. Versioned, SSE-S3 encrypted, public access blocked, deny-non-TLS bucket policy, noncurrent versions expire after 90 days. |
| DynamoDB table | `terraform-state-locks` | Lock table (`LockID` string PK), PAY_PER_REQUEST, SSE on. |
| IAM OIDC provider | `token.actions.githubusercontent.com` | Trust anchor for GitHub Actions. Account-wide singleton. |
| IAM role | `strata-cicd-deploy-role` | Assumed by `mkavalich/strata` GitHub Actions workflows on `main`. **Currently has `AdministratorAccess`** — see "Known sharp edges" below. |

All resources are tagged: `Project=strata`, `Component=bootstrap`, `ManagedBy=terraform`, `Environment={env_name}`.

## Inputs

See `variables.tf` for the full list. The required ones:

| Variable | Example | Notes |
|---|---|---|
| `env_name` | `"dev"` | One of `dev`, `staging`, `prod`. Drives bucket naming + tags. |
| `repo_slug` | `"mkavalich/strata"` | Pins the OIDC trust to this repo only. |

Useful optionals:

- `allowed_branches` — branches that may assume the role. Defaults to `["main"]`.
- `allowed_environments` — GitHub Actions environment names that may assume the role. Use this for prod ("require reviewers" gate). Defaults to `[]`.
- `create_oidc_provider` — flip to `false` if the OIDC provider already exists in the account (it's a per-account singleton). The module then looks it up via `data "aws_iam_openid_connect_provider"`.

## Outputs

`state_bucket_name`, `state_bucket_arn`, `lock_table_name`, `lock_table_arn`, `deploy_role_arn`, `oidc_provider_arn`, `account_id`. The first three feed `envs/{env}/backend.tf`.

## How to run (dev account, today)

```bash
# 1. Confirm identity
aws sts get-caller-identity
# Expect: {"Account": "624990353897", "Arn": "arn:aws:iam::624990353897:user/mike-cli"}

# 2. Plan + apply
cd strata/templates/aws/bootstrap/examples/dev
terraform init
terraform plan -out=plan.tfplan
terraform apply plan.tfplan

# 3. Wire envs/dev to the new backend (already done in this commit, just init)
cd ../../../envs/dev
terraform init
```

After step 2, the dev state bucket and lock table exist and `strata-cicd-deploy-role` is ready for GHA to assume.

## How to expand to staging / prod (later)

The module is account-agnostic. When the AWS Organization is created and dev/staging/prod member accounts are provisioned, you do **not** change any code in this module. You only:

1. **Create the staging account** in the AWS Organization. Note its account ID.
2. **Configure an AWS CLI profile** for it (e.g. `aws configure --profile strata-staging` or assume the OrganizationAccountAccessRole from the management account).
3. **Add an example caller** at `bootstrap/examples/staging/main.tf` — copy `examples/dev/main.tf` and change:
   - `env_name = "staging"`
   - `allowed_account_ids = ["<staging-account-id>"]` in the provider block
   - `allowed_environments = ["staging"]` (or whatever you want to gate)
4. **Run** the same `terraform init / plan / apply` cycle against the new profile (`AWS_PROFILE=strata-staging terraform apply`).
5. **Add `envs/staging/backend.tf`** as a copy of `envs/dev/backend.tf`, changing:
   - `bucket = "terraform-state-staging-us-east-1"`
   - `key   = "envs/staging/terraform.tfstate"`
   - `allowed_account_ids = ["<staging-account-id>"]`
6. Repeat for prod.

That's the entire expansion path — no module changes, no refactor.

## Design choices worth knowing

### OIDC provider singleton handling

The GitHub OIDC provider is a per-account singleton (only one provider per `(account, issuer URL)` pair). On first bootstrap, `create_oidc_provider = true` creates it. If you tear the bootstrap down and re-run it without first deleting the OIDC provider out-of-band, set `create_oidc_provider = false` and the module will look it up via a data source instead. The role's trust policy resolves through `local.oidc_provider_arn` which picks the right source either way.

Alternative considered: a `try()`-based "create if missing" pattern. Rejected because it makes the plan output non-deterministic — you can't tell whether the next run will create or skip until you read the data source. An explicit boolean is uglier but legible.

### SSE-S3 not SSE-KMS for the state bucket

Bootstrap deliberately avoids depending on a KMS key it doesn't own. Adding KMS here would create a chicken-and-egg between the key and the role allowed to use it. AWS-1.x modules use SSE-KMS for service-owned buckets where the module also owns the key.

### `AdministratorAccess` on the deploy role — temporary

The role currently has `AdministratorAccess` so the rest of Phase 1 (network, ECS, Aurora, etc.) can deploy without us iteratively expanding policy after each failure. **AWS-5.1 replaces this with a least-privilege policy** generated by running `iam-policy-simulator` against the actual module surface and pinning the result. Until that ticket lands, treat the role as effectively root in the account — only `mkavalich/strata` `main` (and explicit GitHub environments) can assume it, and the OIDC `sub` claim is pinned, but blast radius is large if those guardrails fail. Track via `security-compliance` review.

### Tag set is intentionally small

`Project / Component / ManagedBy / Environment`. The design spec calls for a richer set (`Owner`, `CostCenter`) but those need org-level decisions. Bootstrap stays minimal; AWS-5.1 propagates the full set via a default-tags provider block once we have authoritative values.

## Verification

After a successful apply, sanity check:

```bash
aws s3api get-bucket-versioning --bucket terraform-state-dev-us-east-1
# → "Status": "Enabled"

aws s3api get-bucket-encryption --bucket terraform-state-dev-us-east-1
# → "SSEAlgorithm": "AES256"

aws dynamodb describe-table --table-name terraform-state-locks --query 'Table.TableStatus'
# → "ACTIVE"

aws iam list-open-id-connect-providers
# → arn:...:oidc-provider/token.actions.githubusercontent.com

aws iam get-role --role-name strata-cicd-deploy-role --query 'Role.AssumeRolePolicyDocument'
# → confirms StringLike pin to repo:mkavalich/strata:ref:refs/heads/main
```

End-to-end OIDC validation is in AWS-0.1's plan: a dummy GHA workflow calls `aws sts get-caller-identity` after assuming `strata-cicd-deploy-role`. That happens in CI, not from this README.

## Reviewers required before apply

- `security-compliance` — IAM trust policy + AdministratorAccess decision.
- `finops-analyst` — DynamoDB PAY_PER_REQUEST is fine for lock table volume; sanity check the noncurrent-version retention number against expected state churn.

## Related tickets

- **This:** AWS-0.1 (`specs/2026-04-25-strata-deploy-aws-plan.md`).
- **Next:** AWS-1.1 `network` module — blocked by this apply.
- **Replaces AdministratorAccess:** AWS-5.1.
