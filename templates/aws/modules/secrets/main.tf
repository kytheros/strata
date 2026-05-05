###############################################################################
# strata secrets — Secrets Manager wrapper with rotation + per-secret CMK
#
# What this module does:
#
#   1. Creates an `aws_secretsmanager_secret` at path `strata/{env}/{name}`.
#   2. Encrypts it with a KMS key. Default: a module-created per-secret CMK
#      with rotation enabled. Override via var.kms_key_id to share an existing
#      CMK across many secrets (one-CMK-per-service is a reasonable middle
#      ground between per-secret and account-default).
#   3. Optionally seeds the initial AWSCURRENT version (var.create_initial_version)
#      — used for bootstrap secrets. Aurora-style auto-generated passwords
#      skip this and let the rotation Lambda write the first value.
#   4. Optionally attaches a rotation Lambda (var.rotation_lambda_arn) and
#      grants it least-privilege access to *this specific secret only*.
#   5. Emits a least-privilege IAM policy JSON (output) that consumer task
#      roles attach to gain `GetSecretValue` on this secret's ARN — and
#      nothing else.
#
# Per-secret CMK rationale:
#   - Tighter blast radius than the account-default `aws/secretsmanager` key.
#   - Key policy is auditable per-secret, not shared.
#   - The cost (~$1/CMK/mo) is acceptable for the small number of secrets a
#     Strata deploy holds (~5–10 per env). For high-fanout cases pass
#     var.kms_key_id and share an existing key.
###############################################################################

locals {
  default_tags = {
    Project     = "strata"
    Component   = "secrets"
    ManagedBy   = "terraform"
    Environment = var.env_name
    SecretName  = var.secret_name
  }

  tags = merge(local.default_tags, var.extra_tags)

  # Path-style identifier. Hierarchical names let consumers `aws secretsmanager
  # list-secrets --filter Key=name,Values=strata/dev/` to scope to an env.
  full_secret_name = "strata/${var.env_name}/${var.secret_name}"

  # When the caller supplies a KMS key, use it directly. Otherwise fall back
  # to the module-created CMK (its ARN is computed below). The chained
  # coalesce/try keeps the expression valid even when the CMK isn't created.
  create_cmk        = var.kms_key_id == ""
  effective_kms_arn = local.create_cmk ? aws_kms_key.this[0].arn : var.kms_key_id

  rotation_enabled = var.rotation_lambda_arn != ""
}

###############################################################################
# 1. KMS CMK (created only when caller did not supply one)
###############################################################################

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

# Key policy:
#   - Account root may administer the key (the AWS-recommended escape hatch
#     so the key remains usable if all IAM admins are revoked). Pinned to
#     `kms:*` on `Resource: "this key"`, NOT `Resource: "*"`.
#   - The Secrets Manager service principal may use the key to encrypt /
#     decrypt secret material it owns, scoped via `kms:ViaService`.
#   - Optional rotation Lambda principal gets Decrypt + GenerateDataKey so
#     it can read the current value during rotation. Only granted when
#     rotation is configured.
data "aws_iam_policy_document" "kms" {
  count = local.create_cmk ? 1 : 0

  # checkov:skip=CKV_AWS_109:Account-root admin statement is intentional and AWS-recommended (https://docs.aws.amazon.com/kms/latest/developerguide/key-policy-default.html). Without it, a key can become unmanageable if IAM admins are revoked.
  # checkov:skip=CKV_AWS_111:Same — the account-root statement is the AWS escape hatch and is scoped to this key only (not Resource:"*" account-wide).
  # checkov:skip=CKV_AWS_356:KMS key policies semantically scope `Resource: "*"` to the key the policy is attached to (AWS-published model — https://docs.aws.amazon.com/kms/latest/developerguide/key-policies.html). It is NOT account-wide. Statements are further scoped via `kms:ViaService` to the Secrets Manager backplane.

  statement {
    sid    = "EnableAccountRootAdministration"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }

    # `Resource` is implicit on a KMS key policy — it always refers to the
    # key the policy is attached to. We cannot specify a different ARN here.
    # The point of this comment is to make explicit that this is NOT
    # `Resource: "*"` in the cross-key sense — it's scoped to this CMK alone.
    actions   = ["kms:*"]
    resources = ["*"]
  }

  statement {
    sid    = "AllowSecretsManagerUseOfTheKey"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["secretsmanager.amazonaws.com"]
    }

    actions = [
      "kms:Decrypt",
      "kms:Encrypt",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey*",
      "kms:DescribeKey",
      "kms:CreateGrant",
    ]

    resources = ["*"]

    # Limit Secrets Manager's use of the key to calls made on behalf of
    # Secrets Manager itself, in this account.
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${var.aws_region}.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:CallerAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }

  # Rotation Lambda needs to decrypt the current value during rotation steps.
  # Only emitted when rotation is configured. Granting Decrypt is the minimum
  # required by the AWS-published rotation function template.
  dynamic "statement" {
    for_each = local.rotation_enabled ? [1] : []
    content {
      sid    = "AllowRotationLambdaToDecryptAndGenerateDataKey"
      effect = "Allow"

      principals {
        type        = "AWS"
        identifiers = [var.rotation_lambda_arn]
      }

      actions = [
        "kms:Decrypt",
        "kms:GenerateDataKey",
      ]

      resources = ["*"]

      condition {
        test     = "StringEquals"
        variable = "kms:ViaService"
        values   = ["secretsmanager.${var.aws_region}.amazonaws.com"]
      }
    }
  }
}

