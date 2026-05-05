output "bucket_id" {
  description = "Bucket ID. For S3, this equals the bucket name."
  value       = aws_s3_bucket.this.id
}

output "bucket_name" {
  description = "Resolved bucket name. Defaults to 'strata-$${purpose}-$${account_id}-$${env_name}', or var.bucket_name_override when set."
  value       = aws_s3_bucket.this.bucket
}

output "bucket_arn" {
  description = "ARN of the bucket. Use in IAM policies for tasks/roles that read or write here."
  value       = aws_s3_bucket.this.arn
}

output "bucket_regional_domain_name" {
  description = "Regional bucket domain name (e.g. 'my-bucket.s3.us-east-1.amazonaws.com'). Use as a CloudFront origin domain when fronting this bucket."
  value       = aws_s3_bucket.this.bucket_regional_domain_name
}

output "kms_key_arn" {
  description = "ARN of the KMS CMK used for SSE on this bucket — whether the module created one (default) or the consumer passed one in via var.kms_key_id."
  value       = local.kms_key_arn
}

output "kms_key_alias" {
  description = "Alias of the module-created CMK (e.g. 'alias/strata-artifacts-dev'), or null when the consumer passed in their own key."
  value       = local.module_creates_cmk ? aws_kms_alias.this[0].name : null
}

output "oac_id" {
  description = "ID of the CloudFront Origin Access Control. Null when var.cloudfront_oac_enabled = false."
  value       = var.cloudfront_oac_enabled ? aws_cloudfront_origin_access_control.this[0].id : null
}
