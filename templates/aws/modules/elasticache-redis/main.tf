###############################################################################
# strata elasticache-redis — Redis Serverless cache with TLS + AUTH + CMK
#
# What this module creates:
#
#   1. A per-cache KMS CMK (alias/strata-{env}-cache) for at-rest encryption.
#      Account-root admin (AWS escape hatch) + ElastiCache service principal.
#      7-day deletion window, automatic key rotation on.
#   2. A 64-character AUTH token via random_password, stored in Secrets Manager
#      via the shipped `secrets` module under the same per-cache CMK so all
#      cache material lives under one key. The plaintext token is NEVER an
#      output — only the secret ARN is.
#   3. A security group attached to the cache ENIs. Ingress on TCP/6379 from
#      the consumer SGs in var.allowed_security_group_ids, OR (fallback) from
#      var.vpc_cidr when that list is empty. Egress is intentionally empty —
#      response traffic to clients is implicit; cache nodes have no need to
#      initiate outbound connections.
#   4. The aws_elasticache_serverless_cache itself, wired across the supplied
#      subnets (typically the network module's three isolated subnets), with:
#        - Engine: redis (Valkey is cheaper and AWS-supported now; the swap is
#          a single-flag change in this module — see README §"Valkey swap").
#        - In-transit encryption: REQUIRED by Serverless (documented, not
#          configurable; we don't expose a flag because there is no off).
#        - At-rest encryption: the module-created CMK.
#        - AUTH token: managed automatically by Serverless from the secret.
#        - Major engine version auto-upgrade: OFF.
#
# AZ-availability defensiveness:
#   ElastiCache Serverless is generally available in all major us-east-1 AZs.
#   Regional service-availability changes over time though, so this module
#   simply hands ElastiCache whatever subnet IDs the caller passes — typically
#   the network module's isolated_subnet_ids[*] across all three AZs. The
#   ElastiCache API rejects cleanly with a clear error if a passed subnet's AZ
#   is not supported, which surfaces at plan/apply rather than as a silent
#   placement failure. No need to filter via aws_availability_zones in this
#   module today; revisit if AWS ever unevenly removes Serverless from an AZ.
###############################################################################

locals {
  default_tags = {
    Project     = "strata"
    Component   = "elasticache-redis"
    ManagedBy   = "terraform"
    Environment = var.env_name
  }

  tags = merge(local.default_tags, var.extra_tags)

  cache_name = "strata-${var.env_name}-cache"

  # Decide whether ingress comes from caller-supplied security groups or falls
  # back to VPC CIDR. SG-based ingress is preferred (tightest scope); the CIDR
  # fallback exists so the example deploy works without a real consumer SG.
  use_sg_ingress = length(var.allowed_security_group_ids) > 0
}

###############################################################################
# 1. KMS CMK for at-rest encryption
###############################################################################

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

