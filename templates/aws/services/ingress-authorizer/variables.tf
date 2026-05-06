###############################################################################
# services/ingress-authorizer (AWS-1.6.1) — input surface.
#
# This composition closes the two cycle-breaking deferrals from Phase 1.5:
#
#   1. Centralized Cognito JWT authorizer attached to the ingress's API GW
#      routes. v1 verified JWTs at each service's app layer (Next.js
#      middleware + STRATA_REQUIRE_AUTH_PROXY peer-trust). v1.6 lifts that
#      to the API GW layer so external MCP clients can hit /mcp directly.
#
#   2. X-Strata-Verified header injection from the ingress integration into
#      Strata-bound requests, after JWT verification. The integration uses
#      `request_parameters` to set the constant header value to the shared
#      STRATA_AUTH_PROXY_TOKEN this composition mints.
#
# Why a separate composition:
#   - The ingress module owns the API + VPC Link + (optional) authorizer
#     resource. Wiring routes there created an ingress↔example_agent cycle.
#   - The strata service module owns its own ECS integration. Adding header
#     injection there couples the service module to the ingress's secret.
#   - Lifting both concerns into a downstream composition that runs AFTER
#     cognito + ingress + both services breaks the cycle: this module
#     depends on raw IDs/ARNs/URIs from those upstreams, but nothing in
#     them depends on this module's outputs at create time.
###############################################################################

variable "env_name" {
  description = "Environment short name (dev|staging|prod). Drives resource naming and secret hierarchy."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.env_name)
    error_message = "env_name must be one of: dev, staging, prod."
  }
}

variable "aws_region" {
  description = "AWS region. Used to construct the Cognito JWT issuer URL (https://cognito-idp.{region}.amazonaws.com/{user_pool_id})."
  type        = string
  default     = "us-east-1"
}

###############################################################################
# Cognito — consumed from the cognito-user-pool module (or from the
# example-agent composition that owns it). Raw IDs/strings only — NO module
# references — so this composition has no graph edge into those modules
# beyond the explicit input wiring at the orchestrator layer.
###############################################################################

variable "cognito_user_pool_id" {
  description = "Cognito User Pool ID. Used to construct the JWT issuer URL on the API GW JWT authorizer."
  type        = string

  validation {
    condition     = length(var.cognito_user_pool_id) > 0
    error_message = "cognito_user_pool_id must be set — the JWT authorizer cannot be created without a user pool."
  }
}

variable "cognito_user_pool_client_id" {
  description = "Cognito App Client ID. Used as the `audience` claim the JWT authorizer enforces."
  type        = string

  validation {
    condition     = length(var.cognito_user_pool_client_id) > 0
    error_message = "cognito_user_pool_client_id must be set — required as JWT audience."
  }
}

###############################################################################
# Ingress — consumed from the ingress module
###############################################################################

variable "apigw_api_id" {
  description = "HTTP API ID from the ingress module's `api_id` output. Routes and authorizer attach here."
  type        = string

  validation {
    condition     = length(var.apigw_api_id) > 0
    error_message = "apigw_api_id must be set — this composition is apigw-backend-only in v1 (see README)."
  }
}

variable "apigw_vpc_link_id" {
  description = "VPC Link ID from the ingress module's `vpc_link_id` output. Used by the Strata-bound integration this composition creates (the existing ecs-service integration is left in place but not wired into the JWT-authorized routes)."
  type        = string

  validation {
    condition     = length(var.apigw_vpc_link_id) > 0
    error_message = "apigw_vpc_link_id must be set — JWT-authorized /mcp routes need a VPC link to reach Strata over Service Connect."
  }
}

###############################################################################
# Internal NLB (AWS-1.6.6) — closes the runtime gap surfaced in AWS-1.6.1.
#
# API GW VPC links cannot resolve Service Connect aliases (they only work
# inside Envoy-sidecar-instrumented tasks). For external MCP clients to
# reach Strata via the API GW, this composition stands up a private
# internal NLB in front of Strata and targets the NLB listener ARN from
# the JWT-authorized integration. Service Connect stays for internal
# traffic — example-agent -> Strata is unchanged.
#
# The Strata integration_uri (var.strata_integration_uri below) is now
# DEPRECATED for routing and kept only so existing examples don't break;
# the routes target the NLB listener ARN this composition creates.
###############################################################################

