###############################################################################
# strata ingress — ALB or API GW HTTP API (one-flag swap).
#
# What this module does:
#
#   When var.backend = "apigw":
#     1. HTTP API Gateway (HTTP protocol) with permissive-by-default CORS.
#     2. VPC Link anchored in private subnets so the consumer's routes can
#        proxy to ECS-internal services.
#     3. Optional Cognito JWT authorizer (created when var.cognito_user_pool_id
#        is set). Routes are attached by the consumer module.
#     4. $default stage with auto-deploy and (optional) execution logging to
#        CloudWatch.
#
#   When var.backend = "alb":
#     1. Internet-facing (or internal) Application Load Balancer.
#     2. Security group: 443 from the world or the CloudFront prefix list,
#        plus port-80 redirect listener. Egress to VPC CIDR only.
#     3. HTTPS listener with default 404 fixed-response — services attach
#        their own listener rules pointing at their own target groups.
#     4. HTTP→HTTPS 301 redirect listener.
#     5. Optional Cognito-protected listener rules for var.cognito_protected_paths.
#
# Outputs are deliberately uniform across both backends — values that don't
# apply to the active backend are emitted as `null`. Consumer modules can
# treat the output object as a single shape and switch via try() / coalesce().
###############################################################################

locals {
  default_tags = {
    Project     = "strata"
    Component   = "ingress"
    ManagedBy   = "terraform"
    Environment = var.env_name
    Backend     = var.backend
  }

  tags = merge(local.default_tags, var.extra_tags)

  is_alb   = var.backend == "alb"
  is_apigw = var.backend == "apigw"

  # Cognito enabled when the consumer supplied a user-pool id. For ALB we
  # additionally require the ARN + domain + client_id (those are needed by
  # the authenticate_cognito action), but the gating signal is the same.
  cognito_enabled_apigw = local.is_apigw && var.cognito_user_pool_id != "" && var.cognito_user_pool_client_id != ""
  cognito_enabled_alb   = local.is_alb && var.cognito_user_pool_arn != "" && var.cognito_user_pool_client_id != "" && var.cognito_user_pool_domain != ""

  # CORS coalescing — surface the optional() defaults as concrete values for
  # the apigw resource block.
  cors = {
    allow_origins     = coalesce(var.cors_config.allow_origins, ["*"])
    allow_methods     = coalesce(var.cors_config.allow_methods, ["*"])
    allow_headers     = coalesce(var.cors_config.allow_headers, ["*"])
    expose_headers    = coalesce(var.cors_config.expose_headers, [])
    max_age           = coalesce(var.cors_config.max_age, 0)
    allow_credentials = coalesce(var.cors_config.allow_credentials, false)
  }

  # When the consumer didn't supply VPC-link SGs, we fall back to one we own.
  vpc_link_use_module_sg = local.is_apigw && length(var.vpc_link_security_group_ids) == 0
  vpc_link_sg_ids = (
    local.vpc_link_use_module_sg
    ? [aws_security_group.vpc_link[0].id]
    : var.vpc_link_security_group_ids
  )
}

###############################################################################
# Pre-flight validation — caught at plan time so apply doesn't half-create.
#
# We can't express "required when X" purely in `validation` blocks, so we use
# a check{} block (TF 1.5+) to surface the failure mode clearly.
###############################################################################

check "backend_inputs_complete" {
  assert {
    condition     = !(local.is_alb && (length(var.public_subnet_ids) < 2 || var.acm_certificate_arn == ""))
    error_message = "When backend=\"alb\", public_subnet_ids must contain at least 2 subnets and acm_certificate_arn must be set."
  }

  assert {
    condition     = !(local.is_apigw && length(var.private_subnet_ids) < 2)
    error_message = "When backend=\"apigw\", private_subnet_ids must contain at least 2 subnets for the VPC Link."
  }
}

###############################################################################
# CloudFront prefix list lookup (alb + restrict_to_cloudfront_prefix_list)
#
# The prefix list ID is region-specific and changeable; we resolve it via the
# AWS-managed name rather than hardcoding the ID.
###############################################################################

data "aws_ec2_managed_prefix_list" "cloudfront" {
  count = local.is_alb && var.restrict_to_cloudfront_prefix_list ? 1 : 0
  name  = "com.amazonaws.global.cloudfront.origin-facing"
}

###############################################################################
# ============================================================================
# ALB BRANCH
# ============================================================================
###############################################################################

