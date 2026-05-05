output "service_name" {
  description = "Name of the ECS service. Same as var.service_name; emitted as an output for symmetry and for downstream modules that take a service identifier."
  value       = aws_ecs_service.this.name
}

output "service_arn" {
  description = "ARN of the ECS service. Used to scope IAM permissions, attach autoscaling policies (already wired here), and dimension CloudWatch alarms."
  value       = aws_ecs_service.this.id
}

output "task_definition_arn" {
  description = "ARN of the active task definition revision. Includes the revision number — bumps every apply that mutates the task shape (image, env, secrets, port mappings, etc.)."
  value       = aws_ecs_task_definition.this.arn
}

output "task_definition_revision" {
  description = "Revision number of the active task definition. Useful for ECS Exec scripting and for the observability module's task-shortfall alarm dimensions."
  value       = aws_ecs_task_definition.this.revision
}

output "task_definition_family" {
  description = "Task definition family (`<service>-<env>`). Useful for `aws ecs describe-task-definition --task-definition <family>` lookups."
  value       = aws_ecs_task_definition.this.family
}

output "task_role_arn" {
  description = "ARN of the IAM task role this service's containers assume. Useful for cross-account trust policies, KMS key policies, and S3 bucket policies that need to grant access to this specific service."
  value       = aws_iam_role.task.arn
}

output "task_role_name" {
  description = "Name of the IAM task role. Useful for attaching additional managed policies out-of-band (though prefer var.task_role_managed_policy_arns where possible — keeps the IaC source-of-truth complete)."
  value       = aws_iam_role.task.name
}

output "security_group_id" {
  description = "ID of the security group attached to the task ENIs. Aurora and Redis modules consume this as `var.allowed_security_group_ids` so they can scope their ingress rules to this service's tasks."
  value       = aws_security_group.this.id
}

output "target_group_arn" {
  description = "ARN of the ALB target group when LB-attached, else null. Useful for downstream modules that wire WAF or shield rules at the target-group layer."
  value       = local.alb_attached ? aws_lb_target_group.this[0].arn : null
}

output "target_group_name" {
  description = "Name of the ALB target group when LB-attached, else null. The module truncates `<service>-tg` to ≤32 chars per AWS limit; this output exposes the truncated form so the caller doesn't have to re-derive it."
  value       = local.alb_attached ? aws_lb_target_group.this[0].name : null
}

output "apigw_integration_id" {
  description = "ID of the API GW HTTP_PROXY integration when API-GW-attached, else null. Caller passes this as `target = \"integrations/<id>\"` on their `aws_apigatewayv2_route` resources."
  value       = local.apigw_attached ? aws_apigatewayv2_integration.this[0].id : null
}

output "autoscaling_target_resource_id" {
  description = "Resource ID of the App Auto Scaling target (`service/<cluster-name>/<service-name>`). Useful when adding step-scaling policies or scheduled actions out-of-band — pass this as `resource_id` on the additional `aws_appautoscaling_policy` or `aws_appautoscaling_scheduled_action`."
  value       = aws_appautoscaling_target.this.resource_id
}
