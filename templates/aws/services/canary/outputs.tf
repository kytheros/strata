output "credentials_secret_arn" {
  description = "Secrets Manager ARN of the test-user credentials secret. Operator seeds the JSON value via `aws secretsmanager put-secret-value --secret-id <this> --secret-string '{\"username\":\"...\", \"password\":\"...\"}'`. Provisioned even when canary_enabled=false."
  value       = module.credentials_secret.secret_arn
}

output "credentials_secret_kms_key_arn" {
  description = "ARN of the per-secret CMK encrypting the test-user credentials. Diagnostic; consumers do not need to grant Decrypt explicitly because the consumer policy is wired through the module."
  value       = module.credentials_secret.kms_key_arn
}

output "function_name" {
  description = "Name of the canary Lambda function. null when canary_enabled=false."
  value       = local.enabled ? aws_lambda_function.canary[0].function_name : null
}

output "function_arn" {
  description = "ARN of the canary Lambda function. null when canary_enabled=false."
  value       = local.enabled ? aws_lambda_function.canary[0].arn : null
}

output "log_group_name" {
  description = "CloudWatch Logs group capturing canary output. Useful for incident response — `aws logs tail <this> --since 30m` shows recent CANARY_OK / CANARY_FAIL lines. null when canary_enabled=false."
  value       = local.enabled ? aws_cloudwatch_log_group.lambda[0].name : null
}

output "schedule_rule_arn" {
  description = "ARN of the EventBridge rule firing the canary on schedule. Diagnostic; operators check `aws events describe-rule` against this when validating the cadence. null when canary_enabled=false."
  value       = local.enabled ? aws_cloudwatch_event_rule.schedule[0].arn : null
}

output "failure_alarm_arn" {
  description = "ARN of the canary failure-rate alarm wired to the existing SNS alarm topic. null when canary_enabled=false."
  value       = local.enabled ? aws_cloudwatch_metric_alarm.failure[0].arn : null
}
