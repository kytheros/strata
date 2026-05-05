###############################################################################
# strata ecs-cluster — Fargate cluster + CMK-encrypted log group + Exec role
#
# What this module owns (and what it doesn't):
#
#   Owns: 1 ECS cluster, 1 CloudWatch Log Group, 1 KMS CMK + alias, 1 IAM role
#         (ECS Exec operator) + its policies. Container Insights ON. ECS Exec
#         enabled cluster-wide via cluster configuration.
#
#   Does NOT own: ECS services, task definitions, task roles, ALB target
#                 groups, autoscaling. Those live in the `ecs-service` module
#                 (AWS-1.3) which consumes this cluster's outputs.
#
# Default capacity provider strategy: 80% FARGATE_SPOT / 20% FARGATE on-demand.
# Per-service strategies override this. Tunable via var.fargate_spot_weight or
# replaced wholesale via var.capacity_provider_strategy.
#
# Per design §"Compute: ECS Fargate" — Fargate-only, no EC2 capacity providers.
# Promotion to EKS is a v3 conversation, not v1.
###############################################################################

data "aws_caller_identity" "current" {}

locals {
  default_tags = {
    Project     = "strata"
    Component   = "ecs-cluster"
    ManagedBy   = "terraform"
    Environment = var.env_name
  }

  tags = merge(local.default_tags, var.extra_tags)

  cluster_name   = "strata-${var.env_name}"
  log_group_name = "/ecs/strata-${var.env_name}"

  # Default strategy if caller did not pass one explicitly. Both providers must
  # be present even when the weight on one is 0, so a downstream service can
  # reference either by name without having to also declare it. Base is 0 on
  # both — services with a guaranteed on-demand floor set their own base.
  computed_default_strategy = [
    {
      capacity_provider = "FARGATE_SPOT"
      weight            = var.fargate_spot_weight
      base              = 0
    },
    {
      capacity_provider = "FARGATE"
      weight            = 100 - var.fargate_spot_weight
      base              = 0
    },
  ]

  effective_strategy = coalesce(var.capacity_provider_strategy, local.computed_default_strategy)

  # CloudWatch Logs service principal for the KMS key policy. AWS publishes
  # this as `logs.<region>.amazonaws.com` — region-scoped, not partition-wide.
  logs_service_principal = "logs.${var.aws_region}.amazonaws.com"
}

###############################################################################
# 1. KMS CMK for the log group
#
# Per-cluster CMK (not a shared envelope key) so that destroy/recreate cycles
# of this module are self-contained — tearing down the cluster also tears down
# its key, and there's no cross-module ownership to track. Rotation is on by
# default. Deletion window defaults to 7d (AWS minimum) to match the portfolio-
# demo destroy/recreate cadence; bump via var.kms_deletion_window_days for prod.
###############################################################################

data "aws_iam_policy_document" "logs_key" {
  # checkov:skip=CKV_AWS_109:Resource="*" inside a KMS key policy refers to the key the policy is attached to — a key policy cannot list other keys. Standard AWS-recommended pattern.
  # checkov:skip=CKV_AWS_111:Same — write access is constrained to the key this policy attaches to. The CW Logs statement is further constrained by kms:EncryptionContext condition.
  # checkov:skip=CKV_AWS_356:Same — "*" is the only legal resource for KMS key-attached policy statements. CloudWatch Logs grant is constrained via the EncryptionContext ArnLike condition on this cluster's log-group ARN.
  # Root account: standard "leave a door for the account admin" statement.
  # Without this, an accidental policy mistake locks everyone out of the key.
  statement {
    sid    = "EnableRootPermissions"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }

    actions   = ["kms:*"]
    resources = ["*"]
  }

  # CloudWatch Logs service: scoped to log groups in this region under this
  # account, via the kms:EncryptionContext:aws:logs:arn condition. CW Logs
  # passes the log-group ARN as encryption context on every Encrypt/Decrypt;
  # we lock the key to only sign for log groups we own.
  statement {
    sid    = "AllowCloudWatchLogsToUseKey"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = [local.logs_service_principal]
    }

    actions = [
      "kms:Encrypt*",
      "kms:Decrypt*",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey*",
      "kms:Describe*",
    ]
    resources = ["*"]

    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values = [
        "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:${local.log_group_name}",
        "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:${local.log_group_name}:*",
      ]
    }
  }
}

resource "aws_kms_key" "logs" {
  description             = "CMK for ECS cluster ${local.cluster_name} CloudWatch Logs (env=${var.env_name})."
  deletion_window_in_days = var.kms_deletion_window_days
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.logs_key.json

  tags = merge(local.tags, {
    Name = "strata-${var.env_name}-ecs-logs-cmk"
  })
}

resource "aws_kms_alias" "logs" {
  name          = "alias/strata-${var.env_name}-ecs-logs"
  target_key_id = aws_kms_key.logs.key_id
}

###############################################################################
# 2. CloudWatch Log Group — KMS-encrypted with the CMK above
###############################################################################