###############################################################################
# 1. ALB security group
#
# Inbound 443:
#   - default: 0.0.0.0/0
#   - when restrict_to_cloudfront_prefix_list = true: scoped to the AWS-managed
#     CloudFront origin-facing prefix list.
#
# Inbound 80: 0.0.0.0/0 (the only traffic we accept on :80 is the redirect-to-
# HTTPS — bare HTTP requests are responded to with a 301 and dropped).
#
# Egress: VPC CIDR on 1024-65535 (target traffic to ECS Fargate ENIs).
###############################################################################

resource "aws_security_group" "alb" {
  count = local.is_alb ? 1 : 0

  # checkov:skip=CKV_AWS_23:Per-rule descriptions are inlined on each aws_vpc_security_group_*_rule below.
  name        = "strata-${var.env_name}-alb-sg"
  description = "Strata ${var.env_name} ALB security group — 443/80 ingress, VPC-CIDR egress."
  vpc_id      = var.vpc_id

  tags = merge(local.tags, {
    Name = "strata-${var.env_name}-alb-sg"
  })
}

# --- Inbound 443 — open to internet ---
resource "aws_vpc_security_group_ingress_rule" "alb_https_open" {
  count = local.is_alb && !var.restrict_to_cloudfront_prefix_list ? 1 : 0

  security_group_id = aws_security_group.alb[0].id
  description       = "HTTPS from the public internet (default; CloudFront prefix-list scoping is opt-in via var.restrict_to_cloudfront_prefix_list)."
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443

  tags = local.tags
}

# --- Inbound 443 — scoped to CloudFront prefix list ---
resource "aws_vpc_security_group_ingress_rule" "alb_https_cloudfront" {
  count = local.is_alb && var.restrict_to_cloudfront_prefix_list ? 1 : 0

  security_group_id = aws_security_group.alb[0].id
  description       = "HTTPS only from CloudFront edge POPs (com.amazonaws.global.cloudfront.origin-facing). Forces traffic through the WAF and edge cache layer."
  prefix_list_id    = data.aws_ec2_managed_prefix_list.cloudfront[0].id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443

  tags = local.tags
}

# --- Inbound 80 — only used by the HTTP→HTTPS redirect listener ---
resource "aws_vpc_security_group_ingress_rule" "alb_http_redirect" {
  count = local.is_alb ? 1 : 0

  # checkov:skip=CKV_AWS_260:0.0.0.0/0 on :80 is required so the redirect listener can intercept bare HTTP and 301 it to HTTPS. The rule does not allow application traffic on :80.
  security_group_id = aws_security_group.alb[0].id
  description       = "HTTP from the public internet — solely for the HTTP→HTTPS 301 redirect listener. No application traffic served on :80."
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80

  tags = local.tags
}

# --- Egress to VPC CIDR (target traffic to ECS) ---
resource "aws_vpc_security_group_egress_rule" "alb_to_vpc" {
  count = local.is_alb ? 1 : 0

  security_group_id = aws_security_group.alb[0].id
  description       = "Egress to ECS task ENIs inside the VPC on dynamic high ports."
  cidr_ipv4         = var.vpc_cidr
  ip_protocol       = "tcp"
  from_port         = 1024
  to_port           = 65535

  tags = local.tags
}

###############################################################################
# 2. ALB
###############################################################################

resource "aws_lb" "this" {
  count = local.is_alb ? 1 : 0

  # checkov:skip=CKV_AWS_150:Deletion protection is variable-driven (var.deletion_protection). Default false in dev; staging/prod tfvars set true.
  # checkov:skip=CKV2_AWS_28:WAF is attached at the CloudFront edge per design §"Edge / Front-door"; ALB-attached WAF is redundant when restrict_to_cloudfront_prefix_list=true. For non-CloudFront fronted ALBs, attach WAFv2 at the consumer layer.
  # checkov:skip=CKV2_AWS_20:HTTP-to-HTTPS redirect is implemented by aws_lb_listener.http below.
  name               = "strata-${var.env_name}-alb"
  internal           = var.internal
  load_balancer_type = "application"
  subnets            = var.public_subnet_ids
  security_groups    = [aws_security_group.alb[0].id]

  drop_invalid_header_fields = true
  enable_http2               = true
  idle_timeout               = var.alb_idle_timeout_seconds
  enable_deletion_protection = var.deletion_protection

  dynamic "access_logs" {
    for_each = var.access_logs_bucket != "" ? [1] : []
    content {
      bucket  = var.access_logs_bucket
      prefix  = var.access_logs_prefix
      enabled = true
    }
  }

  tags = merge(local.tags, {
    Name = "strata-${var.env_name}-alb"
  })
}

