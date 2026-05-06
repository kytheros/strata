###############################################################################
# strata observability — log groups + EMF metric filters + SNS paging topic +
# default alarm set + SLO dashboard
#
# What this module owns (and what it doesn't):
#
#   Owns:  CloudWatch log groups (caller-declared), EMF metric filters,
#          SNS topic for paging + its CMK, the default alarm set (8 alarms),
#          the strata SLO dashboard.
#
#   Does NOT own: the resources the alarms target. Cluster, ALB, Aurora,
#                 Redis, NAT GWs, Cognito User Pool — those are owned by their
#                 respective modules. This module accepts ARNs/identifiers as
#                 string variables so it can plan against placeholders before
#                 the targets exist.
#
# Conditional alarm pattern: every alarm is gated on `length(var.<target>) > 0`
# (or `!= ""` for scalar ARNs). Pass empty for any alarm you don't want — the
# module just doesn't create it. This is what lets the module be applied in
# Phase 1 alongside the partial set of upstream resources that exist today.
#
# One alarm = one runbook. Every alarm's `alarm_description` ends with a
# `Runbook: <url>/<alarm-name>.md` reference. The runbook URL prefix is
# var.runbook_base_url; the alarm name slug matches the runbook filename.
###############################################################################

data "aws_caller_identity" "current" {}

locals {
  default_tags = {
    Project     = "strata"
    Component   = "observability"
    ManagedBy   = "terraform"
    Environment = var.env_name
  }

  tags = merge(local.default_tags, var.extra_tags)

  topic_name = "strata-${var.env_name}-alarms"
  alias_name = "alias/strata-${var.env_name}-alarms"

  # Which alarm groups are enabled. Computed once so each resource only repeats
  # the read on a known-cheap local.
  alb_alarms_enabled        = var.alb_arn != "" && var.alb_arn_suffix != ""
  ecs_alarms_enabled        = var.ecs_cluster_arn != "" && var.ecs_cluster_name != "" && length(var.ecs_service_names) > 0
  aurora_alarms_enabled     = var.aurora_cluster_arn != "" && var.aurora_cluster_identifier != ""
  redis_alarms_enabled      = var.redis_cache_arn != "" && var.redis_cache_name != ""
  nat_anomaly_enabled       = length(var.nat_gateway_ids) > 0
  cognito_alarms_enabled    = var.cognito_user_pool_id != ""
  redis_storage_threshold_b = floor(var.redis_max_data_storage_bytes * 0.8)

  # Per-runbook URL helper. Keep slug == alarm Terraform key; e.g. the alarm
  # at aws_cloudwatch_metric_alarm.alb_5xx_rate writes its description with
  # Runbook: ${var.runbook_base_url}/alb_5xx_rate.md
  runbook_url = var.runbook_base_url

  # Phase 4 (AWS-4.1) gating signals.
  jwt_auth_metrics_enabled = var.apigw_log_group_name != ""
  ops_dashboard_enabled    = var.enable_ops_dashboard
}

###############################################################################
# 1. SNS topic for paging + CMK
#
# The SNS topic IS the alarm fan-out point. AlarmActions and OkActions on every
# alarm publish here; consumers (PagerDuty/Opsgenie/email) subscribe via
# var.alarm_subscribers. Topic is encrypted with a per-module CMK so the topic's
# message bodies are KMS-protected end-to-end.
###############################################################################

data "aws_iam_policy_document" "alarm_topic_key" {
  # checkov:skip=CKV_AWS_109:Resource="*" inside a KMS key policy refers to the key the policy is attached to — a key policy cannot list other keys. Standard AWS-recommended pattern.
  # checkov:skip=CKV_AWS_111:Same — write access is constrained to the key this policy attaches to. The CW Alarms statement is further constrained by aws:SourceAccount.
  # checkov:skip=CKV_AWS_356:Same — "*" is the only legal resource for KMS key-attached policy statements. CloudWatch grant is constrained via aws:SourceAccount + service-principal scoping.
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

  # CloudWatch Alarms publish to SNS via the cloudwatch service principal. The
  # SNS service principal is the one that needs GenerateDataKey/Decrypt to
  # encrypt the message body bound for the topic.
  statement {
    sid    = "AllowCloudWatchAlarmsToPublish"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }

    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey",
    ]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }

  # SNS itself needs to encrypt at rest with this key.
  statement {
    sid    = "AllowSNSToUseKey"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["sns.amazonaws.com"]
    }

    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey*",
    ]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_kms_key" "alarms" {
  description             = "CMK for the strata-${var.env_name}-alarms SNS topic. Encrypts alarm-payload message bodies at rest."
  deletion_window_in_days = var.kms_deletion_window_days
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.alarm_topic_key.json

  tags = merge(local.tags, {
    Name = "strata-${var.env_name}-alarms-cmk"
  })
}

