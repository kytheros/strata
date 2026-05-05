# `envs/dev/` — Strata-on-AWS dev orchestrator

Top-level Terraform composition for the dev environment. This is the canonical
"`task up` brings the whole stack up" entry point — every Phase 1 module +
Phase 2 + Phase 3 service is instantiated here with module outputs flowing
directly between them.

## Why this exists (AWS-1.5.1)

Before this directory's `main.tf` existed, the per-module `examples/basic/`
served double duty: validation harness AND apply target. They wired modules
together with **sentinel ARNs** (placeholder strings shaped like real AWS
ARNs) so `terraform validate` would pass — but those sentinels block
`terraform apply` because they don't reference live resources.

The end-to-end validation cycle on 2026-05-05 hit this wall: applying the
service composition examples (`services/strata/examples/dev/`,
`services/example-agent/infrastructure/examples/dev/`) failed with
"resource not found" errors against the sentinel ARNs.

Phase 1.5 fix: this orchestrator. Outputs flow directly between modules
inside Terraform's resource graph — no sentinels, no
`terraform_remote_state` lookups, no copy-paste ARNs.

## Tool choice

**Terraform 1.7+ with AWS provider 5.x.** Same rationale as the rest of
`templates/aws/`: this template is consumed by external customers who
pin the toolchain at the account level, so a vendor-lock'd choice (CDK,
Pulumi) would constrain consumers. The orchestrator is plumbing — the
modules underneath are the real engineering.

## Layout

```
envs/dev/
├── backend.tf              # S3 + DynamoDB backend (provisioned by AWS-0.1)
├── main.tf                 # Module composition — the orchestrator itself
├── variables.tf            # Top-level inputs (12 variables)
├── outputs.tf              # Surface for ops + CI/CD smoke tests
├── terraform.tfvars        # Operator-supplied; gitignored
├── terraform.tfvars.example# Seed for above
└── README.md               # This file
```

## Operating cadence

The dev environment costs **~$345/mo idle** when fully deployed. To keep
the bill under ~$50/mo, **destroy the stack between work sessions**:

| State                        | Cost / mo | When                     |
| ---------------------------- | --------- | ------------------------ |
| bootstrap-only               | ~$0       | between sessions         |
| bootstrap + full orchestrator| ~$345     | active dev / interview   |
| 4 hr/wk active               | ~$2       | typical                  |
| 24/7                         | $345      | not the plan             |

Use `task dev:up` and `task dev:down` from `templates/aws/`; bootstrap stays
up always.

## Operational setup before first apply

These are one-time, out-of-band, manual steps. The orchestrator depends on
all of them being done before `task dev:up` succeeds.

1. **AWS profile pinned to dev account.** `aws sts get-caller-identity`
   must return account `624990353897`. The orchestrator's provider block
   has `allowed_account_ids` pinned to this value — wrong-account applies
   abort early.

2. **Bootstrap applied.** Apply `templates/aws/bootstrap/examples/dev/`
   exactly once per account. Provisions the S3 state bucket + DynamoDB
   lock table that this directory's `backend.tf` references.

