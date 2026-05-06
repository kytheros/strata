###############################################################################
# services/canary (AWS-4.1) — input surface.
###############################################################################

variable "env_name" {
  description = "Environment short name (dev|staging|prod). Used in resource naming and tags."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.env_name)
    error_message = "env_name must be one of: dev, staging, prod."
  }
}

variable "aws_region" {
  description = "AWS region. Used in IAM policy conditions (kms:ViaService) and Lambda env."
  type        = string
  default     = "us-east-1"
}

variable "canary_enabled" {
  description = "Master toggle. When false, no Lambda / IAM role / EventBridge rule / alarm is created — only the test-user credentials secret is provisioned (so operators can stage credentials before turning the canary on). Default true; flip to false during initial bring-up before the test user exists, or while the stack is intentionally torn down for extended periods."
  type        = bool
  default     = true
}

###############################################################################
# Cognito user pool — supplied by the orchestrator (sourced via the example-
# agent composition, which owns the pool).
###############################################################################

variable "cognito_user_pool_id" {
  description = "Cognito User Pool ID (e.g. us-east-1_AbCdEf123). The Lambda calls AdminInitiateAuth against this pool."
  type        = string

  validation {
    condition     = length(var.cognito_user_pool_id) > 0
    error_message = "cognito_user_pool_id must be set — the canary cannot mint a token without it."
  }
}

variable "cognito_user_pool_arn" {
  description = "Full ARN of the Cognito User Pool. Used to scope the Lambda's IAM grant to AdminInitiateAuth on this pool only."
  type        = string

  validation {
    condition     = length(var.cognito_user_pool_arn) > 0
    error_message = "cognito_user_pool_arn must be set — required for the IAM grant."
  }
}

variable "cognito_user_pool_client_id" {
  description = "Cognito App Client ID for the test user. The client must permit ADMIN_USER_PASSWORD_AUTH. Recommended: a dedicated test-only client distinct from the production federation client."
  type        = string

  validation {
    condition     = length(var.cognito_user_pool_client_id) > 0
    error_message = "cognito_user_pool_client_id must be set."
  }
}

###############################################################################
# Target endpoint
###############################################################################

variable "mcp_endpoint_url" {
  description = "Full URL of the Strata MCP endpoint the canary POSTs to (e.g. https://abc123.execute-api.us-east-1.amazonaws.com/mcp). Wire this to `https://<module.ingress.endpoint_dns>/mcp` from the orchestrator."
  type        = string

  validation {
    condition     = can(regex("^https?://[^/]+/.+$", var.mcp_endpoint_url))
    error_message = "mcp_endpoint_url must be a fully-qualified URL with a path component (e.g. https://host/mcp)."
  }
}

variable "request_timeout_ms" {
  description = "Per-request timeout (milliseconds) the Lambda enforces on the POST /mcp call. Default 10000 (10s) leaves headroom on the Lambda's 30s execution timeout for the upstream Cognito call + response parse."
  type        = number
  default     = 10000

  validation {
    condition     = var.request_timeout_ms >= 1000 && var.request_timeout_ms <= 25000
    error_message = "request_timeout_ms must be between 1000 and 25000."
  }
}

###############################################################################
# Schedule + alarm thresholds
###############################################################################

variable "schedule_expression" {
  description = "EventBridge schedule expression. Default `rate(5 minutes)` matches the Phase 4 cadence in the design spec. Use `rate(15 minutes)` to drop cost further during low-importance windows."
  type        = string
  default     = "rate(5 minutes)"
}

variable "failure_threshold" {
  description = "Number of CANARY_FAIL events within a single 5-minute period that constitute a single 'breaching' datapoint for the alarm. Default 1 — any failure in a 5-min window is a datapoint."
  type        = number
  default     = 1
}

variable "failure_evaluation_periods" {
  description = "Number of 5-minute periods the alarm evaluates. Combined with failure_datapoints_to_alarm, the default 3/2 means: 'page if 2 of the last 3 5-min periods saw any failure' — tolerates a single transient blip but pages on sustained failure."
  type        = number
  default     = 3
}

variable "failure_datapoints_to_alarm" {
  description = "M of N: how many of the last failure_evaluation_periods periods must breach to trigger the alarm. Default 2 of 3."
  type        = number
  default     = 2
}

###############################################################################
# Wiring — observability + log retention
###############################################################################

variable "alarm_topic_arn" {
  description = "ARN of the existing SNS alarm topic (from `module.observability.alarm_topic_arn`). The canary's failure alarm publishes here so on-call sees it through the same fan-out as every other alarm in the stack."
  type        = string

  validation {
    condition     = length(var.alarm_topic_arn) > 0
    error_message = "alarm_topic_arn must be set — the canary's failure alarm has no other paging target."
  }
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention for the canary Lambda log group. Default 14 — the Lambda emits ~288 lines/day; 14 days is enough for incident triage and keeps cost minimal."
  type        = number
  default     = 14

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1827, 3653], var.log_retention_days)
    error_message = "log_retention_days must be a CloudWatch-supported value."
  }
}

variable "runbook_base_url" {
  description = "Base URL for runbooks referenced in alarm descriptions. Default points at the in-repo runbooks/ directory; override to a hosted URL when the team has one."
  type        = string
  default     = "https://github.com/kytheros/strata/blob/main/templates/aws/runbooks"
}

variable "extra_tags" {
  description = "Additional tags merged into the default tag set."
  type        = map(string)
  default     = {}
}