resource "aws_kms_alias" "alarms" {
  name          = local.alias_name
  target_key_id = aws_kms_key.alarms.key_id
}

resource "aws_sns_topic" "alarms" {
  name              = local.topic_name
  kms_master_key_id = aws_kms_key.alarms.arn
  display_name      = "Strata ${var.env_name} Alarms"

  tags = merge(local.tags, {
    Name = local.topic_name
  })
}

resource "aws_sns_topic_subscription" "subscribers" {
  for_each = {
    for idx, s in var.alarm_subscribers :
    "${s.protocol}-${idx}" => s
  }

  topic_arn = aws_sns_topic.alarms.arn
  protocol  = each.value.protocol
  endpoint  = each.value.endpoint
}

###############################################################################
# 2. Service log groups (caller-declared)
#
# Each entry creates one CloudWatch Logs group at `name`, with retention and
# optional KMS-CMK encryption. KMS arn = "" means AWS-managed key.
###############################################################################

resource "aws_cloudwatch_log_group" "service" {
  for_each = {
    for g in var.service_log_groups : g.name => g
  }

  # checkov:skip=CKV_AWS_158:Caller can supply a CMK via service_log_groups[*].kms_key_arn; default ('') falls back to the AWS-managed CloudWatch Logs key. Per-group CMK ownership is intentional — log groups outlive this module on destroy/recreate cycles only when caller pins to an external key.
  # checkov:skip=CKV_AWS_338:Retention is caller-controlled (service_log_groups[*].retention_days); 30d default matches design §"Retention costs money". Long-tail forensics are covered by S3 archival, not CloudWatch.
  name              = each.value.name
  retention_in_days = each.value.retention_days
  kms_key_id        = each.value.kms_key_arn != "" ? each.value.kms_key_arn : null

  tags = merge(local.tags, {
    Name = each.value.name
  })
}

###############################################################################
# 3. EMF metric filters
#
# The pattern is the CloudWatch Logs filter language. Dimensions map output
# dimension name → JSON pointer into the matched event. metric_value can be
# a constant (e.g. "1" for counters) or a JSON-pointer reference (e.g.
# "$.duration_ms" for gauges).
###############################################################################

resource "aws_cloudwatch_log_metric_filter" "this" {
  for_each = {
    for f in var.metric_filters : f.name => f
  }

  name           = each.value.name
  pattern        = each.value.pattern
  log_group_name = each.value.log_group

  metric_transformation {
    name       = each.value.metric_name
    namespace  = each.value.namespace
    value      = each.value.metric_value
    dimensions = each.value.dimensions
  }

  # Caller's responsibility: ensure the referenced log_group either exists
  # already (e.g. cluster log group from AWS-1.2) or is provisioned in
  # var.service_log_groups within the same apply. Implicit dependency below
  # covers the latter case; missing-group apply errors are the surface for
  # the former.
  depends_on = [aws_cloudwatch_log_group.service]
}

###############################################################################
# 4. Alarms
#
# Pattern: every alarm is conditional on its target group being enabled. We use
# `count = local.<group>_alarms_enabled ? 1 : 0` (or for_each over a list).
# alarm_description carries a one-line runbook reference; alarm_actions and
# ok_actions both fire to the SNS topic so on-call sees both directions.
#
# treat_missing_data = "notBreaching" prevents pages from "no data" gaps —
# for portfolio-demo workloads where traffic comes and goes, "missing" is the
# normal state, not an alert condition.
###############################################################################

