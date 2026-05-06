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

# One-time setup before first dev:up: copy + edit tfvars, push container
# images. See envs/dev/README.md §"Operational setup before first apply".
cp envs/dev/terraform.tfvars.example envs/dev/terraform.tfvars
$EDITOR envs/dev/terraform.tfvars

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

### Two-pass apply on first deploy

`example_agent_app_url` is a chicken-and-egg input — Cognito needs it at
create time, but it's the API Gateway endpoint that this apply produces.
Plan accordingly:

1. First `task dev:up` with the placeholder URL in tfvars.
2. `task dev:output` and copy `ingress_endpoint_dns`.
3. Update `terraform.tfvars` → `example_agent_app_url = "https://<that>"`.
4. Second `task dev:up` to wire Cognito callback / logout URLs.

See `envs/dev/README.md` for the full operational setup checklist
(7 steps including OAuth credentials, image push, post-apply secret
seeding).

## Prerequisites

- AWS CLI v2 with profile `default` configured for account `624990353897`
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
| AWS-1.6.1 | **services/ingress-authorizer** | ✅ shipped 2026-05-06 — closes Phase 1.5 deferrals; JWT auth end-to-end on apigw path |
| AWS-1.7 | modules/cloudfront-dist | ✅ shipped, NOT in orchestrator (needs real ACM cert) |
| AWS-1.8 | modules/cognito-user-pool | ✅ shipped, owned by services/example-agent composition |
| AWS-1.9 | modules/secrets | ✅ shipped, composed by orchestrator + service compositions |
| AWS-1.10 | modules/observability | ✅ shipped, composed by orchestrator (~$2/mo idle) |
| AWS-1.11 | modules/ingress | ✅ shipped, composed by orchestrator (apigw, ~$0/mo idle) |
| AWS-2.1 | services/strata | ✅ shipped, composed by orchestrator (~$8/mo); accepts external auth-proxy secret since 1.6.1 |
| AWS-3.1+ | services/example-agent | ✅ shipped, composed by orchestrator (~$6/mo) |

Per-module `examples/basic/` are now **standalone validation harnesses only** — they wire to sentinel locals and are useful for unit-testing module changes in isolation. The canonical apply path is `task dev:up`, which goes through `envs/dev/`.

### What's wired end-to-end after Phase 1.6 (apigw path)

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
  Integration injects X-Strata-Verified
        |
        v
  Strata Fargate (STRATA_REQUIRE_AUTH_PROXY=1)
```

External MCP clients can now point Claude Code (or any MCP client) at
`https://<ingress>/mcp` with a Cognito-issued bearer token and successfully
call `tools/list` / `tools/call`. The auth-proxy header is injected by the
API GW integration after the JWT authorizer passes; Strata's existing
peer-trust contract verifies it constant-time. Defense in depth = JWT
validation at the edge + shared-secret check at the service.

ALB path (staging/prod) keeps the existing two-layer model (Next.js
middleware + Strata peer-trust); a Lambda authorizer in front of the ALB
is a future ticket. Phase 4 (`AWS-4.1`) can now target a single deploy
entry point and add a `tools/list` synthetic canary that exercises the
full external-client path.

Idle when fully up: ~$345/mo. Idle when down: ~$0/mo (bootstrap stays up).

## Multi-environment expansion (deferred)

The original spec assumed three accounts (dev, staging, prod). For now we deploy to dev only — see "Phase 1 deployment scope" in the design spec. When staging and prod accounts are created later:

1. Create `envs/staging/backend.tf` and `envs/prod/backend.tf` (copy `envs/dev/backend.tf`, change account ID + bucket name).
2. Add `bootstrap/examples/{staging,prod}/main.tf` (copy `examples/dev/main.tf`, change account, env_name, allowed_environments).
3. Apply bootstrap into the new accounts via the new examples.
4. Add per-env `examples/basic/{env}/` for each module.
5. Add `task up:staging`, `task up:prod` etc. to `Taskfile.yml`.

The modules themselves are env-parameterized — no module code changes needed.
