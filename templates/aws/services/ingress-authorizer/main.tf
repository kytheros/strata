###############################################################################
# services/ingress-authorizer (AWS-1.6.1).
#
# Closes the two cycle-breaking deferrals from Phase 1.5:
#
#   1. Centralized Cognito JWT authorizer at the API GW layer.
#   2. X-Strata-Verified header injection on the Strata-bound integration.
#
# This composition is intentionally apigw-backend-only in v1. ALB-backed
# environments (staging/prod) still rely on Next.js-layer JWT verification +
# the existing peer-trust auth-proxy contract; lifting the JWT to an ALB
# Lambda authorizer is a future v2 ticket. See README §"ALB path".
###############################################################################

locals {
  default_tags = merge(
    {
      Project     = "strata"
      Component   = "ingress-authorizer"
      Environment = var.env_name
      ManagedBy   = "terraform"
    },
    var.extra_tags,
  )

  # Cognito JWT issuer URL. Format from AWS docs:
  # https://cognito-idp.{region}.amazonaws.com/{user_pool_id}
  jwt_issuer = "https://cognito-idp.${var.aws_region}.amazonaws.com/${var.cognito_user_pool_id}"

  # Whether to wire the catch-all $default route to the example-agent
  # integration. Skipped when the operator did not pass an integration id —
  # the routes still require a backend, so this is the gating signal.
  wire_example_agent_default = var.example_agent_integration_id != ""
}

###############################################################################
# 1. STRATA_AUTH_PROXY_TOKEN — shared sentinel.
#
# Strata's multi-tenant HTTP transport refuses to honor X-Strata-User unless
# X-Strata-Verified matches STRATA_AUTH_PROXY_TOKEN (constant-time compare).
# We mint the secret here, store it in Secrets Manager (per-secret CMK), and
# expose its ARN + KMS key ARN + consumer policy JSON to:
#
#   - The API GW integration in this module (uses the random_password value
#     directly to populate the `X-Strata-Verified` request_parameter — the
#     value lives in state, but state is encrypted at rest in S3 + IAM-scoped
#     to the deploy role).
#   - The Strata service composition (reads the secret at task launch via the
#     `secrets` block on the task definition — value never lands in plan).
#
# The shared-secret pattern is the contract documented in
# strata/CLAUDE.md §"Multi-tenant deployments MUST run behind a verified
# auth proxy".
###############################################################################

resource "random_password" "auth_proxy_token" {
  length  = 64
  special = false
}

module "auth_proxy_secret" {
  source = "../../modules/secrets"

  env_name    = var.env_name
  aws_region  = var.aws_region
  secret_name = "ingress/auth-proxy-token"
  description = "Shared sentinel injected by the API GW integration on X-Strata-Verified after Cognito JWT verification. Strata's multi-tenant HTTP transport rejects any request whose X-Strata-Verified does not match this. Sourced once here and consumed by both services/strata (read at task launch) and this composition's apigw integration request_parameters."

  create_initial_version = true
  initial_value          = random_password.auth_proxy_token.result

  extra_tags = local.default_tags
}

###############################################################################
# 2. Cognito JWT authorizer.
#
# Attached to /mcp routes. The /health route is intentionally unauthenticated
# (load-balancer health checks must reach it without credentials). The
# example-agent's $default route also skips the authorizer — Next.js
# middleware verifies the JWT inside the app, and the Hosted UI redirect
# flow needs anonymous access to /api/auth/* during the initial OAuth dance.
###############################################################################

resource "aws_apigatewayv2_authorizer" "cognito" {
  api_id           = var.apigw_api_id
  name             = "strata-${var.env_name}-cognito-jwt"
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]

  jwt_configuration {
    audience = [var.cognito_user_pool_client_id]
    issuer   = local.jwt_issuer
  }
}