# --- 4a. ALB 5xx rate -------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "alb_5xx_rate" {
  count = local.alb_alarms_enabled ? 1 : 0

  alarm_name          = "strata-${var.env_name}-alb-5xx-rate"
  alarm_description   = "ALB target 5xx error rate exceeded 1% of total requests over a 5-minute window. Indicates upstream service errors are reaching clients. Runbook: ${local.runbook_url}/alb_5xx_rate.md"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  threshold           = 1
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "e1"
    expression  = "(m_5xx / m_req) * 100"
    label       = "5xx error rate (%)"
    return_data = true
  }

  metric_query {
    id = "m_5xx"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_Target_5XX_Count"
      period      = 300
      stat        = "Sum"
      dimensions = {
        LoadBalancer = var.alb_arn_suffix
      }
    }
  }

  metric_query {
    id = "m_req"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "RequestCount"
      period      = 300
      stat        = "Sum"
      dimensions = {
        LoadBalancer = var.alb_arn_suffix
      }
    }
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]

  tags = merge(local.tags, {
    Name = "strata-${var.env_name}-alb-5xx-rate"
  })
}

# --- 4b. ALB p99 latency ----------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "alb_p99_latency" {
  count = local.alb_alarms_enabled ? 1 : 0

  alarm_name          = "strata-${var.env_name}-alb-p99-latency"
  alarm_description   = "ALB p99 target response time exceeded 800ms — design SLO breach. Runbook: ${local.runbook_url}/alb_p99_latency.md"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  threshold           = 0.8 # seconds
  treat_missing_data  = "notBreaching"

  metric_name        = "TargetResponseTime"
  namespace          = "AWS/ApplicationELB"
  period             = 300
  extended_statistic = "p99"

  dimensions = {
    LoadBalancer = var.alb_arn_suffix
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]

  tags = merge(local.tags, {
    Name = "strata-${var.env_name}-alb-p99-latency"
  })
}

# --- 4c. ECS task shortfall (per service) -----------------------------------

resource "aws_cloudwatch_metric_alarm" "ecs_task_shortfall" {
  for_each = local.ecs_alarms_enabled ? toset(var.ecs_service_names) : toset([])

  alarm_name          = "strata-${var.env_name}-ecs-task-shortfall-${each.value}"
  alarm_description   = "Service ${each.value} has fewer running tasks than desired for 5+ minutes. Indicates task crash loop, image pull failure, or capacity provider exhaustion. Runbook: ${local.runbook_url}/ecs_task_shortfall.md"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  threshold           = 0
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "e1"
    expression  = "running - desired"
    label       = "RunningTaskCount minus DesiredTaskCount"
    return_data = true
  }

  metric_query {
    id = "running"
    metric {
      namespace   = "AWS/ECS"
      metric_name = "RunningTaskCount"
      period      = 300
      stat        = "Average"
      dimensions = {
        ClusterName = var.ecs_cluster_name
        ServiceName = each.value
      }
    }
  }

  metric_query {
    id = "desired"
    metric {
      namespace   = "AWS/ECS"
      metric_name = "DesiredTaskCount"
      period      = 300
      stat        = "Average"
      dimensions = {
        ClusterName = var.ecs_cluster_name
        ServiceName = each.value
      }
    }
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]

  tags = merge(local.tags, {
    Name    = "strata-${var.env_name}-ecs-task-shortfall-${each.value}"
    Service = each.value
  })
}

# --- 4d. Aurora ACU max -----------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "aurora_acu_max" {
  count = local.aurora_alarms_enabled ? 1 : 0

  alarm_name          = "strata-${var.env_name}-aurora-acu-max"
  alarm_description   = "Aurora Serverless v2 ServerlessDatabaseCapacity exceeded ${var.aurora_acu_alarm_threshold} ACU — approaching the cluster max (${var.aurora_acu_alarm_threshold + 2}). Sustained breach indicates a need to raise the cap or audit query plans. Runbook: ${local.runbook_url}/aurora_acu_max.md"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  threshold           = var.aurora_acu_alarm_threshold
  treat_missing_data  = "notBreaching"

  metric_name = "ServerlessDatabaseCapacity"
  namespace   = "AWS/RDS"
  period      = 300
  statistic   = "Average"

  dimensions = {
    DBClusterIdentifier = var.aurora_cluster_identifier
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]

  tags = merge(local.tags, {
    Name = "strata-${var.env_name}-aurora-acu-max"
  })
}

