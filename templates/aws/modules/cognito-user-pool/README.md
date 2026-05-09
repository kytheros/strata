# `aws/modules/cognito-user-pool` — User Pool + App Client + groups + Lambda triggers + federation

**Tool choice: Terraform (OpenTofu compatible).** Reason: matches the rest of the AWS deploy template; the user pool's surface area (pool + domain + app client + 5 groups + 3 Lambda functions + 3 IAM roles + 3 log groups + 2 IdPs + 4 Lambda permissions) is heavy on resource-graph edges that Terraform's plan model surfaces clearly. CDK would be reasonable too — Cognito is well-modeled in `aws-cdk-lib/aws-cognito` — but mixing IaC tools across the AWS deploy adds review friction without proportional benefit.

## What this creates

A single Cognito User Pool wired for both Strata-on-AWS auth and the example-agent's federated chat surface, plus three Lambda triggers (one real, two inert default stubs) and optional Google / GitHub federation IdPs.

| Resource | Count | Notes |
|---|---|---|
| `aws_cognito_user_pool` | 1 | `strata-{env}`. Email-as-username, case-insensitive. MFA optional (override). Advanced security AUDIT (override to ENFORCED in prod). 12-char password policy w/ all four complexity classes. Custom attributes `tenant_id` (max 36 chars) and `role` (max 32 chars) — populated by PreTokenGeneration, NOT user-editable. |
| `aws_cognito_user_pool_domain` | 1 | Hosted UI prefix `strata-{env}-{account_id}` (account-id suffix dodges the global Cognito namespace). Override via `var.domain_prefix_override`. |
| `aws_cognito_user_pool_client` | 1 | `{env}-app-client`. OAuth `code` flow only (no implicit). Scopes: `email openid profile`. ID/access TTL 1h, refresh 30d. `prevent_user_existence_errors=ENABLED`. Optional client secret (default on — backend consumers). |
| `aws_cognito_user_group` | 5 | `owner`/`admin`/`member`/`viewer` (Strata RBAC, precedence 0-3) + `approved` (example-agent access gate, precedence 10). |
| `aws_lambda_function` (PreTokenGeneration) | 1 | Real handler — projects `custom:tenant_id`, `custom:role`, and `cognito:groups` into access/id token claims via the v2 trigger event format. Node 22, x86_64, 30s, 256MB, 7-day log retention. |
| `aws_lambda_function` (PreSignUp stub) | 1 | Inert auto-confirm stub. Replaced via `var.pre_signup_lambda_arn` once the example-agent allowlist enforcer ships. |
| `aws_lambda_function` (PostConfirmation stub) | 1 | Inert no-op stub. Replaced via `var.post_confirmation_lambda_arn`. |
| `aws_iam_role` (Lambda exec, ×3) | 3 | Per-Lambda role, scoped to its own log group. |
| `aws_cloudwatch_log_group` (×3) | 3 | `/aws/lambda/strata-{env}-{trigger}`. 7-day retention. |
| `aws_lambda_permission` (Cognito invoke) | 1–3 | Always for PreTokenGeneration; for PreSignUp/PostConfirmation only when the module-shipped stubs are wired (skipped when consumer overrides). |
| `aws_cognito_identity_provider` (Google) | 0–1 | Created when `var.google_client_id` AND `var.google_client_secret_arn` are both non-empty. Client secret pulled from Secrets Manager — never accepted as a TF variable. |
| `aws_cognito_identity_provider` (GitHub) | 0–1 | Created **only** when `var.github_native_oidc_endpoint` is also set. See §"GitHub federation" below. |

All resources tagged `Project=strata`, `Component=cognito-user-pool`, `ManagedBy=terraform`, `Environment={env_name}`.

## Why Cognito, not Supabase Auth, on AWS

Per the design spec §"Auth: AWS Cognito as primary on AWS, federation-only for example-agent": the GCP and Cloudflare deploys keep Supabase, but the AWS deploy uses Cognito specifically because (1) AWS-shop enterprises mandate AWS-native auth, (2) the federation + group + token-projection wiring lands cleanly in IaC, and (3) `aws-jwt-verify` on the backend is one fewer dependency than embedding the Supabase SDK.

## How tenant_id / role flow into tokens

End-to-end:

