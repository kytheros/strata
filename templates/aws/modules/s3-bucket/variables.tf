variable "env_name" {
  description = "Environment short name (dev|staging|prod). Used in resource naming and tags."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.env_name)
    error_message = "env_name must be one of: dev, staging, prod."
  }
}

variable "purpose" {
  description = "Short purpose label for this bucket (e.g. 'artifacts', 'user-data', 'logs'). Used in the bucket name and the `Purpose` tag. Must match [a-z0-9-]+ — bucket-name compatible."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]*[a-z0-9]$", var.purpose)) && length(var.purpose) <= 32
    error_message = "purpose must be lowercase alphanumeric with internal hyphens, start/end alphanumeric, and ≤32 chars (S3 bucket naming compatible)."
  }
}

variable "aws_region" {
  description = "AWS region. Used in the KMS key alias and any region-scoped resource references."
  type        = string
  default     = "us-east-1"
}

variable "bucket_name_override" {
  description = "Optional explicit bucket name. When empty (default) the module derives 'strata-$${purpose}-$${account_id}-$${env_name}'. Override only for cross-account / cross-env imports where the existing name doesn't match the pattern."
  type        = string
  default     = ""

  validation {
    condition     = var.bucket_name_override == "" || (can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.bucket_name_override)) && length(var.bucket_name_override) <= 63)
    error_message = "bucket_name_override must be empty or a valid S3 bucket name (3-63 chars, lowercase alphanumeric/hyphens/dots, start+end alphanumeric)."
  }
}

variable "versioning_enabled" {
  description = "Whether to enable bucket versioning. Default true. Set false only for buckets where rotation/expiration already provides the durability story (e.g. logs with a hard 90-day expiry)."
  type        = bool
  default     = true
}

variable "kms_key_id" {
  description = "Optional KMS key ARN or ID for SSE-KMS. When empty (default) the module creates a per-bucket CMK with key rotation, alias 'alias/strata-$${purpose}-$${env_name}', and a key policy allowing the S3 service principal to use it. Pass an existing key ARN to share a CMK across buckets."
  type        = string
  default     = ""
}

variable "cloudfront_oac_enabled" {
  description = "When true, create an aws_cloudfront_origin_access_control and add an AllowCloudFrontServicePrincipal statement to the bucket policy. Required when this bucket is a CloudFront origin (e.g. the artifacts bucket)."
  type        = bool
  default     = false
}

variable "cloudfront_distribution_arn" {
  description = "ARN of the CloudFront distribution allowed to read this bucket via the OAC. Only consulted when cloudfront_oac_enabled = true. May be left empty during the chicken-and-egg phase where the distribution is being created in the same plan; in that case the consumer should pass the ARN once it stabilizes."
  type        = string
  default     = ""
}

variable "lifecycle_rules" {
  description = <<-EOT
    Optional list of S3 lifecycle rules. Each rule:
      - id (string, required): rule identifier; must be unique per bucket.
      - enabled (bool, required): apply or skip this rule.
      - prefix (string, optional, default ""): apply rule only to objects under this prefix. Empty = whole bucket.
      - expiration_days (number, optional): expire current versions after N days. 0 / null = no expiration.
      - noncurrent_version_expiration_days (number, optional): expire noncurrent versions after N days. 0 / null = no noncurrent expiration. Ignored when versioning_enabled = false.
      - transitions (list(object), optional): list of { days = number, storage_class = string } entries (e.g. STANDARD_IA, GLACIER_IR, GLACIER, DEEP_ARCHIVE).

    Default empty list. The 'logs' bucket pattern typically uses:
      [{ id = "expire-90d", enabled = true, expiration_days = 90, transitions = [{ days = 30, storage_class = "GLACIER_IR" }] }]
  EOT
  type = list(object({
    id                                 = string
    enabled                            = bool
    prefix                             = optional(string, "")
    expiration_days                    = optional(number)
    noncurrent_version_expiration_days = optional(number)
    transitions = optional(list(object({
      days          = number
      storage_class = string
    })), [])
  }))
  default = []
}

variable "extra_tags" {
  description = "Additional tags merged into the default tag set."
  type        = map(string)
  default     = {}
}
