###############################################################################
# strata aurora-postgres - Aurora Serverless v2 Postgres + RDS Proxy + CMK
#
# What this module creates:
#
#   1. A per-cluster KMS CMK (alias/strata-{env}-aurora) for storage encryption,
#      Performance Insights, and the auto-managed master credential secret.
#      Account-root admin (escape hatch) + RDS service principal + Secrets
#      Manager service principal. 7-day deletion window, key rotation on.
#   2. A DB subnet group across var.subnet_ids - typically the network module's
#      three isolated subnets, so the cluster has no internet path.
#   3. A security group for the cluster ENIs. Ingress on TCP/5432 from
#      var.allowed_security_group_ids (preferred), or var.vpc_cidr (fallback
#      when the SG list is empty). Egress is intentionally empty - Aurora
#      ENIs do not initiate outbound traffic; response packets flow back
#      implicitly.
#   4. A DB cluster parameter group preloading pg_stat_statements. The actual
#      `CREATE EXTENSION pg_stat_statements;` runs at first connect - the
#      module wires the GUC, not the SQL.
#   5. The aws_rds_cluster (Aurora PostgreSQL Serverless v2) with:
#        - Engine 15.x (var.engine_version), engine_mode = "provisioned" (the
#          required mode for Serverless v2 - engine_mode "serverless" is the
#          older v1 path).
#        - serverlessv2_scaling_configuration: min/max ACU + auto-pause.
#          Provider 5.92+ (Feb 2025) supports min_capacity = 0 with
#          seconds_until_auto_pause; this module defaults to that combination
#          for dev.
#        - manage_master_user_password = true - AWS auto-generates and rotates
#          the master credential in Secrets Manager. No rotation Lambda
#          required (the historical pattern); see lambdas/rotation/README.md
#          for the rationale.
#        - Storage encryption with the module-created CMK.
#        - Performance Insights enabled, 7-day retention (free tier).
#        - CloudWatch log export: ["postgresql"].
#        - Backup retention from var.backup_retention_period.
#   6. var.instance_count cluster instances (db.serverless class). At least 1;
#      production should run 2+ for HA promotion path on AZ failure.
#   7. RDS Proxy in front of the cluster:
#        - Engine family POSTGRESQL.
#        - Auth via Secrets Manager (the auto-managed master credential).
#        - TLS required.
#        - Idle client timeout from var.proxy_idle_client_timeout.
#        - Default target group with connection-pool config from
#          var.proxy_max_connections_percent.
#
# Why no rotation Lambda:
#   The plan ticket (AWS-1.4) called for a 30-day rotation Lambda. The
#   manage_master_user_password = true path was added in late 2023 and
#   handles rotation natively without a Lambda - AWS rotates the master
#   credential on the schedule it controls. We choose this path for v1
#   because (a) one fewer Lambda to maintain, (b) the rotated credential
#   stays inside AWS - no Terraform state churn, and (c) RDS Proxy reads
#   the new value transparently on next connection without app-side reload.
#
#   If a future spec demands operator-controlled rotation cadence or
#   custom rotation logic, switch to passing a `secrets`-module-managed
#   credential via aws_rds_cluster.master_password_wo + master_user_secret.
#   The module structure leaves room for that swap.
###############################################################################

