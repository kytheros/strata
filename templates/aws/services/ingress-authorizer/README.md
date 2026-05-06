# services/ingress-authorizer (AWS-1.6.1)

Closes the two cycle-breaking deferrals that Phase 1.5 left open:

1. **Centralized Cognito JWT authorizer** attached to the ingress's API GW
   `/mcp` routes. External MCP clients can now hit
   `https://<ingress-domain>/mcp` directly with a Cognito-issued JWT; the
   API GW validates the token before the request ever reaches Strata.

2. **`X-Strata-Verified` header injection** on the Strata-bound integration.
   The shared secret is minted by this composition, stored in Secrets
   Manager (per-secret CMK), and referenced by both:
   - the API GW integration's `request_parameters` (`overwrite:` mode), and
   - the Strata service's task definition (read at task launch via the
     ECS `secrets` block).

The `random_password` resource is the single source of truth — both the
header injection and the Strata-side comparison resolve to the same value.

## Tool: Terraform (HCL)

Default tool per workspace convention: this is platform IaC composing
multiple shared modules across two services, with a long-lived state file
shared with the rest of the dev orchestrator.

## Why a separate composition (cycle break)

Phase 1.5 deliberately deferred this work because:

```
ingress.cognito_user_pool_id  ←──┐
                                  │   would create a cycle:
example_agent.user_pool_id  ─────┘   ingress → example_agent → ingress
                            │
example_agent.vpc_link_id  ←─┘
```

Resolving the cycle by lifting the JWT authorizer + header injection into a
**downstream** composition that runs after `cognito_user_pool` + `ingress` +
both services breaks the dependency chain: this module consumes raw
IDs/ARNs/strings, and nothing upstream references its outputs at create
time. The Strata service composition is the only consumer of this module's
outputs (auth-proxy secret ARN + consumer policy), and it now accepts
those values as optional inputs — preserving its standalone validation
posture for unit tests.

## How a request flows

```
                     ┌───────────────────────┐
External MCP client  │ POST /mcp             │
       (Bearer JWT)  │ Authorization: ...    │
                     └──────────┬────────────┘
                                │
                         ┌──────▼──────┐
                         │  API GW     │
                         │  HTTP API   │
                         └──────┬──────┘
                                │   route POST /mcp
                                │   authorizer = cognito-jwt
                                ▼
                  ┌─────────────────────────────┐
                  │ JWT authorizer              │
                  │   audience = client_id      │
                  │   issuer   = cognito-idp/.. │
                  └──────┬──────────────────────┘
                         │   on success
                         ▼
                  ┌──────────────────────────┐
                  │ Integration               │
                  │   HTTP_PROXY → VPC link   │
                  │   request_parameters:     │
                  │     overwrite header.     │
                  │     X-Strata-Verified =   │
                  │     <auth-proxy-token>    │
                  └──────┬───────────────────┘
                         │
                         ▼
              ┌──────────────────────────────┐
              │ Strata Fargate (Service Conn)│
              │   STRATA_REQUIRE_AUTH_PROXY  │
              │   compares header to env var │
              │   (constant-time)            │
              └──────────────────────────────┘
```

The Strata service trusts the header because the only path to the integration
is the JWT-authorized route. A client that bypasses the API GW (e.g.
attempts to reach the Service Connect endpoint directly from inside the VPC)
cannot supply the secret — it's never sent over the wire to anyone.

## ALB path

This composition is **API GW only** in v1.6. ALB-backed environments
(staging/prod, set via `ingress.backend = "alb"`) still rely on the existing
two-layer model:

- Next.js middleware in `services/example-agent/` verifies the Cognito JWT.
- Strata's `STRATA_REQUIRE_AUTH_PROXY` enforces the peer-trust contract,
  with the example-agent (the only ingress in that path) holding the secret
  and setting the header on its server-side fetches.

A future ticket will add a Lambda authorizer in front of the ALB to lift
the JWT verification to the edge for direct external MCP access. v1.6
deliberately scopes the change to apigw to keep the diff small; the ALB
path's defense-in-depth is unchanged.

If the operator instantiates this composition with an ALB-backed ingress
(`apigw_api_id == ""`), Terraform validation will fail at the variable
level — the `apigw_api_id` validation block requires a non-empty value.

## Inputs

| Variable | Required | Notes |
|---|---|---|
| `env_name` | yes | dev / staging / prod |
| `aws_region` | no | default `us-east-1` |
| `cognito_user_pool_id` | yes | from `cognito-user-pool` (or `services/example-agent`) |
| `cognito_user_pool_client_id` | yes | from `cognito-user-pool` (or `services/example-agent`) |
| `apigw_api_id` | yes | from `ingress.api_id` |
| `apigw_vpc_link_id` | yes | from `ingress.vpc_link_id` |
| `strata_integration_uri` | yes | e.g. `http://strata.strata-dev.local:3000` |
| `example_agent_integration_id` | no | from `ecs-service.apigw_integration_id` of the example-agent. Empty disables the catch-all `$default` route. |
| `extra_tags` | no | merged into default tag set |

## Outputs

| Output | Notes |
|---|---|
| `auth_proxy_secret_arn` | Pass to `services/strata` as `auth_proxy_secret_arn` (input) |
| `auth_proxy_secret_kms_key_arn` | Pass to `services/strata` as `auth_proxy_secret_kms_key_arn` (input) |
| `auth_proxy_consumer_iam_policy_json` | Pass to `services/strata` as `auth_proxy_consumer_iam_policy_json` (input) |
| `authorizer_id` | Diagnostic |
| `authorizer_name` | Diagnostic |
| `strata_integration_id` | Diagnostic |
| `jwt_issuer_url` | Documented in operator runbooks |
| `mcp_route_keys` | List of route keys for cross-check |

## Apply order

In the `envs/dev/main.tf` orchestrator, this composition is instantiated
**after** `cognito` (transitively via `module.example_agent`), `ingress`,
and both services. Its outputs flow into `module.strata_service` via the
optional auth-proxy inputs documented in `services/strata/README.md`.