###############################################################################
# 3. ALB listeners
#
# :80  → 301 to https://#{host}:443/#{path}?#{query}
# :443 → default fixed-response 404 ("Strata"). Services attach their own
#        aws_lb_listener_rule resources pointing at their own target groups,
#        OR the consumer enables Cognito-protected paths via
#        var.cognito_protected_paths (rules created below).
###############################################################################

resource "aws_lb_listener" "http" {
  count = local.is_alb ? 1 : 0

  load_balancer_arn = aws_lb.this[0].arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }

  tags = local.tags
}

resource "aws_lb_listener" "https" {
  count = local.is_alb ? 1 : 0

  load_balancer_arn = aws_lb.this[0].arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = var.ssl_policy
  certificate_arn   = var.acm_certificate_arn

  default_action {
    type = "fixed-response"

    fixed_response {
      content_type = "text/plain"
      message_body = "Strata"
      status_code  = "404"
    }
  }

  tags = local.tags
}

###############################################################################
# 4. Optional Cognito-protected listener rules
#
# For each path in var.cognito_protected_paths:
#   - authenticate_cognito (uses module-supplied user-pool/client/domain)
#   - then a second action — a fixed-response 401, since the module doesn't
#     own a target group. Consumer service modules that DO have a target
#     group should add their own aws_lb_listener_rule with priority < these.
#
# Priority numbering: 100 + index. Consumers using their own rules should
# pick priorities in 1..99 to take precedence, or 200+ to fall through.
###############################################################################

resource "aws_lb_listener_rule" "cognito_protected" {
  count = local.cognito_enabled_alb ? length(var.cognito_protected_paths) : 0

  listener_arn = aws_lb_listener.https[0].arn
  priority     = 100 + count.index

  action {
    type = "authenticate-cognito"

    authenticate_cognito {
      user_pool_arn              = var.cognito_user_pool_arn
      user_pool_client_id        = var.cognito_user_pool_client_id
      user_pool_domain           = var.cognito_user_pool_domain
      scope                      = "openid email profile"
      session_cookie_name        = "AWSELBAuthSessionCookie"
      session_timeout            = 604800 # 7 days
      on_unauthenticated_request = "authenticate"
    }
  }

  action {
    type = "fixed-response"

    fixed_response {
      content_type = "text/plain"
      message_body = "Authenticated. Service module must attach a target-group rule with higher priority."
      status_code  = "200"
    }
  }

  condition {
    path_pattern {
      values = [var.cognito_protected_paths[count.index]]
    }
  }

  tags = local.tags
}

###############################################################################
# ============================================================================
# API GW BRANCH
# ============================================================================
###############################################################################

###############################################################################
# 5. VPC-Link security group (only when consumer didn't pass their own)
#
# Default surface: open to VPC CIDR. The VPC Link ENIs sit in private subnets
# and never get a public IP — the SG is the second perimeter, not the first.
###############################################################################

resource "aws_security_group" "vpc_link" {
  count = local.vpc_link_use_module_sg ? 1 : 0

  # checkov:skip=CKV_AWS_23:Per-rule descriptions are inlined on the rule resources below.
  name        = "strata-${var.env_name}-apigw-vpclink-sg"
  description = "Strata ${var.env_name} apigw VPC-Link ENIs — VPC-CIDR ingress only."
  vpc_id      = var.vpc_id

  tags = merge(local.tags, {
    Name = "strata-${var.env_name}-apigw-vpclink-sg"
  })
}

resource "aws_vpc_security_group_ingress_rule" "vpc_link_from_vpc" {
  count = local.vpc_link_use_module_sg ? 1 : 0

  security_group_id = aws_security_group.vpc_link[0].id
  description       = "All TCP from the VPC CIDR — the VPC Link's ENI accepts traffic from the API GW backplane and forwards into the VPC."
  cidr_ipv4         = var.vpc_cidr
  ip_protocol       = "tcp"
  from_port         = 0
  to_port           = 65535

  tags = local.tags
}

