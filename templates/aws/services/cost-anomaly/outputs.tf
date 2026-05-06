output "anomaly_monitor_arn" {
  description = "ARN of the Cost Explorer DIMENSIONAL anomaly monitor."
  value       = aws_ce_anomaly_monitor.this.arn
}

output "anomaly_monitor_name" {
  description = "Friendly name of the anomaly monitor (strata-env-all-services)."
  value       = aws_ce_anomaly_monitor.this.name
}

output "anomaly_subscription_arn" {
  description = "ARN of the Cost Anomaly subscription."
  value       = aws_ce_anomaly_subscription.this.arn
}