###############################################################################
# 3. Strata-bound API GW integration with X-Strata-Verified injection.
#
# A dedicated integration (separate from the one services/strata/ creates via
# the ecs-service module) so we can:
#
#   - Set `request_parameters` to overwrite/append `X-Strata-Verified` with
#     the auth-proxy token AFTER the JWT authorizer has run. The header is
#     applied unconditionally on the integration, but only requests that
#     pass the route-level JWT authorizer ever reach the integration.
#   - Keep services/strata's own integration unchanged. That integration is
#     a leftover from the ecs-service module's stub support; it is no longer
#     referenced by any route (the routes in this composition target THIS
#     integration). It can be cleaned up in a follow-up after we confirm no
#     downstream consumer reads its ID.
#
# The header value is sourced from random_password.auth_proxy_token.result —
# the same value seeded into the Secrets Manager secret above. Strata reads
# the secret at task launch via the ECS `secrets` block; this integration
# reads the literal at apply time and embeds it on every request the API GW
# proxies through. Both reads converge on the SAME value because the same
# random_password resource feeds both paths.
#
# request_parameters semantics (from AWS docs):
#   key   "overwrite:header.X-Strata-Verified" or "append:..."
#   value the literal to set
# We use `overwrite` so a hostile external client cannot pre-set the header
# and have it forwarded.
###############################################################################

resource "aws_apigatewayv2_integration" "strata_with_header" {
  api_id           = var.apigw_api_id
  integration_type = "HTTP_PROXY"
  integration_uri  = var.strata_integration_uri

  integration_method     = "ANY"
  connection_type        = "VPC_LINK"
  connection_id          = var.apigw_vpc_link_id
  payload_format_version = "1.0"

  timeout_milliseconds = 30000

  # Inject the verified header. `overwrite:` ensures any client-supplied
  # X-Strata-Verified is replaced, not preserved. The value is the raw
  # auth-proxy token; Strata compares it constant-time against the secret
  # the ECS task resolves at launch.
  request_parameters = {
    "overwrite:header.X-Strata-Verified" = random_password.auth_proxy_token.result
  }
}

###############################################################################
# 4. Routes.
#
# Authenticated (JWT authorizer attached):
#   POST   /mcp        → Strata MCP transport (initialize / tool calls)
#   GET    /mcp        → Strata MCP transport (SSE / session resume)
#   DELETE /mcp        → Strata MCP transport (session close)
#
# Unauthenticated:
#   GET    /health     → Strata /health (LB / synthetic-canary path)
#   ANY    $default    → example-agent (Next.js middleware enforces auth)
#
# Why three explicit /mcp routes instead of `ANY /mcp`:
#   API GW HTTP API supports `ANY` but emitting the methods explicitly makes
#   the access surface auditable from `terraform state list` and ensures
#   the JWT authorizer is attached to each verb. If we ever want WebSocket-
#   upgrade support, we'd add it here as another method, not paper over it
#   with ANY.
###############################################################################

resource "aws_apigatewayv2_route" "strata_mcp_post" {
  api_id    = var.apigw_api_id
  route_key = "POST /mcp"
  target    = "integrations/${aws_apigatewayv2_integration.strata_with_header.id}"

  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

resource "aws_apigatewayv2_route" "strata_mcp_get" {
  api_id    = var.apigw_api_id
  route_key = "GET /mcp"
  target    = "integrations/${aws_apigatewayv2_integration.strata_with_header.id}"

  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

resource "aws_apigatewayv2_route" "strata_mcp_delete" {
  api_id    = var.apigw_api_id
  route_key = "DELETE /mcp"
  target    = "integrations/${aws_apigatewayv2_integration.strata_with_header.id}"

  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

# /health is intentionally unauthenticated. It still goes through the
# header-injecting integration so Strata's STRATA_REQUIRE_AUTH_PROXY check
# passes (Strata enforces the proxy token even on /health when the env var
# is set; this keeps the same surface across authenticated and health paths).
resource "aws_apigatewayv2_route" "strata_health" {
  api_id    = var.apigw_api_id
  route_key = "GET /health"
  target    = "integrations/${aws_apigatewayv2_integration.strata_with_header.id}"
}

# Catch-all → example-agent. Not gated on the JWT authorizer at the API GW
# layer because:
#   - The Hosted UI OAuth callback (/api/auth/callback) lands without a
#     bearer token; the Next.js server completes the code exchange.
#   - Static assets and the login page must be reachable anonymously.
# Next.js middleware in services/example-agent enforces auth on the routes
# that need it (every API route checks cognito:groups for `approved`).
resource "aws_apigatewayv2_route" "example_agent_default" {
  count = local.wire_example_agent_default ? 1 : 0

  api_id    = var.apigw_api_id
  route_key = "$default"
  target    = "integrations/${var.example_agent_integration_id}"
}
