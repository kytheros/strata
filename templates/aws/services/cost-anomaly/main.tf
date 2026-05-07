###############################################################################
# services/cost-anomaly -- Cost Anomaly Detection (AWS-5.1)
#
# Two Cost Explorer resources, both gated on var.enabled (default false):
#   1. aws_ce_anomaly_monitor  -- DIMENSIONAL, watches all AWS services.
#   2. aws_ce_anomaly_subscription -- absolute threshold, weekly digest.
#
# Why the toggle is default false (Phase 5 validation finding 2026-05-06):
# AWS auto-creates a Default-Services-Monitor (DIMENSIONAL, SERVICE) per
# account. The soft limit is 1 dimensional monitor; trying to create a
# second fails with "Limit exceeded on dimensional spend monitor
# creation". For dev, the strata-dev-cap manual AWS Budget is the real
# cost guard, and the account-default monitor already covers the
# anomaly-detection use case. Flip var.enabled = true only when:
#   (a) you have requested a quota raise and it landed, OR
#   (b) you have switched monitor_type to CUSTOM with an explicit
#       monitor_specification (different quota pool).
#
# The manual AWS Budget strata-dev-cap is NOT managed here -- operator-managed.
# Cost: CE Anomaly Detection has no AWS charge.
###############################################################################

locals {
  tags = merge(
    {
      Project     = "strata"
      Environment = var.env_name
      ManagedBy   = "terraform"
      CostCenter  = "demo"
    },
    var.extra_tags,
  )
}

resource "aws_ce_anomaly_monitor" "this" {
  count = var.enabled ? 1 : 0

  name              = "strata-${var.env_name}-all-services"
  monitor_type      = "DIMENSIONAL"
  monitor_dimension = "SERVICE"

  tags = local.tags
}

resource "aws_ce_anomaly_subscription" "this" {
  count = var.enabled ? 1 : 0

  name      = "strata-${var.env_name}-cost-anomaly-sub"
  frequency = var.anomaly_frequency

  monitor_arn_list = [aws_ce_anomaly_monitor.this[0].arn]

  subscriber {
    type    = "EMAIL"
    address = var.cost_alert_email
  }

  threshold_expression {
    dimension {
      key           = "ANOMALY_TOTAL_IMPACT_ABSOLUTE"
      values        = [tostring(var.anomaly_threshold_amount)]
      match_options = ["GREATER_THAN_OR_EQUAL"]
    }
  }

  tags = local.tags
}