# --- 4e. Aurora CPU high ----------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "aurora_cpu_high" {
  count = local.aurora_alarms_enabled ? 1 : 0

  alarm_name          = "strata-${var.env_name}-aurora-cpu-high"
  alarm_description   = "Aurora cluster CPUUtilization >80% for 10 minutes. Investigate slow queries via pg_stat_statements; consider scaling ACU max. Runbook: ${local.runbook_url}/aurora_cpu_high.md"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = 80
  treat_missing_data  = "notBreaching"

  metric_name = "CPUUtilization"
  namespace   = "AWS/RDS"
  period      = 300
  statistic   = "Average"

  dimensions = {
    DBClusterIdentifier = var.aurora_cluster_identifier
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]

  tags = merge(local.tags, {
    Name = "strata-${var.env_name}-aurora-cpu-high"
  })
}

# --- 4f. Redis CPU high -----------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "redis_cpu_high" {
  count = local.redis_alarms_enabled ? 1 : 0

  alarm_name          = "strata-${var.env_name}-redis-cpu-high"
  alarm_description   = "ElastiCache EngineCPUUtilization >75% for 10 minutes. Redis is single-threaded for command processing; sustained high CPU indicates a hot key or client-side fan-out issue. Runbook: ${local.runbook_url}/redis_cpu_high.md"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = 75
  treat_missing_data  = "notBreaching"

  metric_name = "EngineCPUUtilization"
  namespace   = "AWS/ElastiCache"
  period      = 300
  statistic   = "Average"

  dimensions = {
    CacheClusterId = var.redis_cache_name
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]

  tags = merge(local.tags, {
    Name = "strata-${var.env_name}-redis-cpu-high"
  })
}

# --- 4g. Redis storage high -------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "redis_storage_high" {
  count = local.redis_alarms_enabled ? 1 : 0

  alarm_name          = "strata-${var.env_name}-redis-storage-high"
  alarm_description   = "Redis BytesUsedForCache exceeded 80% of provisioned data_storage (${var.redis_max_data_storage_bytes} bytes). Eviction will start hurting hit rate. Investigate TTL strategy or raise the cap. Runbook: ${local.runbook_url}/redis_storage_high.md"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = local.redis_storage_threshold_b
  treat_missing_data  = "notBreaching"

  metric_name = "BytesUsedForCache"
  namespace   = "AWS/ElastiCache"
  period      = 300
  statistic   = "Average"

  dimensions = {
    CacheClusterId = var.redis_cache_name
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]

  tags = merge(local.tags, {
    Name = "strata-${var.env_name}-redis-storage-high"
  })
}

# --- 4h. NAT bytes-out 3σ anomaly (catches design Risk #3) -----------------

resource "aws_cloudwatch_metric_alarm" "nat_bytes_out_anomaly" {
  for_each = local.nat_anomaly_enabled ? toset(var.nat_gateway_ids) : toset([])

  alarm_name          = "strata-${var.env_name}-nat-bytes-out-anomaly-${each.value}"
  alarm_description   = "NAT Gateway ${each.value} BytesOutToDestination outside the 3σ anomaly band. Indicates a possible chatty agent or runaway outbound traffic — design Risk #3. Investigate via VPC Flow Logs filtered to dstaddr in the public LLM API range. Runbook: ${local.runbook_url}/nat_bytes_out_anomaly.md"
  comparison_operator = "GreaterThanUpperThreshold"
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  threshold_metric_id = "ad1"
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "m1"
    return_data = true
    metric {
      namespace   = "AWS/NATGateway"
      metric_name = "BytesOutToDestination"
      period      = 300
      stat        = "Sum"
      dimensions = {
        NatGatewayId = each.value
      }
    }
  }

  metric_query {
    id          = "ad1"
    expression  = "ANOMALY_DETECTION_BAND(m1, 3)"
    label       = "Bytes out (anomaly band, 3σ)"
    return_data = true
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]

  tags = merge(local.tags, {
    Name       = "strata-${var.env_name}-nat-bytes-out-anomaly-${each.value}"
    NatGateway = each.value
  })
}