1. **Provisioning** — At onboarding time, the platform service writes `custom:tenant_id` and `custom:role` to the user via `AdminUpdateUserAttributes`. The App Client's `write_attributes` does **not** include the customs, so end-users cannot self-edit.
2. **Sign-in** — User completes auth (password or federated). Cognito mints a token.
3. **PreTokenGeneration** — The module-shipped Lambda fires. Reads `userAttributes['custom:tenant_id']`, `userAttributes['custom:role']`, and `groupConfiguration.groupsToOverride`. Projects them into the access token's `claimsToAddOrOverride` and the id token's `claimsToAddOrOverride`. Group membership is preserved. Pure event manipulation — no HTTP, no SDK calls, no third-party deps (Strata HTTP client policy: native `fetch` only, and this Lambda doesn't even need that).
4. **Backend authz** — Strata-on-AWS HTTP transport's `aws-jwt-verify` middleware verifies the JWT, then reads `payload.tenant_id` / `payload.role` for one-claim authorization. No Cognito API call per request.

This contract is exercised by an integration test in AWS-2.1 (the Strata-on-AWS service module) that mints a token via `AdminInitiateAuth` and asserts the decoded JWT shape — design spec Risk 1 mitigation.

## Federation

### Google federation (path-(a) — supported)

Google IdP is created when `var.google_client_id` and `var.google_client_secret_arn` are both set. The client secret is pulled from Secrets Manager via `data.aws_secretsmanager_secret_version` at plan time — the value is never accepted as a Terraform variable, never lands in plan output (Terraform marks `data.aws_secretsmanager_secret_version.secret_string` as sensitive), and never appears in `*.tfvars`. State files contain it (Terraform state limitation), which is why the state bucket is SSE-KMS-encrypted with versioning + access logging on, per AWS-0.1.

Attribute mapping is fixed: `email`, `email_verified`, `name`, `picture` flow from Google upstream into Cognito attributes 1-to-1, and `sub` is mapped to the Cognito username (so re-federation is idempotent).

To wire Google federation:

```bash
# 1. Create the OAuth Client in GCP console (Web application).
#    Authorized redirect URI:
#      https://strata-dev-<ACCOUNT_ID>.auth.us-east-1.amazoncognito.com/oauth2/idpresponse

# 2. Store the client secret in Secrets Manager.
aws secretsmanager create-secret \
  --name strata/dev/google-oauth-client-secret \
  --secret-string '<paste-secret-here>' \
  --description "Google OAuth client secret for Strata example-agent dev"

# 3. Pass the ARN + client ID into the module.
#    google_client_id         = "1234.apps.googleusercontent.com"
#    google_client_secret_arn = "arn:aws:secretsmanager:us-east-1:<ACCOUNT_ID>:secret:strata/dev/google-oauth-client-secret-XXXXXX"

# 4. terraform apply.
```

### GitHub federation (path-(b) — deferred)

**GitHub does not natively support OIDC.** GitHub's OAuth2 endpoints (`/login/oauth/authorize`, `/login/oauth/access_token`, `/user`) are OAuth2 only — there is no OIDC discovery document at `/.well-known/openid-configuration`, no JWKS endpoint, no `id_token` mint. Cognito's `OIDC` IdP type expects all three.

Two paths exist:

- **(a) Build an OIDC bridge.** A Lambda@Edge or small Cloudflare Worker that adds OIDC discovery on top of GitHub's OAuth — exposes `/.well-known/openid-configuration` + `/jwks.json` + an OIDC-shaped token endpoint that re-wraps GitHub's access_token. Multiple OSS implementations exist (`github-oidc-proxy`, etc.).
- **(b) Defer GitHub federation to v2 and ship Google only for now.** ← **module default.**

This module accepts `var.github_client_id` / `var.github_client_secret_arn` so the variable surface is forward-compatible, but the GitHub IdP is **only created** when `var.github_native_oidc_endpoint` is also set (the consumer-supplied OIDC bridge URL — which is path-(a)). When that endpoint is empty (the default), GitHub federation is silently skipped — a partial Google-only deploy is the right shape for v1.

When you're ready to wire GitHub:

1. Stand up a `github-oidc-proxy` (or equivalent) at a stable URL. Call it `https://github-oidc.example.com`.
2. Set `var.github_native_oidc_endpoint = "https://github-oidc.example.com"`.
3. Set `var.github_client_id` + `var.github_client_secret_arn` (Secrets Manager).
4. `terraform apply`.

Until then, the example-agent's "Sign in with GitHub" button is hidden by the frontend (`module.cognito_user_pool.github_federation_enabled` is false).

## Hosted UI domain — global namespace handling

Cognito Hosted UI domain prefixes share a single global namespace per region. `strata-dev` is almost certainly taken; `strata-dev-<ACCOUNT_ID>` is not (account IDs are unique, and the AWS-recommended pattern per the iac-architect's "Globally-namespaced resources" convention is to suffix global names with the account ID).

The default domain prefix is `strata-{env_name}-{account_id}`, computed via `data.aws_caller_identity.current.account_id`. To use a custom domain (ACM cert flow), override `var.domain_prefix_override` and wire `aws_cognito_user_pool_domain.custom_domain` separately at the service-module layer.

The Hosted UI login URL surfaces in the `hosted_ui_login_url` output:

```
https://strata-dev-<ACCOUNT_ID>.auth.us-east-1.amazoncognito.com/login
```

Append OAuth params (`response_type`, `client_id`, `redirect_uri`, `scope`, `state`) at the consumer.

## Inputs

See `variables.tf` for the full list with validations.

| Variable | Required? | Default | Notes |
|---|---|---|---|
| `env_name` | yes | — | `dev|staging|prod`. |
| `aws_region` | no | `us-east-1` | Used in the JWKS URL output and IdP attribute mapping. |
| `domain_prefix_override` | no | `""` | Empty → module computes `strata-{env}-{account_id}`. |
| `mfa_configuration` | no | `OPTIONAL` | One of `OFF`/`OPTIONAL`/`ON`. |
| `advanced_security_mode` | no | `AUDIT` | One of `OFF`/`AUDIT`/`ENFORCED`. AUDIT/ENFORCED enable Plus tier. |
| `password_minimum_length` | no | `12` | Range `[8, 99]`. |
| `deletion_protection` | no | `INACTIVE` | `ACTIVE` blocks `DeleteUserPool`. Prod tfvars override. |
| `callback_urls` | no | `["https://localhost:3000/auth/callback"]` | Must be at least one URL. |
| `logout_urls` | no | `["https://localhost:3000"]` | Must be at least one URL. |
| `generate_client_secret` | no | `true` | `false` for SPAs / native apps. |
| `google_client_id` | no | `""` | Empty → no Google federation. |
| `google_client_secret_arn` | no | `""` | Secrets Manager ARN. Empty → no Google federation. |
| `github_client_id` | no | `""` | Accepted but only consumed when the OIDC endpoint is set. |
| `github_client_secret_arn` | no | `""` | Same as above. |
| `github_native_oidc_endpoint` | no | `""` | Pre-built OIDC bridge URL — see §"GitHub federation". |
| `pre_signup_lambda_arn` | no | `""` | Empty → module-shipped inert stub. |
| `post_confirmation_lambda_arn` | no | `""` | Empty → module-shipped inert stub. |
| `extra_tags` | no | `{}` | Merged into the default tag set. |

## Outputs

`user_pool_id`, `user_pool_arn`, `user_pool_endpoint`, `user_pool_client_id`, `user_pool_client_secret` (sensitive), `hosted_ui_domain`, `hosted_ui_login_url`, `hosted_ui_base_url`, `jwks_uri`, `issuer_url`, `pre_token_generation_lambda_arn`, `pre_signup_lambda_arn_effective`, `post_confirmation_lambda_arn_effective`, `groups` (map name→ARN), `google_federation_enabled`, `github_federation_enabled`.

## How to run (dev account, today)

```bash
# 1. Confirm identity (must be <your-cli-user> @ <ACCOUNT_ID>)
aws sts get-caller-identity

# 2. From modules/cognito-user-pool/examples/basic/
terraform init
terraform plan -out plan.tfplan
# Review — the plan creates ~22 resources (pool, domain, client, 5 groups,
# 3 Lambdas, 3 roles, 3 log groups, 3 role policies, 3 invoke permissions).
terraform apply plan.tfplan
```

## Multi-environment expansion

The module is account-agnostic. When staging and prod accounts exist:

1. Create `examples/staging/main.tf` and `examples/prod/main.tf` as copies of `examples/basic/main.tf`, changing:
   - `env_name = "staging"` (or `"prod"`)
   - `mfa_configuration = "ON"` (prod) — match design § Auth requirements
   - `advanced_security_mode = "ENFORCED"` (prod)
   - `deletion_protection = "ACTIVE"` (prod)
   - `callback_urls` / `logout_urls` to the env's public hostnames
   - Backend `bucket` → the env's state bucket
   - `allowed_account_ids = ["<env-account-id>"]`
2. `terraform init / plan / apply` against the env's AWS profile.

## Security notes (`security-compliance` review checklist)

- **OAuth flow restricted to `code`.** Implicit and client_credentials are intentionally omitted.
- **`prevent_user_existence_errors = "ENABLED"`** — prevents user-enumeration via login error codes.
- **`enable_token_revocation = true`** — refresh tokens can be invalidated on logout.
- **Password policy** — 12 chars + all four complexity classes + 1-day temp password validity. NIST SP 800-63B compliant.
- **MFA** — OPTIONAL by default (dev), ON in prod tfvars. SMS MFA intentionally off; TOTP only via `software_token_mfa_configuration`.
- **Advanced security** — AUDIT mode in dev (logs risk events), ENFORCED in prod (adaptive MFA). Plus-tier billing line.
- **Custom attributes** — `tenant_id` and `role` are NOT in the App Client's `write_attributes`, so users cannot self-edit them. PreTokenGeneration is the canonical projection path.
- **Federation client secrets** come from Secrets Manager exclusively. No client secret value ever lives in a Terraform variable, tfvars, or plan output. The state file does store them (Terraform state limitation), so the state backend's S3 bucket must be SSE-KMS encrypted with versioning + access logging on (AWS-0.1 guarantees this).
- **Lambda exec roles** are per-trigger, scoped to their own log group ARN with `:*` suffix for log streams. No cross-trigger reachability.
- **Cognito invoke permissions** are scoped to `source_arn = aws_cognito_user_pool.this.arn` — no other Cognito principal can invoke the trigger Lambdas.
- **Hosted UI domain** uses the global-namespace-safe `strata-{env}-{account_id}` pattern by default — no manual override required.
- **Account-root in the user pool's KMS surface** — the module deliberately does NOT create a CMK for Cognito at-rest encryption; Cognito uses an AWS-owned key by default. CMK upgrade tracked under AWS-1.10 (observability) where the cross-service KMS strategy is owned.

## Cost (dev idle)

Cognito charges by Monthly Active Users (MAU). The Essentials tier is free for 50,000 MAU; Plus tier (which advanced security AUDIT/ENFORCED enables) is free for 50 MAU then $0.0050/MAU.

| Component | Monthly cost (dev idle, ≤50 MAU) |
|---|---|
| User Pool (Essentials) | $0.00 (under 50K MAU) |
| Plus tier (advanced security AUDIT) | $0.00 (under 50 MAU) — bumps to $0.005/MAU after |
| Lambda triggers (3) | ~$0.00 — Cognito invocation rate at dev is < 1k/mo |
| Lambda log groups (3) | ~$0.00 — 7-day retention, ~KB/day at dev volume |
| Hosted UI domain | $0.00 |
| **Total at idle** | **~$0** |

For production at 1k MAU with advanced security ENFORCED: ~$5/mo. Negligible compared to NAT (~$66) and VPC endpoints (~$72).

## Reviewers required before apply

- **`security-compliance`** — full IAM/KMS/auth-boundary audit. Specifically: (1) OAuth flow restriction, (2) password + MFA policy, (3) federation client-secret handling, (4) Lambda exec role least-privilege, (5) Cognito invoke source_arn scoping, (6) `prevent_user_existence_errors`. **The `security-compliance` agent owns this module under AWS-1.8 — they should review their own diff before apply.**
- **`finops-analyst`** — confirm the Plus tier cost projection if the operator expects > 50 MAU (advanced security AUDIT/ENFORCED jumps to $0.005/MAU after the free tier).

## Verification (post-apply)

```bash
# User pool exists with the expected name + custom attributes
aws cognito-idp describe-user-pool --user-pool-id <pool_id> \
  --query 'UserPool.{Name:Name,SchemaAttributes:SchemaAttributes[].Name,LambdaConfig:LambdaConfig}'

# Hosted UI domain is registered
aws cognito-idp describe-user-pool-domain --domain strata-dev-<ACCOUNT_ID>

# 5 groups exist
aws cognito-idp list-groups --user-pool-id <pool_id> --query 'Groups[].GroupName'

# JWKS endpoint serves
curl https://cognito-idp.us-east-1.amazonaws.com/<pool_id>/.well-known/jwks.json | jq .keys[0].kid

# Stub PreSignUp wired (when consumer didn't override)
terraform output -raw pre_signup_lambda_arn_effective
```

## Related tickets

- **This:** AWS-1.8 (`specs/2026-04-25-strata-deploy-aws-plan.md`).
- **Blocked-by:** AWS-0.1 (state backend).
- **Unblocks on apply:**
  - **AWS-2.1** — Strata-on-AWS service consumes `user_pool_id`, `jwks_uri`, `issuer_url`, `user_pool_client_id` for the `aws-jwt-verify` middleware.
  - **AWS-3.1** — example-agent UI consumes `hosted_ui_login_url` for the unauthenticated redirect, `user_pool_client_id` + `user_pool_client_secret` for the OAuth code exchange.
  - **AWS-3.2** — replaces the inert `pre_signup_lambda_arn` and `post_confirmation_lambda_arn` defaults with the example-agent's allowlist enforcer + group-assigner.
- **Coordinates with:**
  - **AWS-1.10** (`observability`) — adds an alarm on Cognito `SignInThrottles` + the PreTokenGeneration Lambda's error metric.
  - **AWS-1.9** (`secrets`) — supplies the Google OAuth client secret when federation is wired.
