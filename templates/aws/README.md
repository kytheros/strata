# Strata-on-AWS deploy template

This directory holds the Terraform that deploys Strata + the AWS-introspection example agent into an AWS account. See `specs/2026-04-25-strata-deploy-aws-design.md` (rev. 2 of 2026-05-04) for the architecture.

## Layout

```
templates/aws/
├── bootstrap/              # AWS-0.1 — state bucket + OIDC. Apply once per account; never destroy.
├── modules/                # Reusable Phase 1 modules (network, ecs-*, aurora-postgres, etc.)
│   └── */examples/basic/   # Standalone validation harnesses — NOT apply targets (sentinel-wired)
├── services/               # Phase 2/3 service compositions (strata, example-agent)
├── envs/                   # Per-environment ORCHESTRATORS (canonical apply path)
│   └── dev/                # AWS-1.5.1 — composes every module with live module-output wiring
├── Taskfile.yml            # `task dev:up` / `task dev:down` controller — see "Operating cadence"
└── README.md               # This file
```

## Local-config setup (operator-only files)

A fresh clone cannot apply. Four operator-specific files / config surfaces are required because they hold per-operator values (account ID, emails, secrets) that must never land in the public repo. Skipping any of them produces a clean, early failure with a setup pointer.

| File / surface | Purpose | Seed from |
|---|---|---|
| `templates/aws/.env` | Holds `EXPECTED_ACCOUNT_ID`. Loaded by the Taskfile's `dotenv:` directive — every `task dev:*` reads it. **Gitignored.** | `templates/aws/.env.example` |
| `templates/aws/envs/dev/backend.dev.hcl` | Partial S3 backend config (`bucket`, `dynamodb_table`). Consumed via `terraform init -backend-config=backend.dev.hcl`. **Gitignored.** | `templates/aws/envs/dev/backend.dev.hcl.example` |
| `templates/aws/envs/dev/terraform.tfvars` | Holds `aws_account_id`, `allowlist_emails`, `cost_alert_email`, `example_agent_container_image`, etc. **Gitignored.** | `templates/aws/envs/dev/terraform.tfvars.example` |
| GitHub repo `vars.AWS_ACCOUNT_ID` | Read by `.github/workflows/aws-template-{ci,apply}.yml` to build the OIDC role ARN. | Set at `https://github.com/<owner>/<repo>/settings/variables/actions` |

Step-by-step setup is in `envs/dev/README.md` §"Local-config setup". The summary is: copy each `.example` to its real name, fill in your values, run `terraform init -reconfigure -backend-config=backend.dev.hcl` once, then `task dev:up`.

## Operating cadence — apply only when working

The dev architecture matches the prod spec (3-AZ, 2× NAT, 11 VPC endpoints, ALB, internal NLB, etc.) for portfolio fidelity. **It costs ~$361/mo idle when fully deployed** (NLB added in AWS-1.6.6), dominated by NAT Gateways (~$66) and interface VPC endpoints (~$197 across 3 AZs); the internal NLB adds ~$16/mo idle.

To keep monthly spend under ~$50, **destroy the stack when you aren't actively working on it**. Bootstrap stays up at ~$0/mo; the rest of Phase 1 cycles in ~6–25 minutes (depending on how many modules are deployed).

| State | Cost / mo | When |
|---|---|---|
| bootstrap-only | ~$0 | between work sessions, default |
| bootstrap + Phase 1 fully applied | ~$361 | active demo / interview / development session |
| Cost if you spin up 4 hr/wk | **~$2** | (stack up 4hr × 4wk = 16hr/mo at $0.49/hr) |
| Cost if you spin up 8 hr/wk | **~$4** | (32hr/mo at $0.49/hr) |
| Cost if you leave it up 24/7 | $361 | not the plan |

## Quick start

