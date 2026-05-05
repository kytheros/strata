# Strata-on-AWS deploy template

This directory holds the Terraform that deploys Strata + the AWS-introspection example agent into an AWS account. See `specs/2026-04-25-strata-deploy-aws-design.md` (rev. 2 of 2026-05-04) for the architecture.

## Layout

```
templates/aws/
├── bootstrap/              # AWS-0.1 — state bucket + OIDC. Apply once per account; never destroy.
├── modules/                # Reusable Phase 1 modules (network, ecs-*, aurora-postgres, etc.)
│   └── network/            # AWS-1.1 — VPC + 3-AZ subnets + NAT + 11 endpoints + flow logs
├── envs/                   # Per-environment backend wiring
│   └── dev/                # Dev account = 624990353897
├── services/               # Phase 2/3 — strata-aws-service, example-agent (not yet built)
├── Taskfile.yml            # `task up` / `task down` controller (see "Operating cadence" below)
└── README.md               # This file
```

## Operating cadence — apply only when working

The dev architecture matches the prod spec (3-AZ, 2× NAT, 11 VPC endpoints, ALB, etc.) for portfolio fidelity. **It costs ~$345/mo idle when fully deployed**, dominated by NAT Gateways (~$66) and interface VPC endpoints (~$197 across 3 AZs).

To keep monthly spend under ~$50, **destroy the stack when you aren't actively working on it**. Bootstrap stays up at ~$0/mo; the rest of Phase 1 cycles in ~6–25 minutes (depending on how many modules are deployed).

| State | Cost / mo | When |
|---|---|---|
| bootstrap-only | ~$0 | between work sessions, default |
| bootstrap + Phase 1 fully applied | ~$345 | active demo / interview / development session |
| Cost if you spin up 4 hr/wk | **~$2** | (stack up 4hr × 4wk = 16hr/mo at $0.47/hr) |
| Cost if you spin up 8 hr/wk | **~$4** | (32hr/mo at $0.47/hr) |
| Cost if you leave it up 24/7 | $345 | not the plan |

## Quick start

```bash
# One-time install (Windows): winget install Task.Task
# One-time install (any OS):   https://taskfile.dev/installation/

# One-time per account: apply bootstrap (state bucket + OIDC). Stays up forever.
task bootstrap:up

# Start a work session — apply the full dev stack
task up

# Confirm what's deployed and what it costs
task status
task cost

# End the work session — destroy everything except bootstrap
task down
```

## Prerequisites

- AWS CLI v2 with profile `default` configured for account `624990353897`
- Terraform `~> 1.7`
- `tflint`, `checkov` (optional but the modules document `# checkov:skip` annotations that expect checkov)
- `task` (https://taskfile.dev) — wraps the destroy/recreate cadence

## Module status (Phase 1 complete — 2026-05-05)

| Ticket | Module | Status |
|---|---|---|
| AWS-0.1 | bootstrap | ✅ shipped, applied to dev account |
| AWS-1.1 | modules/network | ✅ shipped + applied (~$265/mo idle while up) |
| AWS-1.2 | modules/ecs-cluster | ✅ shipped, plan-only (~$1/mo idle CMK) |
| AWS-1.3 | modules/ecs-service | ✅ shipped, plan-only (~$5/mo per Spot task) |
| AWS-1.4 | modules/aurora-postgres | ✅ shipped, plan-only (~$17–28/mo idle — RDS Proxy is the floor) |
| AWS-1.5 | modules/elasticache-redis | ✅ shipped, plan-only (~$11–12/mo idle Serverless floor) |
| AWS-1.6 | modules/s3-bucket | ✅ shipped, plan-only (~$1/mo per bucket CMK) |
| AWS-1.7 | modules/cloudfront-dist | ✅ shipped, plan-only (~$8/mo WAF; requires real ACM cert to apply) |
| AWS-1.8 | modules/cognito-user-pool | ✅ shipped, plan-only (~$0/mo — 50K MAU free tier) |
| AWS-1.9 | modules/secrets | ✅ shipped, plan-only (~$1.40/mo per secret CMK + secret) |
| AWS-1.10 | modules/observability | ✅ shipped, plan-only (~$2/mo idle alarms + SNS + dashboard) |
| AWS-1.11 | modules/ingress | ✅ shipped, plan-only (~$0/mo apigw / ~$16/mo alb) |

**Phase 1 complete.** Bring the full stack up via `task up` (~35 min, excludes cloudfront-dist which requires a real ACM cert). Tear down via `task down` (~25 min). Idle when fully up: ~$345/mo. Idle when down: ~$0/mo (bootstrap stays up).

## Multi-environment expansion (deferred)

The original spec assumed three accounts (dev, staging, prod). For now we deploy to dev only — see "Phase 1 deployment scope" in the design spec. When staging and prod accounts are created later:

1. Create `envs/staging/backend.tf` and `envs/prod/backend.tf` (copy `envs/dev/backend.tf`, change account ID + bucket name).
2. Add `bootstrap/examples/{staging,prod}/main.tf` (copy `examples/dev/main.tf`, change account, env_name, allowed_environments).
3. Apply bootstrap into the new accounts via the new examples.
4. Add per-env `examples/basic/{env}/` for each module.
5. Add `task up:staging`, `task up:prod` etc. to `Taskfile.yml`.

The modules themselves are env-parameterized — no module code changes needed.