# --- 4i. Cognito auth failure rate (catches design Risk #1) ----------------

resource "aws_cloudwatch_metric_alarm" "cognito_auth_failure_rate" {
  count = local.cognito_alarms_enabled ? 1 : 0

  alarm_name          = "strata-${var.env_name}-cognito-auth-failure-rate"
  alarm_description   = "Cognito User Pool sign-in throttle rate exceeded 5% of successful sign-ins over 15 minutes. Often the first symptom of design Risk #1 — Cognito → Strata claims-shape drift causing repeated auth retries by the client. Runbook: ${local.runbook_url}/cognito_auth_failure_rate.md"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  threshold           = 5
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "e1"
    expression  = "(throttles / IF(success == 0, 1, success)) * 100"
    label       = "Auth failure rate (%)"
    return_data = true
  }

  metric_query {
    id = "throttles"
    metric {
      namespace   = "AWS/Cognito"
      metric_name = "SignInThrottles"
      period      = 900
      stat        = "Sum"
      dimensions = {
        UserPool = var.cognito_user_pool_id
      }
    }
  }

  metric_query {
    id = "success"
    metric {
      namespace   = "AWS/Cognito"
      metric_name = "SignInSuccesses"
      period      = 900
      stat        = "Sum"
      dimensions = {
        UserPool = var.cognito_user_pool_id
      }
    }
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]

  tags = merge(local.tags, {
    Name = "strata-${var.env_name}-cognito-auth-failure-rate"
  })
}

###############################################################################
# 4j. JWT authorizer error-rate metric filters + alarm (AWS-4.1)
#
# AWS-1.6.4 added `authError` and `sub` to the API GW access log. We attach
# two metric filters to that log group:
#
#   1. JwtAuthErrorCount — increments on any line where authError is non-empty
#      and not the "-" placeholder API GW emits when the field is null.
#   2. JwtAuthRequestCount — increments on every line, providing the
#      denominator the dashboard auth-funnel and the rate alarm consume.
#
# CloudWatch Logs filter pattern semantics:
#   The pattern `{ $.authError != "" && $.authError != "-" }` matches log
#   events whose JSON `authError` field is non-empty and not the apigw
#   placeholder. The `{ $.requestId = "*" }` pattern matches any line that
#   has a requestId (which is always present on the apigw access log shape).
#
# treat_missing_data on the alarm = "notBreaching" so periods of zero
# traffic don't page; the alarm is a sustained-failure signal, not a
# liveness signal.
###############################################################################

