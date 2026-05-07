###############################################################################
# Unified output shape across both backends.
#
# Per spec: consumer modules use the *same* output names regardless of
# backend. Values that don't apply to the active backend are emitted as
# `null` so downstream wiring code can branch via try() / coalesce() instead
# of inspecting var.backend.
###############################################################################

output "backend" {
  description = "Active backend — \"alb\" or \"apigw\". Mirrors var.backend; useful for human inspection and downstream `terraform output` consumers."
  value       = var.backend
}

output "endpoint_dns" {
  description = "Public DNS hostname of the ingress (scheme-stripped). ALB: the load-balancer DNS name. API GW: the api_endpoint hostname (the upstream `api_endpoint` attribute is `https://...` — we strip the scheme so consumers can prepend `https://` consistently regardless of backend)."
  value = (
    var.backend == "alb"
    ? try(aws_lb.this[0].dns_name, null)
    : try(replace(aws_apigatewayv2_api.this[0].api_endpoint, "https://", ""), null)
  )
}

output "endpoint_zone_id" {
  description = "Route 53 hosted-zone ID for the ALB DNS name (use as `alias.zone_id` on an A-record). null when backend=apigw — API GW custom domains use a different alias mechanism wired in cloudfront-dist."
  value       = var.backend == "alb" ? try(aws_lb.this[0].zone_id, null) : null
}

# ----------------------------------------------------------------------------
# ALB-specific outputs (null when backend=apigw)
# ----------------------------------------------------------------------------

output "alb_arn" {
  description = "ALB ARN. null when backend=apigw."
  value       = var.backend == "alb" ? try(aws_lb.this[0].arn, null) : null
}

output "listener_arn" {
  description = "HTTPS listener ARN. Service modules attach their aws_lb_listener_rule resources here. null when backend=apigw."
  value       = var.backend == "alb" ? try(aws_lb_listener.https[0].arn, null) : null
}

output "http_listener_arn" {
  description = "HTTP→HTTPS redirect listener ARN. null when backend=apigw."
  value       = var.backend == "alb" ? try(aws_lb_listener.http[0].arn, null) : null
}

output "security_group_id" {
  description = "Primary ingress security-group ID. ALB: the ALB SG (consumers reference it as the source for ECS-task ingress rules). API GW: the VPC-Link SG (or the first consumer-provided SG)."
  value = (
    var.backend == "alb"
    ? try(aws_security_group.alb[0].id, null)
    : try(local.vpc_link_sg_ids[0], null)
  )
}

output "target_group_arn" {
  description = "Default target-group ARN. Empty in v1 — consumer service modules create and attach their own target groups via aws_lb_target_group + aws_lb_listener_rule, then the ECS service registers tasks against it. null when backend=apigw."
  value       = null
}

# ----------------------------------------------------------------------------
# API GW-specific outputs (null when backend=alb)
# ----------------------------------------------------------------------------

output "api_id" {
  description = "HTTP API ID. null when backend=alb."
  value       = var.backend == "apigw" ? try(aws_apigatewayv2_api.this[0].id, null) : null
}

output "api_arn" {
  description = "HTTP API ARN. Used to scope IAM grants for any caller that programmatically invokes the API. null when backend=alb."
  value       = var.backend == "apigw" ? try(aws_apigatewayv2_api.this[0].arn, null) : null
}

output "api_execution_arn" {
  description = "HTTP API execution ARN — needed when granting Lambda invoke permissions to API GW. null when backend=alb."
  value       = var.backend == "apigw" ? try(aws_apigatewayv2_api.this[0].execution_arn, null) : null
}

output "vpc_link_id" {
  description = "VPC Link ID — consumer modules supply this when defining VPC-LINK integrations. null when backend=alb."
  value       = var.backend == "apigw" ? try(aws_apigatewayv2_vpc_link.this[0].id, null) : null
}

output "authorizer_id" {
  description = "Cognito JWT authorizer ID. null when backend=alb or when no Cognito user pool was supplied. Consumer modules reference this in aws_apigatewayv2_route.authorizer_id when protecting routes."
  value       = local.cognito_enabled_apigw ? try(aws_apigatewayv2_authorizer.cognito[0].id, null) : null
}

output "stage_name" {
  description = "API GW stage name. Always `$default` for HTTP APIs in this module. null when backend=alb."
  value       = var.backend == "apigw" ? try(aws_apigatewayv2_stage.default[0].name, null) : null
}

output "log_group_name" {
  description = "CloudWatch log group capturing API GW execution/access logs. null when backend=alb or when var.enable_logging=false."
  value       = local.is_apigw && var.enable_logging ? try(aws_cloudwatch_log_group.apigw[0].name, null) : null
}

# ----------------------------------------------------------------------------
# Cross-backend convenience outputs
# ----------------------------------------------------------------------------

output "cognito_wired" {
  description = "True when a Cognito authorizer (apigw) or authenticate_cognito listener rule (alb) was actually created. False when Cognito vars were left empty or var.cognito_protected_paths was empty for ALB."
  value       = local.cognito_enabled_apigw || (local.cognito_enabled_alb && length(var.cognito_protected_paths) > 0)
}