resource "aws_vpc_security_group_egress_rule" "vpc_link_to_vpc" {
  count = local.vpc_link_use_module_sg ? 1 : 0

  security_group_id = aws_security_group.vpc_link[0].id
  description       = "Egress to anywhere in the VPC — the link must reach service ENIs across all private subnets."
  cidr_ipv4         = var.vpc_cidr
  ip_protocol       = "tcp"
  from_port         = 0
  to_port           = 65535

  tags = local.tags
}

###############################################################################
# 6. HTTP API
###############################################################################

resource "aws_apigatewayv2_api" "this" {
  count = local.is_apigw ? 1 : 0

  name          = "strata-${var.env_name}-api"
  description   = "Strata ${var.env_name} HTTP API — consumer modules attach routes pointing at their integrations."
  protocol_type = "HTTP"

  # Dev convenience: keep the default execute-api endpoint reachable. Custom
  # domains land at the cloudfront-dist module layer.
  disable_execute_api_endpoint = false

  cors_configuration {
    allow_origins     = local.cors.allow_origins
    allow_methods     = local.cors.allow_methods
    allow_headers     = local.cors.allow_headers
    expose_headers    = local.cors.expose_headers
    max_age           = local.cors.max_age
    allow_credentials = local.cors.allow_credentials
  }

  tags = merge(local.tags, {
    Name = "strata-${var.env_name}-api"
  })
}

###############################################################################
# 7. VPC Link
###############################################################################

resource "aws_apigatewayv2_vpc_link" "this" {
  count = local.is_apigw ? 1 : 0

  name               = "strata-${var.env_name}-vpclink"
  subnet_ids         = var.private_subnet_ids
  security_group_ids = local.vpc_link_sg_ids

  tags = merge(local.tags, {
    Name = "strata-${var.env_name}-vpclink"
  })
}

###############################################################################
# 8. Cognito JWT authorizer (optional)
#
# Per AWS doc, the issuer for a Cognito user pool is:
#   https://cognito-idp.{region}.amazonaws.com/{user_pool_id}
###############################################################################

resource "aws_apigatewayv2_authorizer" "cognito" {
  count = local.cognito_enabled_apigw ? 1 : 0

  api_id           = aws_apigatewayv2_api.this[0].id
  name             = "strata-${var.env_name}-cognito-jwt"
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]

  jwt_configuration {
    audience = [var.cognito_user_pool_client_id]
    issuer   = "https://cognito-idp.${var.aws_region}.amazonaws.com/${var.cognito_user_pool_id}"
  }
}

###############################################################################
# 9. CloudWatch log group for API GW execution logs (optional)
###############################################################################

resource "aws_cloudwatch_log_group" "apigw" {
  count = local.is_apigw && var.enable_logging ? 1 : 0

  # checkov:skip=CKV_AWS_158:AWS-owned CloudWatch Logs key. KMS-CMK upgrade is centralized in AWS-1.10 (observability) where the key lifecycle is owned.
  # checkov:skip=CKV_AWS_338:30-day retention matches the network module's flow-log retention and is appropriate for the request-log hot tier; long-tail forensics live in the bucket-archived access logs.
  name              = "/aws/apigateway/strata-${var.env_name}"
  retention_in_days = var.log_retention_days

  tags = local.tags
}

###############################################################################
# 10. $default stage (HTTP API quirk: stage exists separately from API)
#
# Auto-deploy on so route changes propagate without a manual deployment hop.
###############################################################################

resource "aws_apigatewayv2_stage" "default" {
  count = local.is_apigw ? 1 : 0

  # checkov:skip=CKV_AWS_120:Caching is route-level on HTTP APIs, not stage-level — defer to the consumer module that defines the routes.
  api_id      = aws_apigatewayv2_api.this[0].id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    detailed_metrics_enabled = true
    throttling_burst_limit   = 5000
    throttling_rate_limit    = 10000
  }

  dynamic "access_log_settings" {
    for_each = var.enable_logging ? [1] : []
    content {
      destination_arn = aws_cloudwatch_log_group.apigw[0].arn
      format = jsonencode({
        requestId          = "$context.requestId"
        ip                 = "$context.identity.sourceIp"
        requestTime        = "$context.requestTime"
        httpMethod         = "$context.httpMethod"
        routeKey           = "$context.routeKey"
        status             = "$context.status"
        protocol           = "$context.protocol"
        responseLength     = "$context.responseLength"
        integrationLatency = "$context.integrationLatency"
        userAgent          = "$context.identity.userAgent"
      })
    }
  }

  tags = local.tags
}
