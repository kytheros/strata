output "cluster_id" {
  description = "ID of the ECS cluster (same as cluster_arn for ECS — provided as a separate output for callers that key off the documented `id` attribute)."
  value       = aws_ecs_cluster.this.id
}

output "cluster_name" {
  description = "Name of the ECS cluster (strata-<env>). Consumers pass this to `ecs-service` modules as `cluster_name`."
  value       = aws_ecs_cluster.this.name
}

output "cluster_arn" {
  description = "ARN of the ECS cluster. Consumed by IAM trust policies and CloudWatch alarm dimensions."
  value       = aws_ecs_cluster.this.arn
}

output "log_group_name" {
  description = "Name of the cluster-scoped CloudWatch Logs group (/ecs/strata-<env>). Service task definitions reference this as their awslogs-group when no service-specific group is provisioned."
  value       = aws_cloudwatch_log_group.this.name
}

output "log_group_arn" {
  description = "ARN of the cluster-scoped CloudWatch Logs group. Useful when wiring metric filters or subscription filters in the observability module."
  value       = aws_cloudwatch_log_group.this.arn
}

output "kms_key_arn" {
  description = "ARN of the per-cluster CMK encrypting the log group. Service task roles that write to the log group above must be granted kms:GenerateDataKey on this key."
  value       = aws_kms_key.logs.arn
}

output "kms_key_alias" {
  description = "Alias of the per-cluster CMK (alias/strata-<env>-ecs-logs). Provided alongside kms_key_arn so consumers can reference the alias in human-readable contexts."
  value       = aws_kms_alias.logs.name
}

output "exec_role_arn" {
  description = "ARN of the IAM role that grants `aws ecs execute-command` access against tasks in this cluster. Operators assume this role (via SSO or IAM user) to open SSM Session Manager sessions into running Fargate tasks."
  value       = aws_iam_role.exec.arn
}

output "exec_role_name" {
  description = "Name of the ECS-Exec operator role. Useful for assume-role policies and CI workflows that need to grant the role to specific principals."
  value       = aws_iam_role.exec.name
}
