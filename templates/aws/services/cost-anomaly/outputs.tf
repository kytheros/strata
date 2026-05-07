output "anomaly_monitor_arn" {
  description = "ARN of the Cost Explorer DIMENSIONAL anomaly monitor. null when var.enabled = false (the account-default monitor is sufficient for dev)."
  value       = var.enabled ? aws_ce_anomaly_monitor.this[0].arn : null
}

output "anomaly_monitor_name" {
  description = "Friendly name of the anomaly monitor (strata-env-all-services). null when var.enabled = false."
  value       = var.enabled ? aws_ce_anomaly_monitor.this[0].name : null
}

output "anomaly_subscription_arn" {
  description = "ARN of the Cost Anomaly subscription. null when var.enabled = false."
  value       = var.enabled ? aws_ce_anomaly_subscription.this[0].arn : null
}
