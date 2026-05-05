###############################################################################
# strata s3-bucket — versioned, SSE-KMS encrypted, optional CloudFront OAC
#
# What this module creates (default config):
#   - 1 S3 bucket, default name strata-${purpose}-${account_id}-${env_name}.
#       Account-id suffix is mandatory because S3 bucket names share a single
#       global namespace; without the suffix, two accounts with the same env
#       label would collide on apply.
#   - Versioning enabled (toggle-able for log-style buckets that rotate).
#   - SSE-KMS via a per-bucket CMK created in this module (toggle-able by
#       passing an existing key ARN in var.kms_key_id).
#   - Public access block all-true (4 toggles, no exceptions).
#   - Bucket policy: deny non-TLS (mandatory).
#   - Optional lifecycle rules driven by var.lifecycle_rules.
#   - Optional CloudFront OAC + bucket policy statement when
#       var.cloudfront_oac_enabled = true.
#
# Three callers per design §Storage layout: 'artifacts', 'user-data', 'logs'.
# The 'logs' caller typically passes versioning_enabled = false plus a 90-day
# expiration rule.
###############################################################################

data "aws_caller_identity" "current" {}

locals {
  default_tags = {
    Project     = "strata"
    Component   = "s3-bucket"
    ManagedBy   = "terraform"
    Environment = var.env_name
    Purpose     = var.purpose
    Region      = var.aws_region
  }

  tags = merge(local.default_tags, var.extra_tags)

  bucket_name = var.bucket_name_override != "" ? var.bucket_name_override : "strata-${var.purpose}-${data.aws_caller_identity.current.account_id}-${var.env_name}"

  # KMS resolution: when consumer passed an empty kms_key_id, this module
  # creates a CMK; otherwise we use the consumer's key. The encryption
  # configuration always references local.kms_key_arn.
  module_creates_cmk = var.kms_key_id == ""
  kms_key_arn        = local.module_creates_cmk ? aws_kms_key.this[0].arn : var.kms_key_id
}

###############################################################################
# 1. Optional KMS CMK (created when var.kms_key_id is empty)
###############################################################################

# Key policy: account root has full control; S3 service principal scoped to
# this account can use the key for SSE on objects in this bucket.
#
# Why `kms:*` to the account root with `Resource: *`:
# - This is the AWS-published recommended baseline key policy. Any other
#   shape risks orphaning the key (no principal can update or use it).
# - The `Resource: *` only refers to the key on which the policy is set;
#   key policies cannot reference resources outside themselves.
# - Day-to-day permissions are granted via IAM identity policies, not by
#   loosening this baseline — least privilege is enforced one layer up.
#
# checkov:skip=CKV_AWS_109:`kms:*` to account root is the AWS-recommended baseline key policy; alternative shapes risk orphaning the key. IAM identity policies enforce least privilege one layer up.
# checkov:skip=CKV_AWS_111:Same — write access via `kms:*` is scoped to this single key, not account-wide. Identity policies on principals constrain who can actually invoke.
# checkov:skip=CKV_AWS_356:`Resource: *` in a key policy refers only to this key by AWS spec; key policies cannot reference external resources.
data "aws_iam_policy_document" "kms" {
  count = local.module_creates_cmk ? 1 : 0

  statement {
    sid    = "EnableRootAccountAdmin"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }

    actions   = ["kms:*"]
    resources = ["*"]
  }

  statement {
    sid    = "AllowS3ServiceUseInAccount"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["s3.amazonaws.com"]
    }

    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey",
      "kms:Encrypt",
      "kms:ReEncrypt*",
      "kms:DescribeKey",
    ]
    resources = ["*"]

    # Only S3 calls originating from this account can wield the key.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_kms_key" "this" {
  count = local.module_creates_cmk ? 1 : 0

  description             = "SSE-KMS CMK for s3 bucket '${local.bucket_name}' (purpose=${var.purpose}, env=${var.env_name})."
  deletion_window_in_days = 7
  enable_key_rotation     = true

  policy = data.aws_iam_policy_document.kms[0].json

  tags = local.tags
}

resource "aws_kms_alias" "this" {
  count = local.module_creates_cmk ? 1 : 0

  name          = "alias/strata-${var.purpose}-${var.env_name}"
  target_key_id = aws_kms_key.this[0].key_id
}

###############################################################################
# 2. The S3 bucket
###############################################################################

resource "aws_s3_bucket" "this" {
  # checkov:skip=CKV_AWS_144:Cross-region replication is intentionally not configured at the module level. The 'user-data' caller will add a Litestream-style replication target in v2; 'logs' and 'artifacts' don't need it. Adding CRR here would force every caller to provision a replica role and destination bucket they don't need.
  # checkov:skip=CKV2_AWS_61:Lifecycle is opt-in via var.lifecycle_rules. Default empty is correct for buckets like 'user-data' where retention is controlled by the application. (An always-on abort-incomplete-multipart-uploads rule is configured separately.)
  # checkov:skip=CKV2_AWS_62:Event notifications are caller-owned. Some callers wire SQS/SNS/EventBridge; baking a default here would conflict with those.
  # checkov:skip=CKV_AWS_18:Access logging is caller-owned and would create a circular reference for the 'logs' bucket itself. Callers wire `aws_s3_bucket_logging` against `strata-logs-*` when they want it; baking a default target here would force every consumer to also provision the logs bucket up front.
  bucket = local.bucket_name

  # Object Ownership: BucketOwnerEnforced disables ACLs entirely — the
  # bucket-owner identity owns every object. This is the AWS-recommended
  # default and avoids the legacy ACL surface.
  object_lock_enabled = false

  tags = merge(local.tags, {
    Name = local.bucket_name
  })
}

