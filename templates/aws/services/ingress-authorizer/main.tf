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
  # integration. Skipped when the operator did not pass an integration id.
  # Uses the static-toggle pattern (Phase 5 validation finding): the
  # boolean must be plan-time resolvable so `count` can plan. Falls back
  # to inspecting the integration_id string for callers that hard-code one.
  wire_example_agent_default = var.example_agent_default_route_enabled || var.example_agent_integration_id != ""
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

  # AWS-1.6.5 — rotation knob. The token is otherwise stable across applies
  # because random_password is keepers-driven for re-roll. Change
  # var.auth_proxy_token_rotation_marker (e.g. v1 -> v2) to mint a new
  # token. The Strata task definition picks the new value up from Secrets
  # Manager at task launch; the API GW integration picks it up from
  # Terraform state on the same apply. See runbooks/rotate-auth-proxy-token.md
  # for the safe procedure (scale to >=2 tasks before bumping).
  keepers = {
    rotation_marker = var.auth_proxy_token_rotation_marker
  }
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
# 3. Internal NLB in front of Strata (AWS-1.6.6).
#
# API GW VPC links cannot resolve Service Connect aliases; they accept only
# an NLB listener ARN or a Cloud Map service ARN as the integration URI.
# We chose NLB (Option A) because:
#   - The Service Connect plumbing was just blessed by security review;
#     swapping to private DNS namespace + Cloud Map service registrations
#     would re-touch wiring that's working today.
#   - The NLB cleanly separates external-MCP traffic (this path) from
#     internal example-agent -> Strata traffic (Service Connect via Envoy
#     sidecars). Future per-path observability and rate-limiting attach
#     here naturally.
#   - Cost in the operating-cadence model is small: NLB only runs when the
#     stack is up (~$16/mo at 24/7; ~$0.50/mo at 8 hr/wk).
#
# TLS terminates at the public edge (CloudFront/API GW); the NLB carries
# plaintext TCP between the API GW VPC link and Strata's task ENI on the
# private VPC interior. No NLB cert is needed.
#
# Source-IP preservation: NLBs preserve source addressing by default for
# ip-target target groups. We do NOT enable client-IP preservation
# (`preserve_client_ip = true`) because the source we care about is the
# API GW VPC link's ENI, not the original public client — Strata reads
# X-Forwarded-For for the public client when needed.
###############################################################################

resource "aws_security_group" "nlb" {
  # checkov:skip=CKV_AWS_23:Per-rule descriptions are inlined on each aws_vpc_security_group_*_rule below.
  name        = "strata-${var.env_name}-mcp-nlb-sg"
  description = "Strata ${var.env_name} internal NLB security group. Ingress from VPC CIDR on the Strata port; egress to the same CIDR for target traffic. ASCII-only per AWS SG description charset."
  vpc_id      = var.vpc_id

  tags = merge(local.default_tags, {
    Name = "strata-${var.env_name}-mcp-nlb-sg"
  })
}

# Ingress: API GW VPC Link ENIs reach the NLB on the Strata container port
# from inside the VPC. Scoped to the VPC CIDR — no internet exposure (the
# NLB is internal-scheme, see aws_lb below).
resource "aws_vpc_security_group_ingress_rule" "nlb_from_vpc" {
  security_group_id = aws_security_group.nlb.id
  description       = "TCP from the VPC CIDR (API GW VPC link ENIs forward MCP traffic in)"
  cidr_ipv4         = var.vpc_cidr
  ip_protocol       = "tcp"
  from_port         = var.strata_container_port
  to_port           = var.strata_container_port

  tags = local.default_tags
}

# Egress to the VPC CIDR on the Strata port — the NLB forwards to task
# ENIs whose security group accepts ingress from this NLB SG. The Strata
# task SG must list this SG's id in its ingress_security_group_ids
# (orchestrator wires that).
resource "aws_vpc_security_group_egress_rule" "nlb_to_strata" {
  security_group_id = aws_security_group.nlb.id
  description       = "TCP to Strata task ENIs on the container port"
  cidr_ipv4         = var.vpc_cidr
  ip_protocol       = "tcp"
  from_port         = var.strata_container_port
  to_port           = var.strata_container_port

  tags = local.default_tags
}

resource "aws_lb" "mcp" {
  # checkov:skip=CKV_AWS_91:Access logging is not enabled by default for this internal NLB. v1.6.6 ships without it; AWS-1.6.4's access-log work covers the API GW edge where the JWT subject claim lives. Enabling NLB access logs would require an S3 bucket policy with the AWS-managed NLB-log-delivery principal — defer to a follow-up if needed.
  # checkov:skip=CKV_AWS_150:Deletion protection is variable-driven (var.nlb_deletion_protection). Default false in dev to support the destroy/recreate cadence; staging/prod tfvars set true.
  name               = "strata-${var.env_name}-mcp-nlb"
  internal           = true
  load_balancer_type = "network"
  subnets            = var.private_subnet_ids
  security_groups    = [aws_security_group.nlb.id]

  enable_cross_zone_load_balancing = true
  enable_deletion_protection       = var.nlb_deletion_protection

  tags = merge(local.default_tags, {
    Name = "strata-${var.env_name}-mcp-nlb"
  })
}