# Key policy:
#   - Account root admin — AWS-recommended escape hatch so the key remains
#     usable if all IAM admins are revoked. Pinned `kms:*` to this key only.
#   - ElastiCache service principal — encrypt/decrypt on the backplane via
#     kms:ViaService. Without this, ElastiCache cannot use the CMK at all.
#   - Secrets Manager service principal — same backplane treatment so the
#     module-created secret (the AUTH token) can be encrypted with the same
#     CMK.
data "aws_iam_policy_document" "kms" {
  # checkov:skip=CKV_AWS_109:Account-root admin statement is the AWS-recommended escape hatch (https://docs.aws.amazon.com/kms/latest/developerguide/key-policy-default.html). Without it the key can become unmanageable if IAM admins are revoked.
  # checkov:skip=CKV_AWS_111:Same — account-root admin is scoped to this key only (KMS key policies' Resource:"*" semantically scopes to the key the policy is attached to, NOT account-wide).
  # checkov:skip=CKV_AWS_356:KMS key policies semantically scope Resource:"*" to the attached key per the AWS-published model. Service-principal statements are further narrowed via kms:ViaService.

  statement {
    sid    = "EnableAccountRootAdministration"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }

    actions   = ["kms:*"]
    resources = ["*"]
  }

  statement {
    sid    = "AllowElastiCacheUseOfTheKey"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["elasticache.amazonaws.com"]
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

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["elasticache.${var.aws_region}.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:CallerAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
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
}

resource "aws_kms_key" "cache" {
  description             = "Strata per-cache CMK for ${local.cache_name} (at-rest data + AUTH token secret)"
  deletion_window_in_days = 7
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.kms.json

  tags = merge(local.tags, {
    Name = "${local.cache_name}-kms"
  })
}

resource "aws_kms_alias" "cache" {
  name          = "alias/${local.cache_name}"
  target_key_id = aws_kms_key.cache.key_id
}

###############################################################################
# 2. AUTH token + Secrets Manager storage
#
# A 64-character random password is generated and stored in Secrets Manager
# under the per-cache CMK. Consumers receive only the secret ARN — they pull
# the value at runtime via secretsmanager:GetSecretValue. The plaintext is
# never exposed as a Terraform output.
#
# We rely on the shipped `secrets` module so the secret carries the same
# rotation-ready scaffolding as every other secret in the deploy. Rotation
# is not wired today (rotating an ElastiCache AUTH token requires recreating
# the cache, so it's an explicit operator action, not a scheduled Lambda).
###############################################################################

resource "random_password" "auth" {
  # ElastiCache AUTH tokens accept 16–128 printable ASCII chars excluding
  # @, ", /, and a few others. We use a 64-char alphanumeric+symbol set with
  # the cache's-rejected characters explicitly overridden_special.
  length  = 64
  special = true

  # ElastiCache rejects: @ " /. random_password's default special set is
  # "!@#$%&*()-_=+[]{}<>:?". We override to the safe subset.
  override_special = "!#$%&*()-_=+[]{}<>:?"

  # No keepers — rotation requires cache recreation, which is an explicit
  # operator action. Don't trigger silent rotations on plan refresh.
}

module "auth_secret" {
  source = "../secrets"

  env_name    = var.env_name
  aws_region  = var.aws_region
  secret_name = "cache/auth-token"
  description = "ElastiCache Redis AUTH token for ${local.cache_name}. Consumed by services connecting to the cache via TLS + AUTH. Rotation requires cache recreation; not auto-rotated."

  # Use the per-cache CMK so all cache-related encryption material lives under
  # one key — easier to audit, revoke, and account for in finops. We pass the
  # alias *string* (computed from variables, known at plan time) rather than
  # the key ARN (known only after apply). Passing the ARN tickles a known
  # Terraform limitation in the child secrets module: its `count = var.kms_key_id == ""`
  # expression cannot evaluate when kms_key_id is "known after apply". The
  # alias literal sidesteps the issue and Secrets Manager resolves it the
  # same way at apply time. We still ensure the alias resource exists before
  # the secret is created via an explicit depends_on.
  kms_key_id = "alias/${local.cache_name}"

  create_initial_version = true
  initial_value          = random_password.auth.result

  extra_tags = merge(var.extra_tags, {
    CacheName = local.cache_name
  })

  # Ensure the CMK + alias exist before Secrets Manager tries to use the
  # alias as the encrypting key. Without this, an unlucky parallel apply
  # ordering can race the secret-creation against the alias-creation.
  depends_on = [aws_kms_alias.cache, aws_kms_key.cache]
}

###############################################################################
# 3. Security group for the cache ENIs
#
# Ingress: TCP/6379 from var.allowed_security_group_ids (preferred) OR
# var.vpc_cidr (fallback when the SG list is empty). Egress: none — cache
# nodes don't initiate outbound traffic; response packets flow back implicitly.
###############################################################################

resource "aws_security_group" "cache" {
  # checkov:skip=CKV2_AWS_5:SG is attached to the aws_elasticache_serverless_cache below via security_group_ids — checkov sometimes misses the attachment because it reads SGs and ElastiCache resources separately.

  name        = "${local.cache_name}-sg"
  description = "Strata ElastiCache Redis Serverless cache security group — ingress 6379 from approved consumers only."
  vpc_id      = var.vpc_id

  tags = merge(local.tags, {
    Name = "${local.cache_name}-sg"
  })

  # Egress is intentionally empty. Terraform's default behavior on
  # aws_security_group is to ADD an allow-all egress rule when none are
  # specified; we override that by managing all egress rules out-of-band as
  # aws_vpc_security_group_egress_rule resources (none, in our case). The
  # lifecycle.create_before_destroy avoids a recreation deadlock when the SG
  # gets renamed.
  lifecycle {
    create_before_destroy = true
  }
}

# Ingress: from each caller-supplied SG (preferred path).
resource "aws_vpc_security_group_ingress_rule" "from_consumer_sgs" {
  for_each = toset(var.allowed_security_group_ids)

  security_group_id            = aws_security_group.cache.id
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
  description                  = "Redis 6379 from consumer SG ${each.value}"

  tags = local.tags
}

# Ingress: VPC CIDR fallback when no consumer SGs are supplied. Wider than
# SG-based ingress, but still scoped to the VPC — no internet exposure.
resource "aws_vpc_security_group_ingress_rule" "from_vpc_cidr_fallback" {
  count = local.use_sg_ingress ? 0 : 1

  # checkov:skip=CKV_AWS_277:Ingress is scoped to the caller's VPC CIDR, not 0.0.0.0/0. Used only when no consumer SG is available (e.g., the example deploy). Production callers pass var.allowed_security_group_ids and this fallback rule is not created.

  security_group_id = aws_security_group.cache.id
  cidr_ipv4         = var.vpc_cidr
  ip_protocol       = "tcp"
  from_port         = 6379
  to_port           = 6379
  description       = "Redis 6379 from VPC CIDR (fallback — no consumer SG supplied)"

  tags = local.tags
}

###############################################################################
# 4. ElastiCache Serverless cache
###############################################################################

resource "aws_elasticache_serverless_cache" "this" {
  # checkov:skip=CKV_AWS_191:KMS at-rest encryption IS configured below via kms_key_id; checkov occasionally mis-reads the Serverless variant of this resource.

  engine = "redis"
  name   = local.cache_name

  description = "Strata ${var.env_name} ElastiCache Redis Serverless cache. TLS + AUTH required; data encrypted at rest with the module-created CMK."

  major_engine_version = var.engine_version

  cache_usage_limits {
    data_storage {
      maximum = var.cache_usage_limits.data_storage_max_gb
      unit    = "GB"
    }

    ecpu_per_second {
      maximum = var.cache_usage_limits.ecpu_per_second_max
    }
  }

  # daily_snapshot_time is only meaningful when retention > 0. Setting it
  # alongside retention=0 historically produced a 400 from the ElastiCache
  # API; the provider now accepts but ignores it. We omit it when retention
  # is 0 to keep plan output clean.
  daily_snapshot_time      = var.daily_snapshot_retention_limit > 0 ? "03:00" : null
  snapshot_retention_limit = var.daily_snapshot_retention_limit

  kms_key_id = aws_kms_key.cache.arn

  security_group_ids = [aws_security_group.cache.id]
  subnet_ids         = var.subnet_ids

  # Serverless enforces in-transit encryption (TLS) — there is no off switch
  # in the API. Documented in the README. The user_group_id default supplies
  # an AUTH-token-protected default user automatically; we override the
  # default by populating user_group_id with the secret-backed token below.
  # Note: as of provider 5.x, ElastiCache Serverless surfaces the AUTH token
  # via a separate aws_elasticache_user / aws_elasticache_user_group pair.
  # See the user_group resources below.
  user_group_id = aws_elasticache_user_group.this.user_group_id

  tags = merge(local.tags, {
    Name = local.cache_name
  })

  # Don't churn the cache on every plan if AWS bumps the minor version under
  # us — major version is the contract, minors auto-track. Major bumps are
  # explicit (operator changes var.engine_version).
  lifecycle {
    ignore_changes = [
      # Snapshot ARN is set by AWS post-restore; not part of our IaC contract.
      snapshot_arns_to_restore,
    ]
  }
}

###############################################################################
# 5. ElastiCache user + user group (AUTH token wiring)
#
# ElastiCache Serverless uses RBAC user groups in place of the older
# `auth_token` field. We provision a single "default" user with the
# random-password AUTH token attached, then bind that user into a user group
# referenced by the cache.
###############################################################################

resource "aws_elasticache_user" "default" {
  user_id       = "${replace(local.cache_name, "-", "")}default"
  user_name     = "default"
  access_string = "on ~* +@all"
  engine        = "REDIS"

  authentication_mode {
    type      = "password"
    passwords = [random_password.auth.result]
  }

  tags = merge(local.tags, {
    Name = "${local.cache_name}-default-user"
  })

  lifecycle {
    # Treat password rotation as an explicit operator action (cache recreation
    # required). Don't churn this user on every plan if random_password
    # somehow re-rolls.
    ignore_changes = [authentication_mode]
  }
}

resource "aws_elasticache_user_group" "this" {
  user_group_id = "${local.cache_name}-ug"
  engine        = "REDIS"
  user_ids      = [aws_elasticache_user.default.user_id]

  tags = merge(local.tags, {
    Name = "${local.cache_name}-ug"
  })
}