resource "aws_cloudwatch_log_metric_filter" "jwt_auth_error_count" {
  count = local.jwt_auth_metrics_enabled ? 1 : 0

  name           = "strata-${var.env_name}-jwt-auth-error-count"
  log_group_name = var.apigw_log_group_name
  pattern        = "{ ($.authError != \"\") && ($.authError != \"-\") }"

  metric_transformation {
    name          = "JwtAuthErrorCount"
    namespace     = var.apigw_metric_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_log_metric_filter" "jwt_auth_request_count" {
  count = local.jwt_auth_metrics_enabled ? 1 : 0

  name           = "strata-${var.env_name}-jwt-auth-request-count"
  log_group_name = var.apigw_log_group_name
  pattern        = "{ $.requestId = \"*\" }"

  metric_transformation {
    name          = "JwtAuthRequestCount"
    namespace     = var.apigw_metric_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "jwt_auth_error_rate" {
  count = local.jwt_auth_metrics_enabled ? 1 : 0

  alarm_name          = "strata-${var.env_name}-jwt-auth-error-rate"
  alarm_description   = "JWT authorizer rejection rate exceeded ${var.jwt_auth_error_rate_threshold}% over 15 minutes. Indicates client-side misconfig, expired tokens, or brute force against the /mcp endpoint. Cross-reference the API GW access log for the offending source IPs and route keys. Runbook: ${local.runbook_url}/jwt_auth_error_rate.md"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  threshold           = var.jwt_auth_error_rate_threshold
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "e1"
    expression  = "(errors / IF(total == 0, 1, total)) * 100"
    label       = "JWT auth error rate (%)"
    return_data = true
  }

  metric_query {
    id = "errors"
    metric {
      namespace   = var.apigw_metric_namespace
      metric_name = "JwtAuthErrorCount"
      period      = 300
      stat        = "Sum"
    }
  }

  metric_query {
    id = "total"
    metric {
      namespace   = var.apigw_metric_namespace
      metric_name = "JwtAuthRequestCount"
      period      = 300
      stat        = "Sum"
    }
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]

  tags = merge(local.tags, {
    Name = "strata-${var.env_name}-jwt-auth-error-rate"
  })
}

###############################################################################
# 5. SLO Dashboard
#
# Rendered from dashboards/strata-slo-dashboard.json with templatefile() so the
# JSON stays valid against AWS-console "View source" output. Empty target
# variables substitute to placeholder strings; widgets keyed off them simply
# show "no data" rather than failing dashboard create.
###############################################################################

resource "aws_cloudwatch_dashboard" "slo" {
  dashboard_name = "strata-${var.env_name}-slo"

  dashboard_body = templatefile("${path.module}/dashboards/strata-slo-dashboard.json", {
    aws_region                = var.aws_region
    env_name                  = var.env_name
    alb_arn_suffix            = var.alb_arn_suffix != "" ? var.alb_arn_suffix : "PLACEHOLDER"
    ecs_cluster_name          = var.ecs_cluster_name != "" ? var.ecs_cluster_name : "PLACEHOLDER"
    ecs_service_names         = var.ecs_service_names
    aurora_cluster_identifier = var.aurora_cluster_identifier != "" ? var.aurora_cluster_identifier : "PLACEHOLDER"
    redis_cache_name          = var.redis_cache_name != "" ? var.redis_cache_name : "PLACEHOLDER"
    nat_gateway_ids           = var.nat_gateway_ids
    cognito_user_pool_id      = var.cognito_user_pool_id != "" ? var.cognito_user_pool_id : "PLACEHOLDER"
  })
}

###############################################################################
# 6. Ops Dashboard (Phase 4 / AWS-4.1)
#
# Comprehensive operational view alongside the SLO dashboard. Surfaces ECS
# per-service utilization, API GW request/error/latency mix, NLB flow + healthy
# host counts, Aurora ACU/conns/replica-lag, Redis Serverless usage, NAT egress,
# VPC-endpoint usage, and the JWT authentication funnel.
#
# Gated on var.enable_ops_dashboard so the module's default behavior is
# unchanged for callers that just want the SLO view. Any input variable that
# is empty when the dashboard renders falls back to PLACEHOLDER strings; the
# corresponding widgets render "no data" cleanly.
###############################################################################

resource "aws_cloudwatch_dashboard" "ops" {
  count = local.ops_dashboard_enabled ? 1 : 0

  dashboard_name = "strata-${var.env_name}-ops"

  dashboard_body = templatefile("${path.module}/dashboards/strata-ops-dashboard.json", {
    aws_region                  = var.aws_region
    env_name                    = var.env_name
    apigw_api_id                = var.apigw_api_id != "" ? var.apigw_api_id : "PLACEHOLDER"
    apigw_log_group_name        = var.apigw_log_group_name != "" ? var.apigw_log_group_name : "PLACEHOLDER"
    apigw_metric_namespace      = var.apigw_metric_namespace
    ecs_cluster_name            = var.ecs_cluster_name != "" ? var.ecs_cluster_name : "PLACEHOLDER"
    strata_service_name         = var.strata_service_name != "" ? var.strata_service_name : "PLACEHOLDER"
    example_agent_service_name  = var.example_agent_service_name != "" ? var.example_agent_service_name : "PLACEHOLDER"
    nlb_arn_suffix              = var.nlb_arn_suffix != "" ? var.nlb_arn_suffix : "PLACEHOLDER"
    nlb_target_group_arn_suffix = var.nlb_target_group_arn_suffix != "" ? var.nlb_target_group_arn_suffix : "PLACEHOLDER"
    aurora_cluster_identifier   = var.aurora_cluster_identifier != "" ? var.aurora_cluster_identifier : "PLACEHOLDER"
    redis_cache_name            = var.redis_cache_name != "" ? var.redis_cache_name : "PLACEHOLDER"
  })
}
