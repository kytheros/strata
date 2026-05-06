output "state_bucket_name" {
  description = "Name of the S3 bucket holding Terraform state for this environment. Wire this into envs/{env}/backend.tf."
  value       = aws_s3_bucket.state.id
}

output "state_bucket_arn" {
  description = "ARN of the state bucket."
  value       = aws_s3_bucket.state.arn
}

output "lock_table_name" {
  description = "Name of the DynamoDB state-lock table."
  value       = aws_dynamodb_table.locks.name
}

output "lock_table_arn" {
  description = "ARN of the DynamoDB state-lock table."
  value       = aws_dynamodb_table.locks.arn
}

output "deploy_role_arn" {
  description = "ARN of the IAM role GitHub Actions assumes via OIDC. Plug into the GHA `aws-actions/configure-aws-credentials` step as `role-to-assume`."
  value       = aws_iam_role.deploy.arn
}

output "deploy_role_name" {
  description = "Name of the deploy role."
  value       = aws_iam_role.deploy.name
}

output "oidc_provider_arn" {
  description = "ARN of the GitHub OIDC identity provider in this account (whether created here or pre-existing)."
  value       = local.oidc_provider_arn
}

output "account_id" {
  description = "AWS account ID this bootstrap ran against. Sanity check against your tfvars."
  value       = data.aws_caller_identity.current.account_id
}

output "readonly_role_arn" {
  description = "ARN of the read-only IAM role GitHub Actions PR jobs assume via OIDC. Plug into the plan-on-PR workflow's aws-actions/configure-aws-credentials step. Null when create_readonly_role=false."
  value       = var.create_readonly_role ? aws_iam_role.readonly[0].arn : null
}

output "readonly_role_name" {
  description = "Name of the read-only role. Null when create_readonly_role=false."
  value       = var.create_readonly_role ? aws_iam_role.readonly[0].name : null
}