resource "aws_cloudwatch_log_group" "this" {
  # checkov:skip=CKV_AWS_338:Cluster log retention is intentionally var.log_retention_days (default 30d). Long-tail forensics are covered by S3 archival in AWS-1.10 (observability); CloudWatch is the hot tier only.
  name              = local.log_group_name
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.logs.arn

  tags = local.tags

  # The KMS key must allow logs.<region>.amazonaws.com to encrypt before the
  # log group can be created with kms_key_id set. Explicit dependency keeps
  # apply ordering deterministic across providers' resource graph rebuilds.
  depends_on = [aws_kms_key.logs]
}

###############################################################################
# 3. ECS Cluster — Fargate-only, Container Insights ON, ECS Exec enabled
###############################################################################

resource "aws_ecs_cluster" "this" {
  name = local.cluster_name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  # Cluster-wide ECS Exec defaults: route execute-command session output into
  # the cluster's CloudWatch Logs group, encrypted with the cluster CMK. Per-
  # task overrides can disable or redirect; this is the safe default.
  configuration {
    execute_command_configuration {
      kms_key_id = aws_kms_key.logs.arn
      logging    = "OVERRIDE"

      log_configuration {
        cloud_watch_encryption_enabled = true
        cloud_watch_log_group_name     = aws_cloudwatch_log_group.this.name
      }
    }
  }

  tags = merge(local.tags, {
    Name = local.cluster_name
  })
}

###############################################################################
# 4. Capacity providers — FARGATE + FARGATE_SPOT
#
# Attached to the cluster and given a default strategy. Per design: 80/20
# spot/on-demand by default, tunable via var.fargate_spot_weight or fully
# overridable via var.capacity_provider_strategy.
###############################################################################

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name = aws_ecs_cluster.this.name

  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  dynamic "default_capacity_provider_strategy" {
    for_each = local.effective_strategy
    content {
      capacity_provider = default_capacity_provider_strategy.value.capacity_provider
      weight            = default_capacity_provider_strategy.value.weight
      base              = default_capacity_provider_strategy.value.base
    }
  }
}

###############################################################################
# 5. ECS Exec operator role
#
# This role is assumed by humans (SSO / IAM user) to run `aws ecs execute-
# command` against tasks in this cluster. The trust policy here grants
# AssumeRole to the account root — narrow it in production via SSO permission
# sets or by replacing the principal with specific IAM user/role ARNs.
#
# The role's permissions are scoped tightly:
#   - ecs:ExecuteCommand on tasks in this cluster only.
#   - ecs:DescribeTasks on tasks in this cluster only (needed to resolve the
#     task ARN before opening a session).
#   - ssmmessages:* on * (AWS does not support resource-level scoping for
#     ssmmessages — it's the SSM Session Manager data plane and predates
#     resource-level IAM. AWS-published limitation.)
#   - logs:CreateLogStream + PutLogEvents on the cluster's log group only.
###############################################################################

data "aws_iam_policy_document" "exec_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }
}

resource "aws_iam_role" "exec" {
  name               = "strata-${var.env_name}-ecs-exec-operator"
  assume_role_policy = data.aws_iam_policy_document.exec_assume.json
  description        = "Operator role for `aws ecs execute-command` against tasks in cluster ${local.cluster_name}."

  tags = local.tags
}

data "aws_iam_policy_document" "exec_permissions" {
  # Open the session: ExecuteCommand + DescribeTasks scoped to this cluster's
  # task ARNs and the cluster ARN itself.
  statement {
    sid    = "OpenExecSessionInThisCluster"
    effect = "Allow"

    actions = [
      "ecs:ExecuteCommand",
      "ecs:DescribeTasks",
    ]

    resources = [
      aws_ecs_cluster.this.arn,
      "arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task/${local.cluster_name}/*",
    ]
  }

  # ListTasks needs a wildcard task resource per the ECS IAM service auth ref;
  # we pin the cluster condition so the operator can only enumerate this
  # cluster's tasks.
  statement {
    sid    = "ListTasksInThisCluster"
    effect = "Allow"

    actions   = ["ecs:ListTasks"]
    resources = ["*"]

    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.this.arn]
    }
  }

  # SSM Session Manager data plane. AWS does not support resource-level IAM
  # for the ssmmessages actions, so the wildcard is the minimum necessary.
  # See: https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonsessionmanagermessagegateway.html
  statement {
    sid    = "SessionManagerDataPlane"
    effect = "Allow"

    actions = [
      "ssmmessages:CreateControlChannel",
      "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel",
      "ssmmessages:OpenDataChannel",
    ]

    resources = ["*"]
  }

  # CloudWatch Logs writer scoped to the cluster's own log group. The exec
  # session writes its session log here when the task definition opts in.
  statement {
    sid    = "WriteExecSessionLogsToClusterGroup"
    effect = "Allow"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogStreams",
    ]

    resources = [
      aws_cloudwatch_log_group.this.arn,
      "${aws_cloudwatch_log_group.this.arn}:*",
    ]
  }

  # KMS key permission so the session log encryption succeeds end-to-end.
  statement {
    sid    = "UseClusterCmkForExecSessionLogs"
    effect = "Allow"

    actions = [
      "kms:GenerateDataKey",
      "kms:Decrypt",
    ]

    resources = [aws_kms_key.logs.arn]
  }
}

resource "aws_iam_role_policy" "exec" {
  name   = "ecs-exec-operator"
  role   = aws_iam_role.exec.id
  policy = data.aws_iam_policy_document.exec_permissions.json
}