locals {
  default_tags = {
    Project     = "strata"
    Component   = "aurora-postgres"
    ManagedBy   = "terraform"
    Environment = var.env_name
  }

  tags = merge(local.default_tags, var.extra_tags)

  cluster_name = "strata-${var.env_name}"

  # Decide whether ingress comes from caller-supplied security groups or falls
  # back to VPC CIDR. SG-based ingress is preferred; CIDR fallback exists so
  # the example deploy works without a real consumer SG.
  use_sg_ingress = length(var.allowed_security_group_ids) > 0

  # The auto-managed master credential secret only exists when min_capacity > 0
  # at apply time AND manage_master_user_password = true (always, here). The
  # cluster always emits master_user_secret on apply.
  engine_major_version = split(".", var.engine_version)[0]

  # Auto-pause is only a meaningful Serverless v2 setting when min_capacity = 0.
  # Provider 5.92+ ignores the field when min_capacity > 0; we still gate it
  # locally to keep the resource shape stable and plan output explicit.
  auto_pause_active = var.min_capacity == 0 && var.seconds_until_auto_pause != null
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

###############################################################################
# 1. KMS CMK for storage encryption, Performance Insights, and the master
#    credential secret.
#
# Key policy:
#   - Account root admin - AWS-recommended escape hatch so the key remains
#     usable if all IAM admins are revoked. Pinned `kms:*` to this key only.
#   - RDS service principal - encrypt/decrypt cluster storage + Performance
#     Insights + automated backups via kms:ViaService = rds.{region}.amazonaws.com.
#   - Secrets Manager service principal - encrypt the auto-managed master
#     credential secret via kms:ViaService = secretsmanager.{region}.amazonaws.com.
#
# RDS Proxy reads the master credential from Secrets Manager via its own
# IAM role (created by the proxy resource), not via the KMS service principal.
# It re-uses the Secrets Manager service principal's existing decrypt grant
# transparently - no extra principal needed in this policy.
###############################################################################

data "aws_iam_policy_document" "kms" {
  # checkov:skip=CKV_AWS_109:Account-root admin statement is the AWS-recommended escape hatch (https://docs.aws.amazon.com/kms/latest/developerguide/key-policy-default.html). Without it the key can become unmanageable if IAM admins are revoked.
  # checkov:skip=CKV_AWS_111:Same - account-root admin is scoped to this key only (KMS key policies' Resource:"*" semantically scopes to the key the policy is attached to, NOT account-wide).
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
    sid    = "AllowRDSUseOfTheKey"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["rds.amazonaws.com"]
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
      values   = ["rds.${var.aws_region}.amazonaws.com"]
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

resource "aws_kms_key" "aurora" {
  description             = "Strata per-cluster CMK for ${local.cluster_name} (storage + Performance Insights + master credential secret)"
  deletion_window_in_days = 7
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.kms.json

  tags = merge(local.tags, {
    Name = "${local.cluster_name}-aurora-kms"
  })
}

resource "aws_kms_alias" "aurora" {
  name          = "alias/${local.cluster_name}-aurora"
  target_key_id = aws_kms_key.aurora.key_id
}

###############################################################################
# 2. DB subnet group across the isolated subnets.
###############################################################################

resource "aws_db_subnet_group" "aurora" {
  name        = "${local.cluster_name}-subnets"
  description = "Strata Aurora subnet group - isolated subnets only (no internet path)."
  subnet_ids  = var.subnet_ids

  tags = merge(local.tags, {
    Name = "${local.cluster_name}-subnets"
  })
}

###############################################################################
# 3. Security group for the cluster ENIs.
#
# Ingress: TCP/5432 from var.allowed_security_group_ids (preferred) OR
# var.vpc_cidr (fallback when the SG list is empty). Egress: none - cluster
# ENIs don't initiate outbound traffic; response packets flow back implicitly.
#
# This SG fronts BOTH the Aurora cluster instances AND the RDS Proxy ENIs.
# The proxy reaches the cluster on the same SG (allowed via self-reference
# below), and consumers reach the proxy on TCP/5432 via the same ingress
# rules.
###############################################################################

resource "aws_security_group" "cluster" {
  # checkov:skip=CKV2_AWS_5:SG is attached to the cluster, instances, and proxy below - checkov sometimes misses the attachment because it reads SGs and RDS resources separately.

  name        = "${local.cluster_name}-sg"
  description = "Strata Aurora cluster + RDS Proxy security group - ingress 5432 from approved consumers + self."
  vpc_id      = var.vpc_id

  tags = merge(local.tags, {
    Name = "${local.cluster_name}-sg"
  })

  # Egress is intentionally empty. We override Terraform's default
  # allow-all egress by managing all egress rules out-of-band as
  # aws_vpc_security_group_egress_rule resources (none). The
  # lifecycle.create_before_destroy avoids a recreation deadlock when the SG
  # gets renamed.
  lifecycle {
    create_before_destroy = true
  }
}

# Ingress: from each caller-supplied SG (preferred path).
resource "aws_vpc_security_group_ingress_rule" "from_consumer_sgs" {
  for_each = toset(var.allowed_security_group_ids)

  security_group_id            = aws_security_group.cluster.id
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "Postgres 5432 from consumer SG ${each.value}"

  tags = local.tags
}

# Self-ingress: RDS Proxy ENIs need to reach cluster ENIs on 5432, and they
# share this SG. Without the self-ingress rule the proxy cannot connect to
# the cluster.
resource "aws_vpc_security_group_ingress_rule" "from_self" {
  security_group_id            = aws_security_group.cluster.id
  referenced_security_group_id = aws_security_group.cluster.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "Postgres 5432 self-ingress (RDS Proxy ENIs reaching cluster ENIs on the same SG)"

  tags = local.tags
}

# Ingress: VPC CIDR fallback when no consumer SGs are supplied.
resource "aws_vpc_security_group_ingress_rule" "from_vpc_cidr_fallback" {
  count = local.use_sg_ingress ? 0 : 1

  # checkov:skip=CKV_AWS_277:Ingress is scoped to the caller's VPC CIDR, not 0.0.0.0/0. Used only when no consumer SG is available (e.g., the example deploy). Production callers pass var.allowed_security_group_ids and this fallback rule is not created.

  security_group_id = aws_security_group.cluster.id
  cidr_ipv4         = var.vpc_cidr
  ip_protocol       = "tcp"
  from_port         = 5432
  to_port           = 5432
  description       = "Postgres 5432 from VPC CIDR (fallback - no consumer SG supplied)"

  tags = local.tags
}

###############################################################################
# 4. DB cluster parameter group - preload pg_stat_statements.
#
# shared_preload_libraries is a "static" Postgres GUC - it requires a cluster
# reboot to take effect. Aurora handles this transparently on first apply
# (the cluster boots with the parameter group already attached). Subsequent
# changes require apply_immediately = true OR a maintenance-window restart.
#
# `CREATE EXTENSION pg_stat_statements;` is NOT run by this module - it
# requires an SQL connection and is a per-database operation. Document this
# in the README so operators run it post-apply.
###############################################################################

resource "aws_rds_cluster_parameter_group" "aurora" {
  name        = "${local.cluster_name}-cluster-pg"
  family      = "aurora-postgresql${local.engine_major_version}"
  description = "Strata Aurora cluster parameter group - pg_stat_statements preloaded."

  parameter {
    name         = "shared_preload_libraries"
    value        = "pg_stat_statements"
    apply_method = "pending-reboot"
  }

  # log_statement = "ddl" captures schema-changes for audit without flooding
  # logs with every SELECT. Tune up to "mod" or "all" only with finops review.
  parameter {
    name         = "log_statement"
    value        = "ddl"
    apply_method = "immediate"
  }

  parameter {
    name         = "log_min_duration_statement"
    value        = "1000"
    apply_method = "immediate"
  }

  tags = merge(local.tags, {
    Name = "${local.cluster_name}-cluster-pg"
  })

  lifecycle {
    create_before_destroy = true
  }
}

###############################################################################
# 5. Aurora cluster - Serverless v2 Postgres
###############################################################################

resource "aws_rds_cluster" "aurora" {
  # checkov:skip=CKV_AWS_139:IAM auth is intentionally OFF in v1 - RDS Proxy with Secrets Manager auth is the canonical access path. IAM auth can be enabled per-consumer later by flipping iam_database_authentication_enabled and adding rds-db:connect grants. Documented in README §"Why no IAM database authentication in v1".
  # checkov:skip=CKV_AWS_162:Same - IAM database authentication is intentionally disabled in v1 (duplicate rule of CKV_AWS_139). Reviewer: security-compliance.
  # checkov:skip=CKV_AWS_324:Query logging beyond pg_stat_statements + log_statement=ddl is intentionally not enabled - full query logging on a multi-tenant DB has finops + privacy implications. Tune up via parameter group when audit demand justifies it.
  # checkov:skip=CKV2_AWS_8:Backup-plan-integration via AWS Backup is out of scope for v1; backup_retention_period covers the primary need. Add an aws_backup_plan reference in a future ticket if cross-account vaulting becomes a requirement.

  cluster_identifier = local.cluster_name

  engine         = "aurora-postgresql"
  engine_mode    = "provisioned"
  engine_version = var.engine_version

  database_name   = var.database_name
  master_username = var.master_username

  # AWS auto-generates the master password and stores it in a managed secret
  # encrypted under our CMK. AWS rotates it on a schedule it controls - no
  # rotation Lambda required (see lambdas/rotation/README.md for rationale).
  manage_master_user_password   = true
  master_user_secret_kms_key_id = aws_kms_key.aurora.arn

  db_subnet_group_name            = aws_db_subnet_group.aurora.name
  vpc_security_group_ids          = [aws_security_group.cluster.id]
  db_cluster_parameter_group_name = aws_rds_cluster_parameter_group.aurora.name

  storage_encrypted = true
  kms_key_id        = aws_kms_key.aurora.arn

  backup_retention_period      = var.backup_retention_period
  preferred_backup_window      = var.preferred_backup_window
  preferred_maintenance_window = var.preferred_maintenance_window

  skip_final_snapshot       = var.skip_final_snapshot
  final_snapshot_identifier = var.skip_final_snapshot ? null : "${local.cluster_name}-final-${formatdate("YYYYMMDDhhmmss", timestamp())}"
  deletion_protection       = var.deletion_protection
  apply_immediately         = var.apply_immediately

  enabled_cloudwatch_logs_exports = ["postgresql"]

  serverlessv2_scaling_configuration {
    min_capacity             = var.min_capacity
    max_capacity             = var.max_capacity
    seconds_until_auto_pause = local.auto_pause_active ? var.seconds_until_auto_pause : null
  }

  # copy_tags_to_snapshot = true so snapshot lineage is auditable.
  copy_tags_to_snapshot = true

  tags = merge(local.tags, {
    Name = local.cluster_name
  })

  lifecycle {
    # final_snapshot_identifier embeds a timestamp so plan refreshes don't
    # show false drift; ignore it after creation.
    ignore_changes = [
      final_snapshot_identifier,
    ]
  }
}

###############################################################################
# 6. Cluster instances (writer + readers).
#
# db.serverless is the Serverless v2 instance class. The first instance is
# the writer; subsequent instances are readers. Auto minor version upgrade
# is OFF - we want explicit upgrades to coordinate with parameter group
# changes.
###############################################################################

resource "aws_rds_cluster_instance" "aurora" {
  # checkov:skip=CKV_AWS_226:auto_minor_version_upgrade is intentionally OFF - engine bumps must coordinate with the cluster parameter group changes (shared_preload_libraries) that require pending-reboot apply. Operator drives upgrades explicitly via var.engine_version. Documented in README.
  # checkov:skip=CKV_AWS_118:Enhanced Monitoring (monitoring_interval > 0) is OFF in v1 - Performance Insights at 7-day retention covers the per-query observability needs at no cost. Enabling Enhanced Monitoring adds ~$2/instance/mo plus CloudWatch metric volume. Bump to 60 via tfvars when finops budget allows. Reviewer: finops-analyst + observability-sre.

  count = var.instance_count

  identifier         = "${local.cluster_name}-${count.index}"
  cluster_identifier = aws_rds_cluster.aurora.id

  instance_class = "db.serverless"
  engine         = aws_rds_cluster.aurora.engine
  engine_version = aws_rds_cluster.aurora.engine_version

  db_subnet_group_name = aws_db_subnet_group.aurora.name

  performance_insights_enabled          = true
  performance_insights_kms_key_id       = aws_kms_key.aurora.arn
  performance_insights_retention_period = var.performance_insights_retention_period

  auto_minor_version_upgrade = false
  apply_immediately          = var.apply_immediately

  monitoring_interval = 0 # Enhanced Monitoring off in v1 - Performance Insights covers the per-query needs without the additional CloudWatch metric cost. Bump to 60 in prod when finops budget allows.

  tags = merge(local.tags, {
    Name = "${local.cluster_name}-${count.index}"
    Role = count.index == 0 ? "writer" : "reader"
  })
}

###############################################################################
# 7. RDS Proxy
#
# The proxy fronts the cluster and:
#   - Holds a connection pool so Fargate cold starts don't slam Aurora with
#     a connection storm (Postgres connections are expensive to set up).
#   - Reads the master credential from Secrets Manager - when AWS rotates
#     it, the proxy picks up the new value without app-side reload.
#   - Pins per-tenant connections cleanly when consumers use SET-based
#     session state (Strata's multi-tenant pattern).
#
# IAM authentication is OFF in v1; consumers authenticate via the proxy
# using the master credential the proxy already knows about. To enable
# per-consumer IAM auth, flip iam_database_authentication_enabled on the
# cluster + add rds-db:connect grants on consumer task roles.
###############################################################################

# IAM role the proxy assumes to read the Secrets Manager secret.
data "aws_iam_policy_document" "proxy_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["rds.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "proxy" {
  name               = "${local.cluster_name}-proxy-role"
  assume_role_policy = data.aws_iam_policy_document.proxy_assume.json

  tags = merge(local.tags, {
    Name = "${local.cluster_name}-proxy-role"
  })
}

# Read-only on the auto-managed master credential secret + decrypt with the
# cluster CMK. Scope is exactly the secret + CMK - no wildcards.
data "aws_iam_policy_document" "proxy_secret_access" {
  statement {
    sid    = "ReadMasterCredentialSecret"
    effect = "Allow"
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
    ]
    resources = [aws_rds_cluster.aurora.master_user_secret[0].secret_arn]
  }

  statement {
    sid       = "DecryptWithClusterCmk"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.aurora.arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${var.aws_region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "proxy_secret_access" {
  name   = "${local.cluster_name}-proxy-secret-access"
  role   = aws_iam_role.proxy.id
  policy = data.aws_iam_policy_document.proxy_secret_access.json
}

resource "aws_db_proxy" "aurora" {
  name                   = "${local.cluster_name}-proxy"
  engine_family          = "POSTGRESQL"
  role_arn               = aws_iam_role.proxy.arn
  vpc_subnet_ids         = var.subnet_ids
  vpc_security_group_ids = [aws_security_group.cluster.id]
  require_tls            = true
  idle_client_timeout    = var.proxy_idle_client_timeout
  debug_logging          = false

  auth {
    auth_scheme = "SECRETS"
    iam_auth    = "DISABLED"
    secret_arn  = aws_rds_cluster.aurora.master_user_secret[0].secret_arn
    description = "Master credential for ${local.cluster_name}, AWS-managed via manage_master_user_password."
  }

  tags = merge(local.tags, {
    Name = "${local.cluster_name}-proxy"
  })

  # The proxy depends on the role-policy attachment being in place, otherwise
  # the proxy creation fails the secret-access pre-flight check.
  depends_on = [aws_iam_role_policy.proxy_secret_access]
}

resource "aws_db_proxy_default_target_group" "aurora" {
  db_proxy_name = aws_db_proxy.aurora.name

  connection_pool_config {
    max_connections_percent      = var.proxy_max_connections_percent
    max_idle_connections_percent = floor(var.proxy_max_connections_percent / 2)
    connection_borrow_timeout    = 120
  }
}

resource "aws_db_proxy_target" "aurora" {
  db_cluster_identifier = aws_rds_cluster.aurora.id
  db_proxy_name         = aws_db_proxy.aurora.name
  target_group_name     = aws_db_proxy_default_target_group.aurora.name

  # The proxy can only target the cluster after at least one instance is
  # online; otherwise the registration fails with "no targets available".
  depends_on = [aws_rds_cluster_instance.aurora]
}

###############################################################################
# 8. Consumer IAM policy template (output only - not a resource).
#
# Consumers (ECS task roles, Lambda exec roles) attach this JSON to gain:
#   - secretsmanager:GetSecretValue on the master credential secret
#   - kms:Decrypt on the cluster CMK (scoped via kms:ViaService to Secrets
#     Manager backplane)
#
# This is the minimum needed to read the master credential and connect
# through the proxy. Consumers also need network reachability - see the
# README's "Consumer wiring pattern" section.
###############################################################################

data "aws_iam_policy_document" "consumer" {
  statement {
    sid       = "ReadMasterCredentialSecret"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_rds_cluster.aurora.master_user_secret[0].secret_arn]
  }

  statement {
    sid       = "DecryptWithClusterCmk"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.aurora.arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${var.aws_region}.amazonaws.com"]
    }
  }
}