resource "aws_lb_target_group" "mcp" {
  # checkov:skip=CKV_AWS_378:HTTP between NLB and Fargate task is appropriate — TLS is terminated at the public edge. End-to-end TLS to tasks would require a per-service ACM cert; deferred. The internal NLB has no internet exposure.
  name        = "strata-${var.env_name}-mcp-tg"
  port        = var.strata_container_port
  protocol    = "TCP"
  target_type = "ip"
  vpc_id      = var.vpc_id

  # Health check: HTTP /health on the same port. Strata's health endpoint
  # returns 200 when the process is up. The NLB only registers tasks that
  # pass this check — failures are observable in CloudWatch.
  health_check {
    enabled             = true
    protocol            = "HTTP"
    path                = "/health"
    port                = "traffic-port"
    matcher             = "200"
    interval            = 30
    timeout             = 10
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  # Avoid name collisions on health-check-induced replacement.
  lifecycle {
    create_before_destroy = true
  }

  tags = merge(local.default_tags, {
    Name = "strata-${var.env_name}-mcp-tg"
  })
}

resource "aws_lb_listener" "mcp" {
  load_balancer_arn = aws_lb.mcp.arn
  port              = var.strata_container_port
  protocol          = "TCP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.mcp.arn
  }

  tags = local.default_tags
}

###############################################################################
# 4. Strata-bound API GW integration with X-Strata-Verified injection.
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
#     integration).
#
# The header value is sourced from random_password.auth_proxy_token.result —
# the same value seeded into the Secrets Manager secret above. Strata reads
# the secret at task launch via the ECS `secrets` block; this integration
# reads the literal at apply time and embeds it on every request the API GW
# proxies through. Both reads converge on the SAME value because the same
# random_password resource feeds both paths.
#
# integration_uri: NLB listener ARN (AWS-1.6.6). Was a Service Connect URL
# pre-1.6.6, which the VPC link could not resolve.
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
  integration_uri  = aws_lb_listener.mcp.arn

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
# 3b. /health-only integration WITHOUT the X-Strata-Verified header (AWS-1.6.7).
#
# Mirror of `strata_with_header` but with no `request_parameters` block. The
# /health route uses this so the proxy token is NEVER forwarded to Strata's
# /health handler. Two reasons:
#
#   1. Strata's `handleMcpRequest` is the ONLY code path that enforces
#      STRATA_REQUIRE_AUTH_PROXY. /health does not check the header today; the
#      old comment claiming it did was wrong (fixed below). Forwarding the
#      token to /health is therefore pure exposure with no authentication
#      benefit — anyone who scrapes the /health response would not see the
#      token (it stays in the request), but any future logging change in
#      core that echoed request headers would leak it.
#
#   2. AWS-1.6.7 security review verdict C: the multi-tenant /health response
#      currently includes pool stats. The durable fix lives in core (strip
#      payload to `{status:"ok"}`) and is tracked as AWS-1.6.7-core. This
#      Terraform workaround narrows the blast radius until that ships by
#      ensuring the verified-proxy token is not part of the /health request
#      surface at all.
###############################################################################

resource "aws_apigatewayv2_integration" "strata_no_header" {
  api_id           = var.apigw_api_id
  integration_type = "HTTP_PROXY"
  integration_uri  = aws_lb_listener.mcp.arn

  integration_method     = "ANY"
  connection_type        = "VPC_LINK"
  connection_id          = var.apigw_vpc_link_id
  payload_format_version = "1.0"

  timeout_milliseconds = 30000

  # NO request_parameters block — the X-Strata-Verified header is intentionally
  # not injected on this integration. Used only by the /health route.
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

# /health is intentionally unauthenticated AND uses the no-header integration
# (AWS-1.6.7). Strata's STRATA_REQUIRE_AUTH_PROXY gate is enforced ONLY inside
# `handleMcpRequest` — /health is not gated by it today. Forwarding the proxy
# token to /health is therefore unnecessary and slightly raises exposure on a
# path that already returns multi-tenant pool stats (security-review verdict
# C). The durable core fix (strip /health payload to `{status:"ok"}`) is
# tracked as AWS-1.6.7-core; this Terraform workaround removes the token
# from the /health request surface immediately.
resource "aws_apigatewayv2_route" "strata_health" {
  api_id    = var.apigw_api_id
  route_key = "GET /health"
  target    = "integrations/${aws_apigatewayv2_integration.strata_no_header.id}"
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