```bash
# One-time install (Windows): winget install Task.Task
# One-time install (any OS):   https://taskfile.dev/installation/

# One-time setup — operator-only files (see "Local-config setup" above).
cp .env.example                    .env                                     && $EDITOR .env
cp envs/dev/backend.dev.hcl.example envs/dev/backend.dev.hcl                && $EDITOR envs/dev/backend.dev.hcl
cp envs/dev/terraform.tfvars.example envs/dev/terraform.tfvars              && $EDITOR envs/dev/terraform.tfvars

# One-time per account: apply bootstrap (state bucket + OIDC). Stays up forever.
task bootstrap:up

# One-time per account after bootstrap: lock in the operator-specific backend.
terraform -chdir=envs/dev init -reconfigure -backend-config=backend.dev.hcl

# Start a work session — apply the full dev stack via the orchestrator.
task dev:up      # alias: task up

# Inspect orchestrator outputs (URLs, ARNs for post-apply commands).
task dev:output

# Confirm what's deployed and what it costs.
task status
task cost

# End the work session — destroy everything except bootstrap.
task dev:down    # alias: task down
```

### Single-pass apply (AWS Concierge)

The user-facing app is **AWS Concierge** — a chat surface (rebranded from
"Strata Example Agent") where allowlisted operators ask read-only
questions about the very AWS account it's deployed in. It calls Claude
Sonnet 4.6 with 10 AWS-SDK tools (cost, alarms, ECS, VPC, logs, etc.) and
uses Strata for cross-session memory.

`envs/dev/main.tf` sources `app_url` directly from `module.ingress.endpoint_dns`,
so the Cognito callback URLs resolve in a single apply. No second
`task dev:up` is required.

After `task dev:up` completes, run the **seed script** to finish the
post-apply wiring:

```powershell
E:\strata\strata\templates\aws\scripts\seed-dev-stack.ps1
```

What it does (idempotent — safe to re-run):
1. Adds `canary@strata.test` to the SSM allowlist alongside any seed emails
2. Creates the Cognito test user with a permanent password
3. Seeds the canary credentials secret with that password
4. Seeds the real Anthropic API key (read from `E:\strata\.env`)
5. Force-redeploys the example-agent so it picks up the seeded key

**Anthropic key prerequisite:** create `E:\strata\.env` with a line
`ANTHROPIC_API_KEY=sk-ant-...`. The seed script reads from there; the file
is gitignored.

### Smoke tests

After seeding, validate the full E2E path with the Playwright suite:

```bash
task dev:smoke
```

Six cases run against the live URL: `/health`, landing page, OAuth login
redirect, JWT-rejection on `/mcp`, MCP `initialize`+`tools/list` handshake,
and `POST /api/chat` with a real Claude response.

Cases 5 + 6 need state setup:
- **Case 5** (canary user) — auto-discovered from Secrets Manager + the
  Cognito test-user app client. No manual step.
- **Case 6** (chat) — needs an `eag_session` cookie from a real sign-in:
  ```powershell
  # In Chrome DevTools → Application → Cookies, copy the eag_session value, then:
  Set-Content -Path E:\strata\strata\.work\session-cookie.txt -Value '<paste-cookie-value>'
  ```
  Cookie has a 1-hour TTL; refresh when it expires. The harness emits a
  clear error message naming the file path when missing or expired.

### Pre-flight check

`task dev:up` runs `task dev:preflight` first. Hard-fails on:
- missing/placeholder `ANTHROPIC_API_KEY` in `E:\strata\.env`
- AWS auth not pointing at account `<ACCOUNT_ID>`
- orphan Secrets Manager / KMS resources from a prior teardown
  (run `task cleanup:orphans` to clear them)

Soft-warns on missing Docker (only matters for image rebuilds) and an
optional Anthropic credit-balance probe (cached 1 h; skip with
`SKIP_ANTHROPIC_PROBE=1`).

### Teardown hygiene

`task dev:down` runs `terraform destroy -auto-approve`, then automatically
calls `task cleanup:orphans` to:
- force-delete pending Secrets Manager secrets matching `strata/dev/*`
- schedule pending KMS keys for 7-day deletion + delete their aliases

Without this, the next `task dev:up` collides on AWS's 30-day
secret-recovery window. Standalone `task cleanup:orphans` is safe to
run any time — it short-circuits if the stack is currently up.

See `envs/dev/README.md` for the full operational setup checklist.

## Prerequisites