resource "aws_s3_bucket_ownership_controls" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

###############################################################################
# 3. Versioning
###############################################################################

resource "aws_s3_bucket_versioning" "this" {
  bucket = aws_s3_bucket.this.id

  versioning_configuration {
    # 'Enabled' or 'Suspended' — never 'Disabled' once a bucket has had
    # versioning on. New buckets safely accept either.
    status = var.versioning_enabled ? "Enabled" : "Suspended"
  }
}

###############################################################################
# 4. Server-side encryption (SSE-KMS) with bucket-key optimization
###############################################################################

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = local.kms_key_arn
    }

    # Bucket Key reduces KMS API calls (and thus cost) by ~99% by caching
    # data keys at the bucket level. No durability/security trade-off.
    bucket_key_enabled = true
  }
}

###############################################################################
# 5. Public access block — all four toggles on
###############################################################################

resource "aws_s3_bucket_public_access_block" "this" {
  bucket = aws_s3_bucket.this.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

###############################################################################
# 6. CloudFront OAC (optional)
###############################################################################

resource "aws_cloudfront_origin_access_control" "this" {
  count = var.cloudfront_oac_enabled ? 1 : 0

  name                              = "${local.bucket_name}-oac"
  description                       = "Origin Access Control for s3 bucket '${local.bucket_name}'."
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

###############################################################################
# 7. Bucket policy — deny non-TLS (mandatory) + optional CloudFront OAC allow
###############################################################################

data "aws_iam_policy_document" "bucket" {
  # 7a. Mandatory: deny any request that isn't on TLS.
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.this.arn,
      "${aws_s3_bucket.this.arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  # 7b. Optional: allow CloudFront's service principal to GetObject when this
  # bucket is fronted by an OAC-equipped distribution. Scoped via SourceArn
  # to the specific distribution when the consumer supplies the ARN.
  dynamic "statement" {
    for_each = var.cloudfront_oac_enabled ? [1] : []
    content {
      sid     = "AllowCloudFrontServicePrincipalReadOnly"
      effect  = "Allow"
      actions = ["s3:GetObject"]
      resources = [
        "${aws_s3_bucket.this.arn}/*",
      ]

      principals {
        type        = "Service"
        identifiers = ["cloudfront.amazonaws.com"]
      }

      # When the consumer provides a distribution ARN, scope tightly. When
      # they don't (chicken-and-egg during initial deploy), fall back to
      # account-scoped — still safe because CloudFront only ever assumes the
      # role on behalf of distributions in this account, but the consumer
      # SHOULD pass the ARN once stable.
      dynamic "condition" {
        for_each = var.cloudfront_distribution_arn != "" ? [1] : []
        content {
          test     = "StringEquals"
          variable = "AWS:SourceArn"
          values   = [var.cloudfront_distribution_arn]
        }
      }

      dynamic "condition" {
        for_each = var.cloudfront_distribution_arn == "" ? [1] : []
        content {
          test     = "StringEquals"
          variable = "AWS:SourceAccount"
          values   = [data.aws_caller_identity.current.account_id]
        }
      }
    }
  }
}

resource "aws_s3_bucket_policy" "this" {
  bucket = aws_s3_bucket.this.id
  policy = data.aws_iam_policy_document.bucket.json

  # The public access block must be in place before a bucket policy is
  # evaluated, so AWS doesn't transiently flag the policy as "potentially
  # public" during the apply.
  depends_on = [aws_s3_bucket_public_access_block.this]
}

###############################################################################
# 8. Lifecycle rules (optional)
###############################################################################

resource "aws_s3_bucket_lifecycle_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  # 8a. Always-on rule: abort multipart uploads that have been incomplete for
  # 7 days. No security trade-off — these are orphaned uploads that nobody
  # will ever finish. Saves storage cost and clears Checkov CKV_AWS_300.
  rule {
    id     = "abort-incomplete-multipart-uploads"
    status = "Enabled"

    filter {
      prefix = ""
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  # 8b. Caller-supplied rules (if any).
  dynamic "rule" {
    for_each = var.lifecycle_rules
    content {
      id     = rule.value.id
      status = rule.value.enabled ? "Enabled" : "Disabled"

      # AWS requires a `filter` block on every rule. Empty prefix == whole
      # bucket; non-empty prefix scopes to a key prefix.
      filter {
        prefix = rule.value.prefix
      }

      dynamic "expiration" {
        for_each = rule.value.expiration_days != null && rule.value.expiration_days > 0 ? [rule.value.expiration_days] : []
        content {
          days = expiration.value
        }
      }

      dynamic "noncurrent_version_expiration" {
        for_each = rule.value.noncurrent_version_expiration_days != null && rule.value.noncurrent_version_expiration_days > 0 ? [rule.value.noncurrent_version_expiration_days] : []
        content {
          noncurrent_days = noncurrent_version_expiration.value
        }
      }

      dynamic "transition" {
        for_each = rule.value.transitions
        content {
          days          = transition.value.days
          storage_class = transition.value.storage_class
        }
      }
    }
  }

  # Lifecycle config can't be applied before versioning is configured, since
  # noncurrent rules implicitly reference versioning state.
  depends_on = [aws_s3_bucket_versioning.this]
}