resource "aws_kms_key" "this" {
  count = local.create_cmk ? 1 : 0

  description             = "Strata per-secret CMK for ${local.full_secret_name}"
  deletion_window_in_days = 7
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.kms[0].json

  tags = merge(local.tags, {
    Name = "strata-${var.env_name}-${replace(var.secret_name, "/", "-")}-kms"
  })
}

resource "aws_kms_alias" "this" {
  count = local.create_cmk ? 1 : 0

  name          = "alias/strata-secret-${var.env_name}-${replace(var.secret_name, "/", "-")}"
  target_key_id = aws_kms_key.this[0].key_id
}

###############################################################################
# 2. Secrets Manager secret
###############################################################################

resource "aws_secretsmanager_secret" "this" {
  name        = local.full_secret_name
  description = var.description
  kms_key_id  = local.effective_kms_arn

  recovery_window_in_days = var.recovery_window_days

  tags = merge(local.tags, {
    Name = local.full_secret_name
  })
}

###############################################################################
# 3. Initial secret version (optional)
#
# Only created when var.create_initial_version = true. The secret_string is
# marked sensitive at the variable level, so it does not appear in plan output.
# Rotation Lambdas overwrite this on their first invocation; for non-rotated
# bootstrap secrets, the initial version is the canonical value.
###############################################################################

resource "aws_secretsmanager_secret_version" "initial" {
  count = var.create_initial_version ? 1 : 0

  secret_id     = aws_secretsmanager_secret.this.id
  secret_string = var.initial_value

  # If a rotation Lambda overwrites the value later, we don't want subsequent
  # `terraform apply` runs to fight the Lambda by re-asserting the initial
  # value. lifecycle.ignore_changes pins our intent to "set this once".
  lifecycle {
    ignore_changes = [secret_string, version_stages]
  }
}

###############################################################################
# 4. Rotation configuration (optional)
###############################################################################

resource "aws_secretsmanager_secret_rotation" "this" {
  count = local.rotation_enabled ? 1 : 0

  secret_id           = aws_secretsmanager_secret.this.id
  rotation_lambda_arn = var.rotation_lambda_arn

  rotation_rules {
    automatically_after_days = var.rotation_days
  }
}

# Permission for Secrets Manager to invoke the rotation Lambda. Without this,
# rotation triggers but the Lambda's resource-policy denies the invocation.
# The statement_id is unique per secret to avoid collisions when one Lambda
# rotates many secrets.
resource "aws_lambda_permission" "rotation_invoke" {
  count = local.rotation_enabled ? 1 : 0

  statement_id  = "AllowSecretsManagerInvoke-${replace(local.full_secret_name, "/", "-")}"
  action        = "lambda:InvokeFunction"
  function_name = var.rotation_lambda_arn
  principal     = "secretsmanager.amazonaws.com"
  source_arn    = aws_secretsmanager_secret.this.arn
}

###############################################################################
# 5. IAM grant for the rotation Lambda's exec role
#
# The rotation Lambda's exec role needs read/write access to *this* secret to
# walk the AWSCURRENT/AWSPENDING/AWSPREVIOUS staging dance. We attach a
# resource-based policy on the secret that grants exactly those four actions
# to whatever principal the rotation Lambda runs as.
#
# We discover the Lambda's role ARN at plan time via aws_lambda_function data
# source so the consumer doesn't have to thread it through.
###############################################################################

data "aws_lambda_function" "rotator" {
  count = local.rotation_enabled ? 1 : 0

  function_name = var.rotation_lambda_arn
}

data "aws_iam_policy_document" "rotation_grant" {
  count = local.rotation_enabled ? 1 : 0

  statement {
    sid    = "AllowRotationLambdaRoleToManageSecretVersions"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = [data.aws_lambda_function.rotator[0].role]
    }

    actions = [
      "secretsmanager:DescribeSecret",
      "secretsmanager:GetSecretValue",
      "secretsmanager:PutSecretValue",
      "secretsmanager:UpdateSecretVersionStage",
    ]

    resources = [aws_secretsmanager_secret.this.arn]
  }
}

resource "aws_secretsmanager_secret_policy" "rotation" {
  count = local.rotation_enabled ? 1 : 0

  secret_arn = aws_secretsmanager_secret.this.arn
  policy     = data.aws_iam_policy_document.rotation_grant[0].json
}

###############################################################################
# 6. Consumer IAM policy template (output only — not a resource)
#
# Consumers (ECS task roles, Lambda exec roles) attach this JSON as an inline
# or managed policy. It grants exactly `GetSecretValue` on this secret's ARN
# and KMS Decrypt on the encrypting key. Nothing else.
#
# We assemble it as a data source so the JSON is rendered with the real ARNs
# at apply time, then expose it via outputs.tf.
###############################################################################

data "aws_iam_policy_document" "consumer" {
  statement {
    sid       = "ReadThisSecret"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.this.arn]
  }

  statement {
    sid       = "DecryptWithSecretCmk"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [local.effective_kms_arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${var.aws_region}.amazonaws.com"]
    }
  }
}