- AWS CLI v2 with profile `default` configured for account `<ACCOUNT_ID>`
- Terraform `~> 1.7`
- `tflint`, `checkov` (optional but the modules document `# checkov:skip` annotations that expect checkov)
- `task` (https://taskfile.dev) — wraps the destroy/recreate cadence

## Module status (Phase 1.6 closed — 2026-05-06)

| Ticket | Module | Status |
|---|---|---|
| AWS-0.1 | bootstrap | ✅ shipped, applied to dev account |
| AWS-1.1 | modules/network | ✅ shipped, composed by orchestrator (~$265/mo idle) |
| AWS-1.2 | modules/ecs-cluster | ✅ shipped, composed by orchestrator (~$1/mo idle CMK) |
| AWS-1.3 | modules/ecs-service | ✅ shipped, consumed transitively by services/* |
| AWS-1.4 | modules/aurora-postgres | ✅ shipped, composed by orchestrator (~$25/mo idle) |
| AWS-1.5 | modules/elasticache-redis | ✅ shipped, composed by orchestrator (~$11–12/mo idle) |
| AWS-1.5.1 | **envs/dev/ orchestrator** | ✅ shipped — canonical apply path |
| AWS-1.6 | modules/s3-bucket | ✅ shipped, NOT in orchestrator (no v1 consumer) |
| AWS-1.6.1 | **services/ingress-authorizer** | ✅ shipped 2026-05-06 — closes Phase 1.5 deferrals; security review folded HIGH (task SG ingress) + MEDIUM-1 (Service Connect namespace) into closure. AWS-1.6.4 ✅ shipped (sub claim in apigw access log); AWS-1.6.7 ✅ Terraform portion shipped (split `/health` onto a no-header integration; durable core fix tracked as AWS-1.6.7-core). |
| AWS-1.6.6 | **internal NLB in services/ingress-authorizer** | ✅ shipped 2026-05-06 — option-A fix for API GW VPC link → Strata (~$0.50/mo at 8 hr/wk; ~$16/mo idle 24/7). Phase 4 `tools/list` canary now unblocked. |
| AWS-4.1 (obs) | **modules/observability ops dashboard + JWT alarm + services/canary** | ✅ shipped 2026-05-06 — Phase 4 ops dashboard, JWT auth-error rate alarm, EventBridge + Lambda `tools/list` canary, runbooks for both new alarms. Third canary (example-agent end-to-end) still open. |
| AWS-1.7 | modules/cloudfront-dist | ✅ shipped, NOT in orchestrator (needs real ACM cert) |
| AWS-1.8 | modules/cognito-user-pool | ✅ shipped, owned by services/example-agent composition |
| AWS-1.9 | modules/secrets | ✅ shipped, composed by orchestrator + service compositions |
| AWS-1.10 | modules/observability | ✅ shipped, composed by orchestrator (~$2/mo idle) |
| AWS-1.11 | modules/ingress | ✅ shipped, composed by orchestrator (apigw, ~$0/mo idle) |
| AWS-2.1 | services/strata | ✅ shipped, composed by orchestrator (~$8/mo); accepts external auth-proxy secret since 1.6.1 |
| AWS-3.1+ | services/example-agent | ✅ shipped, composed by orchestrator (~$6/mo) |

Per-module `examples/basic/` are now **standalone validation harnesses only** — they wire to sentinel locals and are useful for unit-testing module changes in isolation. The canonical apply path is `task dev:up`, which goes through `envs/dev/`.

### What's wired end-to-end after Phase 1.6 + AWS-1.6.6 (apigw path)

```
External MCP client (Cognito JWT)
        |
        v
  API GW HTTP API
        |
        v
  JWT authorizer (Cognito)
        |
        v
  Integration (X-Strata-Verified header injected via overwrite:)
        |
        v
  VPC Link
        |
        v
  Internal NLB (TCP, target_type=ip)
        |
        v
  Strata Fargate (STRATA_REQUIRE_AUTH_PROXY=1)
```

`GET /health` follows the same path **except** it targets a sibling
`strata_no_header` integration (AWS-1.6.7) with no `request_parameters`
block, so the auth-proxy token is not forwarded on the unauthenticated
health path. Strata's `STRATA_REQUIRE_AUTH_PROXY` gate is enforced only
inside `handleMcpRequest`, not on `/health`.

External MCP clients reach Strata end-to-end. JWT validation at the
edge + shared-secret check at the service = two-layer defense in depth.
AWS-1.6.6 closed the runtime gap by standing up an internal NLB in front
of Strata so the API GW VPC link has an L4 endpoint to route to (it
cannot resolve Service Connect aliases).

The example-agent demo flow (federated login → /chat → AWS introspection)
is unchanged — it reaches Strata over Service Connect via Envoy
sidecars, NOT through the NLB. The NLB carries only external-MCP traffic.

ALB path (staging/prod) keeps the existing two-layer model (Next.js
middleware + Strata peer-trust); a Lambda authorizer in front of the ALB
is a future ticket. Phase 4 (`AWS-4.1`) is now fully unblocked — both
the deploy entry point AND the `tools/list` synthetic canary that
exercises the full external-client path through API GW + NLB + Strata.

Idle when fully up: ~$361/mo (was ~$345 pre-1.6.6; NLB adds ~$16/mo
when stack is up). Idle when down: ~$0/mo (bootstrap stays up). At 8
hr/wk operating cadence: ~$0.50/mo NLB on top of ~$2/mo total.

## Continuous integration

Two GitHub Actions workflows live at the strata repo root under `.github/workflows/`:

| Workflow | Trigger | What it does |
|---|---|---|
| `aws-template-ci.yml` | PR + push to main, paths `templates/aws/**` | `terraform fmt -check` (recursive), `terraform validate` (matrix per discovered `versions.tf` path), `tflint` against `templates/aws/.tflint.hcl`, `checkov` (gating IaC SAST), `tfsec` (advisory). On PRs, runs `terraform plan` against `envs/dev/` via the read-only `strata-cicd-readonly-role` and sticky-comments the plan output. |
| `aws-template-apply.yml` | `workflow_dispatch` only | Gated by the `dev` GitHub environment (required reviewers). Requires `confirm=apply-dev` input. Assumes `strata-cicd-deploy-role` via OIDC, runs `task dev:up` (or `task dev:down` with a toggle), uploads orchestrator outputs as a 30-day artifact, writes a job-summary completion notice. |

OIDC roles are provisioned by `bootstrap/`:

- `strata-cicd-deploy-role` — AdministratorAccess (scaffold phase; AWS-5.x will replace with least-privilege). Trusted by `repo:mkavalich/strata:ref:refs/heads/main` and `repo:mkavalich/strata:environment:dev`.
- `strata-cicd-readonly-role` — ReadOnlyAccess. Trusted by `repo:mkavalich/strata:pull_request` only. Used by the plan-on-PR job so even an exfiltrated PR-job credential cannot apply infra.

After this lands, run `task bootstrap:up` once against the dev account to create `strata-cicd-readonly-role`. The `create_readonly_role` variable defaults to `true`.

The dashboards + canaries portion of AWS-4.1 (`observability-sre`) shipped 2026-05-06; see "Observability + canary" below. The third canary (example-agent end-to-end OAuth flow, `qa-test-eng`) is still open.

## Observability + canary (AWS-4.1)

Two CloudWatch dashboards are provisioned by `modules/observability`:

| Dashboard | Name | Console URL pattern |
|---|---|---|
| SLO (slim) | `strata-<env>-slo` | `https://<region>.console.aws.amazon.com/cloudwatch/home?region=<region>#dashboards:name=strata-<env>-slo` |
| Ops (broad) | `strata-<env>-ops` | `https://<region>.console.aws.amazon.com/cloudwatch/home?region=<region>#dashboards:name=strata-<env>-ops` |

The orchestrator surfaces both URLs as `observability_dashboard_url` and `observability_ops_dashboard_url` outputs from `task dev:output`. The ops dashboard surfaces ECS per-service utilization, API GW request/error/latency mix, internal NLB flows + healthy-host counts, Aurora ACU/conns/replica-lag, Redis Serverless usage, NAT egress, VPC-endpoint usage, and the JWT authentication funnel.

**JWT auth-error rate alarm.** Two CW Logs metric filters attach to the API GW access log group (the format AWS-1.6.4 enriched with `sub` + `authError`) emitting `JwtAuthErrorCount` and `JwtAuthRequestCount` in the `Strata/Auth` namespace. The `jwt_auth_error_rate` alarm pages when `(errors / total) * 100` exceeds `jwt_auth_error_rate_threshold` (default 5%) for 2 of 3 5-minute periods. Runbook: `templates/aws/runbooks/jwt_auth_error_rate.md`.

**Synthetic canary.** `services/canary/` is an EventBridge-scheduled Lambda that runs every 5 minutes (configurable). It mints a Cognito JWT via AdminInitiateAuth against the test-user app client, then POSTs `/mcp tools/list` and asserts HTTP 200 + non-empty `result.tools`. Failures emit `CANARY_FAIL stage=<name>`; a metric filter on that prefix increments `Strata/Canary::CanaryFailureCount`, which the failure alarm pages on (default: 2 of 3 5-min periods with at least 1 failure each). Runbook: `templates/aws/runbooks/canary_mcp_tools_list.md`.

**Why EventBridge + Lambda over CloudWatch Synthetics.** Cost. Synthetics canaries bill ~$0.0017/run × 5-min cadence = ~$15/mo per canary 24/7. EventBridge + Lambda at the same cadence is well under $0.50/mo at the dev operating cadence (8 hr/wk) and ~$2/mo at 24/7. Tying canary cost to apply state matches the destroy-when-not-working operating model. Lambda logs land in CloudWatch directly; the metric filter on `CANARY_FAIL` is the canonical signal — no S3 screenshots/HAR overhead.

**One-time canary setup.** After `task dev:up`, seed the test-user credentials secret:

```bash
aws secretsmanager put-secret-value \
  --secret-id "$(task dev:output -- canary_credentials_secret_arn)" \
  --secret-string '{"username":"<canary-user>","password":"<password>"}'
```

The secret is provisioned even when `canary_enabled=false` so operators can stage credentials before flipping the canary on. The Cognito test-user app client must permit `ADMIN_USER_PASSWORD_AUTH`.

`canary_enabled = false` in tfvars or the orchestrator skips the Lambda + IAM role + EventBridge rule + alarm but keeps the credentials secret — useful during initial bring-up before the test user exists.

## Multi-environment expansion (deferred)

The original spec assumed three accounts (dev, staging, prod). For now we deploy to dev only — see "Phase 1 deployment scope" in the design spec. When staging and prod accounts are created later:

1. Create `envs/staging/backend.tf` and `envs/prod/backend.tf` (copy `envs/dev/backend.tf`, change account ID + bucket name).
2. Add `bootstrap/examples/{staging,prod}/main.tf` (copy `examples/dev/main.tf`, change account, env_name, allowed_environments).
3. Apply bootstrap into the new accounts via the new examples.
4. Add per-env `examples/basic/{env}/` for each module.
5. Add `task up:staging`, `task up:prod` etc. to `Taskfile.yml`.

The modules themselves are env-parameterized — no module code changes needed.

## Cost guardrails (AWS-5.1)

Three layers of cost protection run after Phase 5:

| Layer | Resource | Threshold | Managed by |
|---|---|---|---|
| Fixed monthly cap | AWS Budget strata-dev-cap | $30/mo; alerts at 50/80/100% forecast | Operator (console) |
| Anomaly detection | services/cost-anomaly CE monitor + subscription | $5 absolute above baseline | Terraform |
| Real-time NAT egress | modules/observability nat_bytes_out_anomaly alarms | 3-sigma CloudWatch anomaly band | Terraform |

### Cost-allocation tags

Every Phase 1 module applies these four tags via the local.default_tags / extra_tags
merge pattern. These are the canonical tags for all Strata-on-AWS resources:

| Tag key | Value (dev) | Purpose |
|---|---|---|
| Project | strata | Identifies all Strata-on-AWS resources |
| Environment | dev | Differentiates dev/staging/prod spend in Cost Explorer |
| ManagedBy | terraform | Signals IaC control; protects against manual drift |
| CostCenter | demo | Cost allocation unit; use a real cost-center code in billing systems |

Activate these as Cost Allocation Tags in the AWS Billing console (Billing > Cost
Allocation Tags > Activate) to make them filterable in Cost Explorer reports.

For future AWS Organizations adoption, see governance/required-tags-scp/ for a
Service Control Policy stub that enforces the required tags at the OU level.

### Runbooks

| Alarm / situation | Runbook |
|---|---|
| Cost anomaly email fired | templates/aws/runbooks/cost-investigation.md |
| NAT egress spike | templates/aws/runbooks/nat_bytes_out_anomaly.md (observability-sre) |
| JWT auth error rate | templates/aws/runbooks/jwt_auth_error_rate.md |
| Canary failure | templates/aws/runbooks/canary_mcp_tools_list.md |
