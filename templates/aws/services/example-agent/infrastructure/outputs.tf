###############################################################################
# Outputs surface the load-bearing values for AWS-3.2 and AWS-3.3 to consume,
# plus the values an operator needs to verify the apply.
###############################################################################

output "service_arn" {
  description = "ARN of the ECS service. Use to scope IAM grants, attach autoscaling policies, dimension CloudWatch alarms."
  value       = module.ecs_service.service_arn
}

output "service_name" {
  description = "ECS service name (`example-agent-{env_name}`)."
  value       = module.ecs_service.service_name
}

output "task_role_arn" {
  description = "Task role ARN. AWS-3.3 attaches the SDK ReadOnlyAccess policy here."
  value       = module.ecs_service.task_role_arn
}

output "task_role_name" {
  description = "Task role name. AWS-3.3 references this when computing the policy-simulator gate's principal."
  value       = module.ecs_service.task_role_name
}

output "security_group_id" {
  description = "Service security group ID. Strata-on-AWS scopes its ingress rule to this SG when allowing the example-agent to call /mcp internally."
  value       = module.ecs_service.security_group_id
}

output "app_url" {
  description = "Public URL of the example-agent. Mirrors var.app_url; surfaced as an output so the README and downstream tickets can reference module.example_agent.app_url instead of duplicating the variable."
  value       = var.app_url
}

###############################################################################
# Cognito surface
###############################################################################

output "user_pool_id" {
  description = "Cognito User Pool ID created for the example-agent. AWS-3.2 needs this to wire AdminAddUserToGroupCommand."
  value       = module.cognito_user_pool.user_pool_id
}

output "user_pool_arn" {
  description = "Cognito User Pool ARN. Used to scope IAM grants for AWS-3.2's PostConfirmation Lambda."
  value       = module.cognito_user_pool.user_pool_arn
}

output "user_pool_client_id" {
  description = "App Client ID. Public — mirrored into the container env."
  value       = module.cognito_user_pool.user_pool_client_id
}

output "user_pool_client_secret" {
  description = "App Client secret. Sensitive — needed by the Next.js server for OAuth code exchange. AWS-3.2 mirrors this into a Secrets Manager entry and feeds it into the task definition's secrets[] block."
  value       = module.cognito_user_pool.user_pool_client_secret
  sensitive   = true
}

output "cognito_hosted_ui_url" {
  description = "Fully-qualified Cognito Hosted UI base URL. The Next.js /api/auth/login route appends OAuth params to this."
  value       = module.cognito_user_pool.hosted_ui_base_url
}

output "cognito_hosted_ui_domain" {
  description = "Cognito Hosted UI domain prefix (used to construct the /oauth2/* endpoints in the Next.js client)."
  value       = module.cognito_user_pool.hosted_ui_domain
}

output "cognito_jwks_uri" {
  description = "JWKS URI — aws-jwt-verify fetches this at boot."
  value       = module.cognito_user_pool.jwks_uri
}

output "cognito_issuer_url" {
  description = "JWT issuer URL — what aws-jwt-verify expects as the `iss` claim."
  value       = module.cognito_user_pool.issuer_url
}

output "google_federation_enabled" {
  description = "True when Google federation was wired (var.google_client_id + var.google_client_secret_arn both set)."
  value       = module.cognito_user_pool.google_federation_enabled
}

output "approved_group_arn" {
  description = "ARN of the `approved` Cognito group. AWS-3.2 PostConfirmation Lambda calls AdminAddUserToGroupCommand against this group."
  value       = module.cognito_user_pool.groups["approved"]
}

###############################################################################
# Allowlist surface
###############################################################################

output "allowlist_ssm_path" {
  description = "SSM Parameter Store path for the email allowlist. AWS-3.2 PreSignUp Lambda reads this via @aws-sdk/client-ssm."
  value       = aws_ssm_parameter.allowlist.name
}

output "allowlist_ssm_arn" {
  description = "SSM Parameter ARN. Used to scope the PreSignUp Lambda's ssm:GetParameter IAM grant."
  value       = aws_ssm_parameter.allowlist.arn
}

output "allowlist_kms_key_arn" {
  description = "ARN of the CMK encrypting the allowlist parameter. The PreSignUp Lambda needs kms:Decrypt on this key to read the allowlist."
  value       = aws_kms_key.allowlist.arn
}

output "allowlist_kms_alias" {
  description = "Friendly alias for the allowlist CMK."
  value       = aws_kms_alias.allowlist.name
}
