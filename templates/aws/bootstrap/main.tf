###############################################################################
# strata bootstrap — per-account state backend + GitHub OIDC trust
#
# This module is intentionally small. It creates the prerequisites that every
# *other* Terraform run in the account depends on, and nothing else:
#
#   1. S3 bucket for remote state (versioned, encrypted, public-access blocked)
#   2. DynamoDB lock table for state locking
#   3. GitHub OIDC identity provider (account singleton — guarded by var)
#   4. IAM role `strata-cicd-deploy-role` trusted by the OIDC provider, scoped
#      to mkavalich/strata main-branch (and optional GH environments).
#
# WARNING: AdministratorAccess is attached to the deploy role for the
# scaffold phase. AWS-5.x will replace this with a least-privilege policy
# generated from `iam-policy-simulator` against the actual module surface.
###############################################################################

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  partition = data.aws_partition.current.partition

  state_bucket_name = (
    var.state_bucket_name_override != ""
    ? var.state_bucket_name_override
    : "terraform-state-${var.env_name}-${var.aws_region}"
  )

  default_tags = {
    Project     = "strata"
    Component   = "bootstrap"
    ManagedBy   = "terraform"
    Environment = var.env_name
  }

  tags = merge(local.default_tags, var.extra_tags)

  # GitHub OIDC issuer is fixed.
  github_oidc_url      = "https://token.actions.githubusercontent.com"
  github_oidc_audience = "sts.amazonaws.com"

  # OIDC sub claims we trust. Matches GitHub Actions' documented format:
  #   repo:{owner}/{repo}:ref:refs/heads/{branch}
  #   repo:{owner}/{repo}:environment:{env_name}
  trusted_branch_subs = [
    for b in var.allowed_branches :
    "repo:${var.repo_slug}:ref:refs/heads/${b}"
  ]
  trusted_env_subs = [
    for e in var.allowed_environments :
    "repo:${var.repo_slug}:environment:${e}"
  ]
  all_trusted_subs = concat(local.trusted_branch_subs, local.trusted_env_subs)
}

###############################################################################
# 1. S3 bucket for Terraform state
###############################################################################

resource "aws_s3_bucket" "state" {
  # checkov:skip=CKV_AWS_18:Access logging adds a per-account cyclic dep at bootstrap time; addressed by org-wide logging in AWS-5.1.
  # checkov:skip=CKV2_AWS_61:Lifecycle is configured on noncurrent versions only; current versions are intentionally retained.
  # checkov:skip=CKV2_AWS_62:Event notifications not required for state bucket; CloudTrail covers audit needs.
  # checkov:skip=CKV_AWS_144:Cross-region replication is overkill for a per-account state bucket; restore-from-versioning suffices.
  # checkov:skip=CKV_AWS_145:SSE-S3 chosen over SSE-KMS to avoid a chicken-and-egg KMS bootstrap; AWS-1.x modules use KMS where they own the key.
  bucket        = local.state_bucket_name
  force_destroy = false

  tags = merge(local.tags, {
    Name = local.state_bucket_name
  })
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket = aws_s3_bucket.state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_expiration_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# Belt-and-suspenders: deny any non-TLS access to the state bucket.
data "aws_iam_policy_document" "state_bucket_policy" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]

    resources = [
      aws_s3_bucket.state.arn,
      "${aws_s3_bucket.state.arn}/*",
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
}

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = data.aws_iam_policy_document.state_bucket_policy.json
}

###############################################################################
# 2. DynamoDB lock table
###############################################################################

resource "aws_dynamodb_table" "locks" {
  # checkov:skip=CKV_AWS_28:Point-in-time recovery is unnecessary for short-lived lock rows; rebuild on loss.
  # checkov:skip=CKV_AWS_119:Account-managed key is sufficient for an opaque lock-id table.
  name         = var.lock_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  server_side_encryption {
    enabled = true
  }

  tags = merge(local.tags, {
    Name = var.lock_table_name
  })
}

###############################################################################
# 3. GitHub OIDC identity provider (account singleton)
#
# Per AWS docs (Apr 2026), STS no longer pins the cert thumbprint when the
# provider URL is hosted by a well-known IdP — the field is still required by
# the API but is functionally ignored. We pass GitHub's published intermediate
# CA thumbprint so older `aws` CLIs/SDKs that still verify locally don't fail.
# Refs:
#   https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_create_oidc.html
#   https://github.blog/changelog/2023-06-27-github-actions-update-on-oidc-integration-with-aws/
###############################################################################

# Look up an existing provider when the caller asks us not to create one.
# Per-account singleton: only one OIDC provider per (account, issuer URL).
data "aws_iam_openid_connect_provider" "github_existing" {
  count = var.create_oidc_provider ? 0 : 1
  url   = local.github_oidc_url
}

resource "aws_iam_openid_connect_provider" "github" {
  count = var.create_oidc_provider ? 1 : 0

  url            = local.github_oidc_url
  client_id_list = [local.github_oidc_audience]
  thumbprint_list = [
    "6938fd4d98bab03faadb97b34396831e3780aea1",
    "1c58a3a8518e8759bf075b76b750d4f2df264fcd",
  ]

  tags = local.tags
}

locals {
  oidc_provider_arn = (
    var.create_oidc_provider
    ? aws_iam_openid_connect_provider.github[0].arn
    : data.aws_iam_openid_connect_provider.github_existing[0].arn
  )
}

###############################################################################
# 4. IAM role for GitHub Actions
###############################################################################

data "aws_iam_policy_document" "deploy_role_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = [local.github_oidc_audience]
    }

    # Pin to specific branch/environment subjects from this repo only.
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = local.all_trusted_subs
    }
  }
}

resource "aws_iam_role" "deploy" {
  name               = var.deploy_role_name
  assume_role_policy = data.aws_iam_policy_document.deploy_role_assume.json
  description        = "Assumed by GitHub Actions (mkavalich/strata) via OIDC for Terraform deploys in ${var.env_name}."

  tags = local.tags
}

resource "aws_iam_role_policy_attachment" "deploy_admin" {
  # checkov:skip=CKV_AWS_274:AdministratorAccess is intentional for the scaffold phase. AWS-5.x will replace this with a least-privilege policy. Tracked in plan §AWS-5.1.
  role       = aws_iam_role.deploy.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/AdministratorAccess"
}