3. **Container image built + pushed.** The example-agent Next.js
   container needs to be in a registry the ECS execution role can pull
   from (typically the dev account's ECR). See
   `terraform.tfvars.example` for the build/push flow.

4. **(Optional) Google OAuth client.** If you want federated sign-in,
   create the OAuth app at https://console.cloud.google.com/apis/credentials,
   store the client secret in Secrets Manager (manually — never via
   Terraform), and populate `google_client_id` + `google_client_secret_arn`
   in tfvars.

5. **(Post-first-apply) Anthropic API key seeded.** The example-agent's
   tool-use loop reads `ANTHROPIC_API_KEY` from a Secrets Manager secret
   that's created EMPTY at apply time. Seed it after the first apply:

   ```bash
   aws secretsmanager put-secret-value \
     --secret-id "$(terraform output -raw anthropic_api_key_secret_arn)" \
     --secret-string "sk-ant-..."
   ```

6. **(Post-first-apply) Allowlist populated.** Edit the SSM parameter
   directly — Terraform's `lifecycle.ignore_changes` keeps re-applies
   from clobbering operator edits:

   ```bash
   aws ssm put-parameter \
     --name "$(terraform output -raw allowlist_ssm_path)" \
     --value '["a@b.com","c@d.com"]' \
     --type SecureString \
     --overwrite
   ```

7. **(Post-first-apply) tfvars updated with real app URL.** See "Two-pass
   apply pattern" below.

## Two-pass apply pattern

`var.example_agent_app_url` is a chicken-and-egg input: Cognito needs the
public URL at create time (for callback / logout URL configuration), but
the public URL is the API Gateway endpoint that Terraform produces during
the same apply.

The fix is two passes:

1. **First apply** — `example_agent_app_url` is a placeholder
   (any well-formed `https://<host>` works; the value is parked on the
   Cognito user pool but doesn't have to be reachable). The apply
   creates the API Gateway and emits `ingress_endpoint_dns`.

2. **Update tfvars** — copy `terraform output -raw ingress_endpoint_dns`
   into `terraform.tfvars` as `example_agent_app_url = "https://<that>"`.

3. **Second apply** — Terraform sees the Cognito user pool's
   callback / logout URLs changed, updates them in place. ~30 sec.

This is documented at the top of `terraform.tfvars.example`.

## What's NOT in the orchestrator (deliberate exclusions)

- **`modules/cloudfront-dist`.** Requires a real ACM certificate provisioned
  in `us-east-1`. CloudFront cycling is also slow (~20 min to delete a
  distribution). Apply it via the per-module Taskfile entry
  (`task cloudfront-dist:up`) once you have a cert — not as part of
  `task dev:up`.

- **`modules/s3-bucket`.** No downstream consumer in v1. Strata runs in
  pure-Postgres mode (no per-tenant SQLite); the example-agent uses
  Service Connect for inter-service traffic (no S3 dependency). Re-enable
  in `main.tf` when the v2 Litestream-on-AWS path lands.

- **Per-module standalone `examples/basic/`.** Those remain as
  module-validation harnesses (good for unit-testing module changes
  in isolation). They no longer serve as apply targets.

## Module-output gaps to watch

The orchestrator wires modules via their `outputs.tf` contracts. A few
gaps surfaced during composition that are worth tracking — none block
the apply, but they're places where the next iteration could tighten
the wiring:

- **`module.network` does not expose `vpc_endpoint_security_group_id`
  with the right ingress shape for service-SG-scoped rules.** Aurora +
  Redis fall back to `vpc_cidr` for ingress in dev. Tightening to
  service-SG-scoped requires a second apply (services exist after the
  cluster + ingress) and is acceptable in dev.

- **`module.ingress` (apigw) does not expose a per-route attachment
  helper.** Each service's composition wires its own
  `aws_apigatewayv2_integration` + `aws_apigatewayv2_route` against
  the ingress's `vpc_link_id` + `api_id`. Working as designed —
  centralizing route attachment in the ingress module would couple
  services to ingress changes.

- **`module.aurora_postgres` does not expose `cluster_arn_suffix`
  for ALB-style alarms.** Not used by the dev orchestrator (ALB is
  staging/prod), but staging tfvars will need to derive the suffix
  via `replace(...)` if observability's ALB alarms are enabled.

## Adding staging / prod

When a staging or prod account exists:

1. Apply `bootstrap/examples/{staging,prod}/` against the new account
   (copy + adjust `examples/dev/`).

2. Copy `envs/dev/` to `envs/{env}/`. Edit:

   - `backend.tf` — change `bucket` to `terraform-state-{account_id}-{env}`.
   - `main.tf` — change `local.env_name`.
   - `terraform.tfvars` — change `vpc_cidr` (10.41.0.0/16 staging,
     10.42.0.0/16 prod), `app_url`, image tags, `alarm_subscribers`,
     and consider flipping `ingress_backend = "alb"` (requires ACM cert
     + cloudfront).

3. Add `task staging:up` / `task prod:up` mirroring the `dev:*` tasks
   in `templates/aws/Taskfile.yml`.

The modules themselves are env-parameterized — no module code changes
are needed for new environments.

## Troubleshooting

- **`Error: BucketAlreadyExists`** during `terraform init` — bootstrap
  hasn't been applied yet. Run `task bootstrap:up` first.

- **`Error: account does not match allowed_account_ids`** — wrong AWS
  profile. `aws sts get-caller-identity` to confirm; switch profiles
  via `AWS_PROFILE=...`.

- **Cognito user pool callback URL mismatch on signup** — the two-pass
  apply pattern wasn't completed. Re-read `terraform output -raw
  ingress_endpoint_dns`, update tfvars, re-apply.

- **`terraform plan` references sentinel ARNs** — should not happen with
  this orchestrator. If it does, you're inside one of the per-module
  `examples/basic/` directories — `cd` to `envs/dev/` and re-plan.

## Reviewers

- IAM / KMS / Cognito / SG changes — `security-compliance` agent.
- Alarm wiring → `observability-sre`.
- Cost-sensitive changes (Aurora capacity, NAT, RDS Proxy) → `finops-analyst`.
- CI/CD → `cicd-engineer`. Phase 4 (`AWS-4.1`) targets this directory as
  the single deploy entry point.
