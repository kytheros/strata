###############################################################################
# services/cost-anomaly -- Cost Anomaly Detection (AWS-5.1)
#
# Two Cost Explorer resources:
#   1. aws_ce_anomaly_monitor  -- DIMENSIONAL, watches all AWS services.
#   2. aws_ce_anomaly_subscription -- absolute threshold, weekly digest.
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
  name              = "strata-${var.env_name}-all-services"
  monitor_type      = "DIMENSIONAL"
  monitor_dimension = "SERVICE"

  tags = local.tags
}

resource "aws_ce_anomaly_subscription" "this" {
  name      = "strata-${var.env_name}-cost-anomaly-sub"
  frequency = var.anomaly_frequency

  monitor_arn_list = [aws_ce_anomaly_monitor.this.arn]

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
