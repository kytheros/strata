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

output "cognito_test_user_client_id" {
  description = "Test-user Cognito app client ID (ADMIN_USER_PASSWORD_AUTH only). Consumed by E2E smoke tests and the synthetic canary to mint access tokens via `cognito-idp:AdminInitiateAuth` against the test-user credentials secret. Null when canary_enabled = false."
  value       = module.example_agent.test_user_client_id
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

output "observability_ops_dashboard_url" {
  description = "Console URL of the Phase 4 ops dashboard (broader surface than the SLO view — ECS per-service utilization, API GW request/error/latency mix, NLB flows, Aurora ACU / connections / replica lag, Redis Serverless usage, NAT egress, VPC-endpoint usage, JWT authentication funnel)."
  value       = module.observability.ops_dashboard_url
}

output "canary_credentials_secret_arn" {
  description = "Secrets Manager ARN of the canary's test-user credentials. Seed once via `aws secretsmanager put-secret-value --secret-id <this> --secret-string '{\"username\":\"...\", \"password\":\"...\"}'` before flipping `canary_enabled = true`."
  value       = module.canary.credentials_secret_arn
}

output "canary_log_group_name" {
  description = "CloudWatch Logs group capturing canary output. `aws logs tail <this> --since 30m --follow` is the fastest way to see CANARY_OK / CANARY_FAIL lines during incident response."
  value       = module.canary.log_group_name
}

output "canary_failure_alarm_arn" {
  description = "ARN of the canary failure alarm wired to the existing observability SNS topic. null when canary_enabled=false."
  value       = module.canary.failure_alarm_arn
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

###############################################################################
# AWS-1.6.1 — ingress authorizer outputs
###############################################################################

output "mcp_jwt_authorizer_id" {
  description = "API GW Cognito JWT authorizer ID. External MCP clients hitting `https://<ingress>/mcp` must present a token issued by this user pool / app client. Diagnostic only."
  value       = module.ingress_authorizer.authorizer_id
}

output "mcp_jwt_issuer_url" {
  description = "Cognito JWT issuer URL — what external MCP clients must present in the `iss` claim. Document in operator runbooks for client onboarding."
  value       = module.ingress_authorizer.jwt_issuer_url
}

output "mcp_route_keys" {
  description = "Route keys created on the API GW for the JWT-authorized Strata path. Useful for `aws apigatewayv2 get-routes --api-id <id>` cross-checks."
  value       = module.ingress_authorizer.mcp_route_keys
}

output "auth_proxy_secret_arn" {
  description = "Secrets Manager ARN of the shared STRATA_AUTH_PROXY_TOKEN. Both the API GW integration's X-Strata-Verified injection and the Strata service's STRATA_AUTH_PROXY_TOKEN env var resolve to this secret. Diagnostic only — never expose."
  value       = module.ingress_authorizer.auth_proxy_secret_arn
}

###############################################################################
# AWS-1.6.6 — internal NLB outputs
###############################################################################

output "mcp_nlb_dns_name" {
  description = "Internal NLB DNS hostname fronting Strata for the API GW path. Resolvable from inside the VPC; not from the public internet. Useful for in-VPC `curl` tests when debugging the external-MCP route."
  value       = module.ingress_authorizer.strata_nlb_dns_name
}

output "mcp_nlb_target_group_arn" {
  description = "ARN of the NLB target group Strata's tasks register on. Operators run `aws elbv2 describe-target-health --target-group-arn <this>` to confirm tasks are healthy before validating the external-MCP path."
  value       = module.ingress_authorizer.strata_nlb_target_group_arn
}

###############################################################################
# AWS-5.1 -- Cost Anomaly Detection outputs
###############################################################################

output "cost_anomaly_monitor_arn" {
  description = "ARN of the CE DIMENSIONAL anomaly monitor (strata-dev-all-services). Reference in runbooks when investigating a Cost Anomaly Detection alert."
  value       = module.cost_anomaly.anomaly_monitor_arn
}

output "cost_anomaly_subscription_arn" {
  description = "ARN of the Cost Anomaly subscription. Cross-reference in Cost Management > Cost Anomaly Detection > Subscriptions."
  value       = module.cost_anomaly.anomaly_subscription_arn
}
