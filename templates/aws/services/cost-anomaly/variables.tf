###############################################################################
# services/cost-anomaly variables (AWS-5.1)
###############################################################################

variable "enabled" {
  description = "Master toggle for the dimensional Cost Explorer anomaly monitor + subscription. Default false. Background: AWS auto-creates a `Default-Services-Monitor` (DIMENSIONAL, SERVICE) per account and the soft limit on dimensional monitors is 1, so creating a second module-managed dimensional monitor fails with `Limit exceeded on dimensional spend monitor creation`. The strata-dev-cap manual AWS Budget is the real cost guard for dev. Flip to true (and pre-arrange a quota raise) only when you specifically want a higher-fidelity per-dev anomaly stream alongside the account-default monitor."
  type        = bool
  default     = false
}

variable "env_name" {
  description = "Environment short name (dev|staging|prod). Included in monitor + subscription names."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.env_name)
    error_message = "env_name must be one of: dev, staging, prod."
  }
}

variable "aws_region" {
  description = "AWS region. Passed through for tagging consistency; CE resources are global."
  type        = string
  default     = "us-east-1"
}

variable "cost_alert_email" {
  description = "Email that receives Cost Anomaly Detection alerts. SNS sends a confirmation the recipient must accept before alerts are delivered."
  type        = string

  validation {
    condition     = can(regex("^[^@]+@[^@]+[.][^@]+", var.cost_alert_email))
    error_message = "cost_alert_email must be a valid email address."
  }
}

variable "anomaly_threshold_amount" {
  description = "Absolute spend threshold (USD) above which the anomaly subscription fires. Default $5 catches a forgotten running resource before the bill climbs materially."
  type        = number
  default     = 5

  validation {
    condition     = var.anomaly_threshold_amount >= 1
    error_message = "anomaly_threshold_amount must be at least $1 USD."
  }
}

variable "anomaly_frequency" {
  description = "Notification frequency: DAILY, WEEKLY, or IMMEDIATE. Default WEEKLY for a dev account."
  type        = string
  default     = "WEEKLY"

  validation {
    condition     = contains(["DAILY", "WEEKLY", "IMMEDIATE"], var.anomaly_frequency)
    error_message = "anomaly_frequency must be one of: DAILY, WEEKLY, IMMEDIATE."
  }
}

variable "extra_tags" {
  description = "Additional tags merged onto taggable resources."
  type        = map(string)
  default     = {}
}
