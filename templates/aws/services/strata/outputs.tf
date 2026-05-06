output "service_name" {
  description = "Name of the ECS service (`strata-<env>`)."
  value       = module.service.service_name
}

output "service_arn" {
  description = "ARN of the ECS service. Useful for IAM scoping, alarm dimensions, and operator `aws ecs describe-services` calls."
  value       = module.service.service_arn
}

output "task_role_arn" {
  description = "ARN of the IAM task role the Strata containers assume. Useful for cross-account trust policies and KMS key policies that need to grant access to this specific service."
  value       = module.service.task_role_arn
}

output "task_definition_arn" {
  description = "ARN (with revision) of the active Strata task definition."
  value       = module.service.task_definition_arn
}

output "security_group_id" {
  description = "ID of the Strata service's task security group. The Aurora and Redis modules consume this as `var.allowed_security_group_ids` so they can scope their ingress rules to this service's tasks."
  value       = module.service.security_group_id
}

output "target_group_arn" {
  description = "ALB target group ARN when backend=alb, else null."
  value       = module.service.target_group_arn
}

output "apigw_integration_id" {
  description = "API GW integration ID when backend=apigw, else null. Caller passes this as `target = \"integrations/<id>\"` on aws_apigatewayv2_route resources."
  value       = module.service.apigw_integration_id
}

output "health_check_url" {
  description = "HTTPS URL of the service's /health endpoint, constructed from the ingress endpoint DNS. Operators paste it into a browser or `curl` to confirm the service is reachable."
  value       = "https://${var.ingress_endpoint_dns}/health"
}

output "database_url_secret_arn" {
  description = "ARN of the synthesized DATABASE_URL secret. Diagnostic — operators should never need to read this directly; ECS injects it into the task at launch."
  value       = module.database_url_secret.secret_arn
}

output "auth_proxy_secret_arn" {
  description = "ARN of the STRATA_AUTH_PROXY_TOKEN secret actually wired into the task definition. When var.auth_proxy_secret_arn was supplied, this echoes that input (the orchestrator's services/ingress-authorizer secret). Otherwise it's the locally-minted standalone secret. Diagnostic only — never expose to clients."
  value       = local.effective_auth_proxy_secret_arn
}

output "user_data_bucket_arn" {
  description = "ARN of the optional per-tenant SQLite bucket. Null when var.create_user_data_bucket=false (the v1 default)."
  value       = var.create_user_data_bucket ? module.user_data_bucket[0].bucket_arn : null
}
