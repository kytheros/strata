output "alarm_topic_arn" {
  description = "ARN of the SNS topic that all alarms publish to. Subscribe PagerDuty / Opsgenie / email to this. The module-created CMK protects message bodies at rest."
  value       = aws_sns_topic.alarms.arn
}

output "alarm_topic_name" {
  description = "Short name of the alarm SNS topic (strata-<env>-alarms)."
  value       = aws_sns_topic.alarms.name
}

output "kms_key_arn" {
  description = "ARN of the per-module CMK encrypting the SNS alarm topic. CloudWatch alarms publish through this key transparently; subscribers may need to be granted Decrypt depending on protocol."
  value       = aws_kms_key.alarms.arn
}

output "kms_key_alias" {
  description = "Alias of the per-module CMK (alias/strata-<env>-alarms)."
  value       = aws_kms_alias.alarms.name
}

output "dashboard_name" {
  description = "Name of the strata SLO CloudWatch dashboard (strata-<env>-slo)."
  value       = aws_cloudwatch_dashboard.slo.dashboard_name
}

output "dashboard_url" {
  description = "Console URL for the strata SLO dashboard. Useful for embedding in runbooks and incident channels."
  value       = "https://${var.aws_region}.console.aws.amazon.com/cloudwatch/home?region=${var.aws_region}#dashboards:name=${aws_cloudwatch_dashboard.slo.dashboard_name}"
}

output "ops_dashboard_name" {
  description = "Name of the Phase 4 ops CloudWatch dashboard (`strata-<env>-ops`). null when var.enable_ops_dashboard=false."
  value       = local.ops_dashboard_enabled ? aws_cloudwatch_dashboard.ops[0].dashboard_name : null
}

output "ops_dashboard_url" {
  description = "Console URL for the Phase 4 ops dashboard. null when var.enable_ops_dashboard=false. Bookmark this for incident response — broader surface than the SLO dashboard."
  value       = local.ops_dashboard_enabled ? "https://${var.aws_region}.console.aws.amazon.com/cloudwatch/home?region=${var.aws_region}#dashboards:name=${aws_cloudwatch_dashboard.ops[0].dashboard_name}" : null
}

output "jwt_auth_error_rate_alarm_arn" {
  description = "ARN of the JWT-authorizer error-rate alarm. null when var.apigw_log_group_name was not supplied (Phase 4 unwired)."
  value       = local.jwt_auth_metrics_enabled ? aws_cloudwatch_metric_alarm.jwt_auth_error_rate[0].arn : null
}

output "jwt_auth_error_metric_filter_name" {
  description = "Name of the metric filter counting JWT authorizer errors in the API GW access log. Diagnostic — confirm the filter is attached to the right log group via `aws logs describe-metric-filters`."
  value       = local.jwt_auth_metrics_enabled ? aws_cloudwatch_log_metric_filter.jwt_auth_error_count[0].name : null
}

output "cluster_log_group_name" {
  description = "Echo of var.cluster_log_group_name. Provided so consumers (and Phase 5 wiring) can confirm the cluster log group this module's metric_filters reference. Empty string when caller did not pass one."
  value       = var.cluster_log_group_name
}

output "service_log_group_arns" {
  description = "Map of caller-declared service log group name -> ARN. Use to wire IAM permissions on consumer task roles."
  value       = { for k, g in aws_cloudwatch_log_group.service : k => g.arn }
}

output "service_log_group_names" {
  description = "List of caller-declared service log group names. Pass to ECS task definitions via awslogs-group."
  value       = [for g in aws_cloudwatch_log_group.service : g.name]
}

output "metric_filter_names" {
  description = "List of EMF metric filter names provisioned. Useful for asserting in CI that expected metric filters exist."
  value       = [for f in aws_cloudwatch_log_metric_filter.this : f.name]
}

output "alarm_arns" {
  description = "Map of alarm short-name → ARN for every alarm created by this module. Phase 5 cost guardrails + runbook automation consume this. Keys correspond to runbook filenames in runbooks/<key>.md."
  value = merge(
    {
      for k, v in aws_cloudwatch_metric_alarm.alb_5xx_rate : "alb_5xx_rate" => v.arn
    },
    {
      for k, v in aws_cloudwatch_metric_alarm.alb_p99_latency : "alb_p99_latency" => v.arn
    },
    {
      for k, v in aws_cloudwatch_metric_alarm.ecs_task_shortfall : "ecs_task_shortfall_${k}" => v.arn
    },
    {
      for k, v in aws_cloudwatch_metric_alarm.aurora_acu_max : "aurora_acu_max" => v.arn
    },
    {
      for k, v in aws_cloudwatch_metric_alarm.aurora_cpu_high : "aurora_cpu_high" => v.arn
    },
    {
      for k, v in aws_cloudwatch_metric_alarm.redis_cpu_high : "redis_cpu_high" => v.arn
    },
    {
      for k, v in aws_cloudwatch_metric_alarm.redis_storage_high : "redis_storage_high" => v.arn
    },
    {
      for k, v in aws_cloudwatch_metric_alarm.nat_bytes_out_anomaly : "nat_bytes_out_anomaly_${k}" => v.arn
    },
    {
      for k, v in aws_cloudwatch_metric_alarm.cognito_auth_failure_rate : "cognito_auth_failure_rate" => v.arn
    },
    {
      for k, v in aws_cloudwatch_metric_alarm.jwt_auth_error_rate : "jwt_auth_error_rate" => v.arn
    },
  )
}

output "alarm_count" {
  description = "Total number of alarms created by this apply. Useful for cost projection (CloudWatch alarm pricing × this number)."
  value = (
    length(aws_cloudwatch_metric_alarm.alb_5xx_rate) +
    length(aws_cloudwatch_metric_alarm.alb_p99_latency) +
    length(aws_cloudwatch_metric_alarm.ecs_task_shortfall) +
    length(aws_cloudwatch_metric_alarm.aurora_acu_max) +
    length(aws_cloudwatch_metric_alarm.aurora_cpu_high) +
    length(aws_cloudwatch_metric_alarm.redis_cpu_high) +
    length(aws_cloudwatch_metric_alarm.redis_storage_high) +
    length(aws_cloudwatch_metric_alarm.nat_bytes_out_anomaly) +
    length(aws_cloudwatch_metric_alarm.cognito_auth_failure_rate) +
    length(aws_cloudwatch_metric_alarm.jwt_auth_error_rate)
  )
}
