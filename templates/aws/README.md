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

## Module status

| Ticket | Module | Status |
|---|---|---|
| AWS-0.1 | bootstrap | ✅ shipped, applied to dev account |
| AWS-1.1 | modules/network | ✅ shipped, plan-only (apply via `task network:up`) |
| AWS-1.2 | modules/ecs-cluster | not yet built |
| AWS-1.3 | modules/ecs-service | not yet built |
| AWS-1.4 | modules/aurora-postgres | not yet built |
| AWS-1.5 | modules/elasticache-redis | not yet built |
| AWS-1.6 | modules/alb | not yet built |
| AWS-1.7 | modules/s3-bucket | not yet built |
| AWS-1.8 | modules/cognito-user-pool | not yet built |
| AWS-1.9 | modules/secrets-rotation | not yet built |
| AWS-1.10 | modules/kms | not yet built |
| AWS-1.11 | modules/ingress | not yet built |

As each module lands, uncomment the corresponding line in the `up:` and `down:` tasks of `Taskfile.yml`.

## Multi-environment expansion (deferred)

The original spec assumed three accounts (dev, staging, prod). For now we deploy to dev only — see "Phase 1 deployment scope" in the design spec. When staging and prod accounts are created later:

1. Create `envs/staging/backend.tf` and `envs/prod/backend.tf` (copy `envs/dev/backend.tf`, change account ID + bucket name).
2. Add `bootstrap/examples/{staging,prod}/main.tf` (copy `examples/dev/main.tf`, change account, env_name, allowed_environments).
3. Apply bootstrap into the new accounts via the new examples.
4. Add per-env `examples/basic/{env}/` for each module.
5. Add `task up:staging`, `task up:prod` etc. to `Taskfile.yml`.

The modules themselves are env-parameterized — no module code changes needed.
