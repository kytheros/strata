###############################################################################
# Orchestrator outputs.
#
# Surface the load-bearing values an operator needs after a successful apply
# (or that downstream tooling — e.g. CI/CD smoke tests — consumes from the
# state). Module-internal outputs that operators rarely need are intentionally
# omitted; pull them via `terraform output -json -state=<bucket>` or scoped
# `terraform state show module.<name>` calls if needed.
###############################################################################

output "aws_region" {
  description = "Region the orchestrator deployed into."
  value       = var.aws_region
}

output "vpc_id" {
  description = "VPC ID. Cross-reference with the AWS console when debugging connectivity."
  value       = module.network.vpc_id
}

output "ingress_endpoint_dns" {
  description = "Public DNS hostname of the API Gateway HTTP API. Browsers and curl hit this. After first apply, update var.example_agent_app_url to `https://<this>` and re-apply to wire it into Cognito callback URLs."
  value       = module.ingress.endpoint_dns
}

output "cognito_hosted_ui_url" {
  description = "Fully-qualified Cognito Hosted UI base URL. The example-agent's /api/auth/login route appends OAuth params to this."
  value       = module.example_agent.cognito_hosted_ui_url
}

output "cognito_user_pool_id" {
  description = "Cognito User Pool ID — useful for `aws cognito-idp admin-*` CLI calls when debugging signup flow."
  value       = module.example_agent.user_pool_id
}

output "strata_service_arn" {
  description = "ARN of the Strata Fargate service."
  value       = module.strata_service.service_arn
}

output "strata_health_check_url" {
  description = "HTTPS URL of Strata's /health endpoint via the ingress. `curl <this>` to confirm the service is reachable end-to-end."
  value       = module.strata_service.health_check_url
}

output "example_agent_service_arn" {
  description = "ARN of the example-agent Fargate service."
  value       = module.example_agent.service_arn
}

output "example_agent_app_url" {
  description = "Public URL of the example-agent (mirrors var.example_agent_app_url)."
  value       = module.example_agent.app_url
}

output "observability_dashboard_url" {
  description = "Console URL of the strata SLO CloudWatch dashboard. Bookmark this for incident response."
  value       = module.observability.dashboard_url
}

output "alarm_topic_arn" {
  description = "ARN of the SNS alarm topic. Subscribe additional endpoints out-of-band via `aws sns subscribe` if needed."
  value       = module.observability.alarm_topic_arn
}

output "allowlist_ssm_path" {
  description = "SSM Parameter Store path for the email allowlist. Operators add/remove emails via `aws ssm put-parameter --name <this> --value '[\"a@b.com\", ...]' --overwrite`."
  value       = module.example_agent.allowlist_ssm_path
}

output "anthropic_api_key_secret_arn" {
  description = "Secrets Manager ARN reserved for the Anthropic API key. Created empty by the example-agent module; operator seeds via `aws secretsmanager put-secret-value --secret-id <this> --secret-string sk-ant-...`."
  value       = module.example_agent.anthropic_api_key_secret_arn
}

output "task_exec_role_arn" {
  description = "ARN of the shared ECS task-execution role. Useful for IAM auditing — confirm `AmazonECSTaskExecutionRolePolicy` is attached and the env-scoped secret read inline policy is present."
  value       = aws_iam_role.task_exec.arn
}

output "aurora_cluster_id" {
  description = "Aurora DB cluster identifier. Use with `aws rds describe-db-clusters --db-cluster-identifier <this>` for direct admin access."
  value       = module.aurora_postgres.cluster_id
}

output "redis_cache_id" {
  description = "ElastiCache Serverless cache name/ID. Use with `aws elasticache describe-serverless-caches` for inspection."
  value       = module.elasticache_redis.cache_id
}
