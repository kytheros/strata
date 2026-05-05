output "secret_arn" {
  description = "ARN of the Secrets Manager secret. Pass to consumer task definitions via the `secrets` block, or attach `consumer_iam_policy_json` to grant read access."
  value       = aws_secretsmanager_secret.this.arn
}

output "secret_name" {
  description = "Full path-style name of the secret (`strata/{env}/{secret_name}`). Useful for `aws secretsmanager` CLI calls."
  value       = aws_secretsmanager_secret.this.name
}

output "secret_id" {
  description = "Secrets Manager secret ID — same as the ARN. Provided for symmetry with the AWS provider's `secret_id` argument naming."
  value       = aws_secretsmanager_secret.this.id
}

output "secret_version_id" {
  description = "AWSCURRENT version ID, present only when var.create_initial_version = true. Empty string otherwise. Useful for downstream resources that need to depend on the initial value being seeded before they read it."
  value       = var.create_initial_version ? aws_secretsmanager_secret_version.initial[0].version_id : ""
}

output "kms_key_arn" {
  description = "ARN of the KMS key encrypting this secret. Either the module-created per-secret CMK or var.kms_key_id (passed through). Consumers grant `kms:Decrypt` on this ARN to read the secret."
  value       = local.effective_kms_arn
}

output "kms_key_alias" {
  description = "Alias of the module-created CMK, or empty string when var.kms_key_id was supplied. Format: `alias/strata-secret-{env}-{name}` (slashes in secret_name normalized to hyphens because aliases disallow `/`)."
  value       = local.create_cmk ? aws_kms_alias.this[0].name : ""
}

output "rotation_enabled" {
  description = "True when a rotation Lambda is wired up. Useful for caller-side conditional alarms (e.g., 'rotation overdue' alarm only fires when this is true)."
  value       = local.rotation_enabled
}

output "consumer_iam_policy_json" {
  description = "Least-privilege IAM policy JSON granting `secretsmanager:GetSecretValue` on this secret's ARN and `kms:Decrypt` on the encrypting key (scoped via `kms:ViaService` to the Secrets Manager backplane). Consumer task roles attach this — typically as an inline policy. Render-only; the module does not create an `aws_iam_policy` resource because attachment shape varies by consumer (ECS task role, Lambda exec role, EC2 instance profile, etc.)."
  value       = data.aws_iam_policy_document.consumer.json
}
