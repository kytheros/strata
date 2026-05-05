variable "env_name" {
  description = "Environment short name (dev|staging|prod). Used in resource naming and tags."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.env_name)
    error_message = "env_name must be one of: dev, staging, prod."
  }
}

variable "aws_region" {
  description = "AWS region. Used to scope the CloudWatch Logs KMS key policy condition (logs.<region>.amazonaws.com) so the per-cluster CMK only signs encrypted log writes for log groups in this region."
  type        = string
  default     = "us-east-1"
}

variable "fargate_spot_weight" {
  description = "Weight (0-100) given to FARGATE_SPOT in the default capacity provider strategy. The remainder (100 - weight) is allocated to FARGATE on-demand. Default 80 favors spot for portfolio-demo cost savings; bump toward 0 for production workloads with strict task-stability needs. Ignored entirely if var.capacity_provider_strategy is supplied."
  type        = number
  default     = 80

  validation {
    condition     = var.fargate_spot_weight >= 0 && var.fargate_spot_weight <= 100
    error_message = "fargate_spot_weight must be between 0 and 100 (inclusive)."
  }
}

variable "capacity_provider_strategy" {
  description = "Optional explicit default capacity provider strategy. If null (default), the module computes a 2-entry strategy from var.fargate_spot_weight (FARGATE_SPOT = weight, FARGATE = 100 - weight, both base = 0). Supply this to override — e.g. add a non-zero base for guaranteed on-demand floor, or invert spot/on-demand split per service."
  type = list(object({
    capacity_provider = string
    weight            = number
    base              = number
  }))
  default = null

  validation {
    condition = var.capacity_provider_strategy == null || alltrue([
      for s in coalesce(var.capacity_provider_strategy, []) :
      contains(["FARGATE", "FARGATE_SPOT"], s.capacity_provider)
    ])
    error_message = "capacity_provider_strategy entries must reference FARGATE or FARGATE_SPOT only — no EC2 capacity providers in this module."
  }
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention for the cluster's log group. 30 days balances cost vs. incident-investigation horizon; bump to 90+ if compliance requires."
  type        = number
  default     = 30

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1827, 3653], var.log_retention_days)
    error_message = "log_retention_days must be a CloudWatch-supported value (1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1827, 3653)."
  }
}

variable "kms_deletion_window_days" {
  description = "Deletion window (days) for the per-cluster CMK on destroy. 7 is the AWS minimum and matches the portfolio-demo cycle cadence — a longer window leaves the key billable in PendingDeletion state across destroy/recreate cycles. Bump to 30 for production to give a recovery buffer."
  type        = number
  default     = 7

  validation {
    condition     = var.kms_deletion_window_days >= 7 && var.kms_deletion_window_days <= 30
    error_message = "kms_deletion_window_days must be between 7 and 30 (AWS-enforced bounds)."
  }
}

variable "extra_tags" {
  description = "Additional tags merged into the default tag set."
  type        = map(string)
  default     = {}
}