variable "vpc_id" {
  description = "VPC ID for the internal NLB and its security group. Same VPC the ingress lives in."
  type        = string
}

variable "vpc_cidr" {
  description = "VPC CIDR block. Used to scope the NLB security group's egress allow-list to the VPC interior so the NLB can reach Strata's task ENIs."
  type        = string

  validation {
    condition     = can(cidrnetmask(var.vpc_cidr))
    error_message = "vpc_cidr must be a valid IPv4 CIDR block (e.g. 10.40.0.0/16)."
  }
}

variable "private_subnet_ids" {
  description = "Private subnet IDs the NLB attaches to (one per AZ). Same subnets the API GW VPC Link uses; the link reaches the NLB via these subnets."
  type        = list(string)

  validation {
    condition     = length(var.private_subnet_ids) >= 2
    error_message = "private_subnet_ids must contain at least 2 subnets for AZ redundancy."
  }
}

variable "strata_container_port" {
  description = "Port Strata listens on inside its container. Default 3000. The NLB target group registers tasks at this port; the NLB listener exposes it on the same port so the integration URI reads cleanly."
  type        = number
  default     = 3000
}

variable "nlb_deletion_protection" {
  description = "NLB deletion protection. Default false — dev cycles tear down freely. Staging/prod tfvars should set true."
  type        = bool
  default     = false
}

variable "strata_integration_uri" {
  description = "DEPRECATED in v1.6.6 (kept as input for backwards-compat with examples). Service Connect URL for the Strata service (e.g. http://strata.strata-dev:3000). The actual integration_uri used by the API GW route is now the NLB listener ARN this composition creates. The variable is retained so example invocations don't break, but the value is unused for routing."
  type        = string
  default     = ""

  validation {
    condition     = var.strata_integration_uri == "" || can(regex("^https?://[^/]+:[0-9]+$", var.strata_integration_uri))
    error_message = "strata_integration_uri, when set, must be `http(s)://<host>:<port>` with no trailing path."
  }
}

variable "example_agent_integration_id" {
  description = "API GW integration ID for the example-agent service (from services/example-agent/infrastructure's underlying ecs-service module). Used as the target for the catch-all $default route — example-agent's Next.js middleware verifies the JWT itself, so $default does NOT attach the JWT authorizer."
  type        = string
  default     = ""
}

###############################################################################
# Auth-proxy token rotation (AWS-1.6.5).
#
# The shared sentinel injected on X-Strata-Verified is minted by the
# random_password.auth_proxy_token resource and is otherwise stable across
# applies. Bumping this marker changes the resource's `keepers` map, which
# forces Terraform to re-roll the value on the next apply. Both consumers
# (this composition's apigw integration request_parameters AND the Strata
# task definition via Secrets Manager) re-read the new value from state /
# from Secrets Manager respectively, but the propagation is NOT atomic.
#
# Rotation runbook: runbooks/rotate-auth-proxy-token.md.
###############################################################################

variable "auth_proxy_token_rotation_marker" {
  description = "Opaque marker that gates auth-proxy token rotation. Bumping the value (e.g. v1 -> v2) forces random_password.auth_proxy_token to re-roll on the next apply. The Strata task definition picks the new value up via Secrets Manager at task launch; the API GW integration picks it up from Terraform state on apply. There is a brief window where one side has the new value and the other has the old — see runbooks/rotate-auth-proxy-token.md for the safe procedure (scale to >=2 tasks before bumping). ASCII only."
  type        = string
  default     = "v1"

  validation {
    condition     = length(var.auth_proxy_token_rotation_marker) > 0
    error_message = "auth_proxy_token_rotation_marker must be a non-empty string. Use a short opaque label like v1, v2, 2026Q2."
  }
}

###############################################################################
# Tags
###############################################################################

variable "extra_tags" {
  description = "Additional tags merged into the default tag set."
  type        = map(string)
  default     = {}
}
