variable "env_name" {
  description = "Environment short name (dev|staging|prod). Used in resource naming and tags."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.env_name)
    error_message = "env_name must be one of: dev, staging, prod."
  }
}

variable "aws_region" {
  description = "AWS region. Used to scope KMS key policy conditions and dashboard widget regions."
  type        = string
  default     = "us-east-1"
}

###############################################################################
# Log groups + EMF metric filters
###############################################################################

variable "service_log_groups" {
  description = "Additional service-specific CloudWatch log groups to provision. The cluster log group (/ecs/strata-<env>) is owned by AWS-1.2 (ecs-cluster) and is consumed via var.cluster_log_group_name; this variable is for per-service or per-component groups beyond the cluster default. Each entry: { name = '/strata/<env>/<service>', retention_days (1..3653, must be CloudWatch-supported), kms_key_arn (string, '' = AWS-managed key) }."
  type = list(object({
    name           = string
    retention_days = number
    kms_key_arn    = string
  }))
  default = []

  validation {
    condition = alltrue([
      for g in var.service_log_groups :
      contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1827, 3653], g.retention_days)
    ])
    error_message = "Each service_log_groups[*].retention_days must be a CloudWatch-supported value (1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1827, 3653)."
  }
}

variable "cluster_log_group_name" {
  description = "Name of the existing ECS cluster log group (e.g. /ecs/strata-dev) created by AWS-1.2. Pass through to allow EMF metric filters to attach to it. Empty string disables cluster-group EMF wiring."
  type        = string
  default     = ""
}

variable "metric_filters" {
  description = "EMF / pattern metric filters to attach to log groups owned by this module or by the cluster. Each entry: { log_group = '<name>', name = 'mcp-tool-call-count', pattern = '{ $.event = \"tool_call\" }', namespace = 'Strata/MCP', metric_name = 'ToolCallCount', metric_value = '1', dimensions = { Tool = '$.tool' } }. Pattern uses the CloudWatch Logs filter language; dimensions map output dimension names → JSON pointer references in the log event."
  type = list(object({
    log_group    = string
    name         = string
    pattern      = string
    namespace    = string
    metric_name  = string
    metric_value = string
    dimensions   = map(string)
  }))
  default = []
}

###############################################################################
# SNS alarm topic + subscribers
###############################################################################

variable "alarm_subscribers" {
  description = "Subscribers to add to the alarm SNS topic. Each entry: { protocol = 'email'|'sms'|'https'|'lambda', endpoint = '<address>' }. Default empty — caller adds. For 'email', SNS sends a confirmation message that the recipient must accept before alerts are delivered."
  type = list(object({
    protocol = string
    endpoint = string
  }))
  default = []

  validation {
    condition = alltrue([
      for s in var.alarm_subscribers :
      contains(["email", "sms", "https", "lambda"], s.protocol)
    ])
    error_message = "alarm_subscribers[*].protocol must be one of: email, sms, https, lambda."
  }
}

variable "kms_deletion_window_days" {
  description = "Deletion window (days) for the SNS-topic CMK on destroy. 7 is the AWS minimum and matches the portfolio-demo cycle cadence. Bump to 30 for production."
  type        = number
  default     = 7

  validation {
    condition     = var.kms_deletion_window_days >= 7 && var.kms_deletion_window_days <= 30
    error_message = "kms_deletion_window_days must be between 7 and 30 (AWS-enforced bounds)."
  }
}

###############################################################################
# Alarm targets — every entry is a string ARN / identifier supplied by the
# consumer module. Empty defaults mean "this alarm is not created" — keeps the
# module composable when only some upstream resources exist (per-phase rollout).
###############################################################################

variable "alb_arn" {
  description = "Full ARN of the ALB (e.g. arn:aws:elasticloadbalancing:...:loadbalancer/app/strata-dev/abc123). When non-empty, ALB 5xx-rate and p99-latency alarms are created. Empty disables both."
  type        = string
  default     = ""
}

variable "alb_arn_suffix" {
  description = "ALB ARN suffix used as the LoadBalancer dimension on CloudWatch ALB metrics (e.g. 'app/strata-dev/abc123' — the part of the ARN after :loadbalancer/). Required when alb_arn is non-empty; the AWS provider can derive this from the ALB resource as `aws_lb.this.arn_suffix`."
  type        = string
  default     = ""
}

variable "ecs_cluster_arn" {
  description = "Full ARN of the ECS cluster. When non-empty (and ecs_service_names non-empty), per-service task-shortfall alarms are created."
  type        = string
  default     = ""
}

variable "ecs_cluster_name" {
  description = "Short name of the ECS cluster (e.g. strata-dev). Used for the ClusterName dimension on ECS metrics. Required when ecs_cluster_arn is non-empty."
  type        = string
  default     = ""
}

variable "ecs_service_names" {
  description = "Map of caller-chosen static label -> ECS service short name within ecs_cluster_arn to alarm on for task shortfall. Pair with `var.ecs_service_labels` (static literal key list). Values can be unknown until apply (`module.X.service_name` is 'known after apply' on aws_ecs_service.this). Empty map disables ECS task-shortfall alarms."
  type        = map(string)
  default     = {}
}

variable "ecs_service_labels" {
  description = "Static literal list of labels matching the keys of var.ecs_service_names. MUST be a literal at the call site (e.g. [\"strata\", \"example-agent\"]) so `for_each` can plan even when service-name values are unknown until apply."
  type        = list(string)
  default     = []
}

variable "ecs_alarms_enabled" {
  description = "Static toggle that mirrors `length(var.ecs_service_names) > 0 && var.ecs_cluster_arn != \"\"` from the caller's perspective. Required because Terraform's `for_each` cannot key off a map whose size is only known after apply. Set true when wiring ECS services from another module; default false."
  type        = bool
  default     = false
}

variable "aurora_cluster_arn" {
  description = "Full ARN of the Aurora cluster. When non-empty, ACU-max and CPU-high alarms are created."
  type        = string
  default     = ""
}

variable "aurora_alarms_enabled" {
  description = "Static toggle that mirrors `var.aurora_cluster_arn != \"\"` from the caller's perspective. Required because Terraform's `count` cannot key off a string only known after apply (the orchestrator wires `module.aurora_postgres.cluster_arn`). Set true when you ARE wiring the Aurora cluster; default false. When false, the module falls back to inspecting the strings (works for callers that hard-code an ARN)."
  type        = bool
  default     = false
}

variable "aurora_cluster_identifier" {
  description = "DBClusterIdentifier (short name) for the Aurora cluster. Used as the DBClusterIdentifier dimension on RDS metrics. Required when aurora_cluster_arn is non-empty."
  type        = string
  default     = ""
}

variable "aurora_acu_alarm_threshold" {
  description = "ServerlessDatabaseCapacity threshold (ACU) above which the aurora_acu_max alarm fires. Default 6 ACU sits just below the design max of 8 — gives early warning before we hit the cap. Tune up for production once steady-state load is known."
  type        = number
  default     = 6

  validation {
    condition     = var.aurora_acu_alarm_threshold >= 0.5 && var.aurora_acu_alarm_threshold <= 256
    error_message = "aurora_acu_alarm_threshold must be within Aurora Serverless v2's supported ACU range (0.5..256)."
  }
}

variable "redis_cache_arn" {
  description = "Full ARN of the ElastiCache (Serverless) Redis cache. When non-empty, CPU-high and storage-high alarms are created."
  type        = string
  default     = ""
}

variable "redis_alarms_enabled" {
  description = "Static toggle mirroring `var.redis_cache_arn != \"\"` from the caller's perspective. Required because Terraform's `count` cannot key off a string only known after apply. Set true when wiring the Redis cache; default false."
  type        = bool
  default     = false
}

variable "redis_cache_name" {
  description = "Short name of the ElastiCache cache (e.g. strata-dev-redis). Used as the CacheClusterId dimension. Required when redis_cache_arn is non-empty."
  type        = string
  default     = ""
}

variable "redis_max_data_storage_bytes" {
  description = "Provisioned data-storage cap (bytes) for the Redis cache. The redis_storage_high alarm fires at 80% of this value. Default 1 GiB matches ElastiCache Serverless's 1-GiB default minimum. Override to the real cap of your cache."
  type        = number
  default     = 1073741824 # 1 GiB
}

variable "nat_gateway_ids" {
  description = "Map of stable label -> NAT Gateway ID for which to create a 3-sigma anomaly alarm on BytesOutToDestination. Catches design Risk #3. Pair with `var.nat_gateway_labels` (static literal key list). Values can be unknown until apply. Empty map disables the anomaly alarm."
  type        = map(string)
  default     = {}
}

variable "nat_gateway_labels" {
  description = "Static literal list of labels matching the keys of var.nat_gateway_ids. MUST be a literal at the call site (e.g. [\"az-a\", \"az-b\"]) so `for_each` can plan even when gateway-ID values are unknown until apply."
  type        = list(string)
  default     = []
}

variable "cognito_user_pool_id" {
  description = "User Pool ID (e.g. us-east-1_AbCdEf123). When non-empty, the auth-failure-rate alarm is created. Catches design Risk #1 — Cognito → Strata claims drift surfacing as auth-throttle spikes."
  type        = string
  default     = ""
}

variable "cognito_alarms_enabled" {
  description = "Static toggle mirroring `var.cognito_user_pool_id != \"\"` from the caller's perspective. Required because Terraform's `count` cannot key off a string only known after apply. Set true when wiring the Cognito user pool; default false."
  type        = bool
  default     = false
}

variable "nat_anomaly_enabled" {
  description = "Static toggle mirroring `length(var.nat_gateway_ids) > 0` from the caller's perspective. Required because Terraform's `for_each` cannot key off a map whose size is only known after apply. Set true when wiring NAT gateway IDs from `module.network`; default false."
  type        = bool
  default     = false
}

###############################################################################
# Phase 4 — Ops dashboard + JWT authorizer error rate.
#
# The ops dashboard is a separate, more comprehensive view alongside the SLO
# dashboard (which stays slim and SLO-focused). It is gated on var.enable_ops_dashboard
# so consumers without API GW / NLB still get the SLO dashboard cleanly.
#
# The JWT auth-error metric filter scans the API GW access log for non-empty
# `authError` fields (added in AWS-1.6.4) and emits a Strata/Auth namespace
# metric. The dashboard's auth-funnel widget plots this; the JWT-error-rate
# alarm pages on sustained breaches.
###############################################################################

variable "enable_ops_dashboard" {
  description = "When true, provision the strata-<env>-ops dashboard (Phase 4 / AWS-4.1) alongside the existing SLO dashboard. The ops dashboard surfaces ECS per-service utilization, API GW request/error/latency mix, NLB flows + healthy-host counts, Aurora ACU/conns/replica-lag, Redis Serverless usage, NAT egress, VPC endpoint usage, and the JWT authentication funnel. Default false to keep the module's surface backwards-compatible — orchestrators flip this on once API GW + NLB IDs are wired."
  type        = bool
  default     = false
}

variable "apigw_api_id" {
  description = "API Gateway HTTP API ID (e.g. abc123def). Used as the ApiId dimension on AWS/ApiGateway metrics in the ops dashboard. Empty string disables the API-GW widgets."
  type        = string
  default     = ""
}

variable "apigw_log_group_name" {
  description = "CloudWatch Logs group name receiving API GW access logs (the format that AWS-1.6.4 added the `sub` / `authError` fields to). When non-empty, this module attaches a metric filter for JWT-authorizer errors and a counterpart filter for total requests, both in var.apigw_metric_namespace. The dashboard's auth-funnel widget keys off these metrics, and the jwt_auth_error_rate alarm pages on sustained breach."
  type        = string
  default     = ""
}

variable "apigw_metric_namespace" {
  description = "CloudWatch metrics namespace for the JWT-error metric filters this module emits when var.apigw_log_group_name is set. Default `Strata/Auth` keeps the auth-related metrics in their own namespace separate from the AWS/* service namespaces."
  type        = string
  default     = "Strata/Auth"
}

variable "jwt_auth_error_rate_threshold" {
  description = "Percentage threshold for the JWT-authorizer error-rate alarm. Fires when (jwt_errors / total_requests) * 100 exceeds this for 3 consecutive 5-minute periods (2 of 3 must breach). Default 5% catches sustained client-side misconfig or brute force without paging on legitimate token-expiry blips."
  type        = number
  default     = 5

  validation {
    condition     = var.jwt_auth_error_rate_threshold > 0 && var.jwt_auth_error_rate_threshold <= 100
    error_message = "jwt_auth_error_rate_threshold must be a percent in (0, 100]."
  }
}

variable "nlb_arn_suffix" {
  description = "ARN suffix of the internal NLB (the part after `:loadbalancer/`, e.g. `net/strata-dev-mcp-nlb/abc123`). Used as the LoadBalancer dimension on AWS/NetworkELB metrics in the ops dashboard. Empty string disables NLB widgets."
  type        = string
  default     = ""
}

variable "nlb_target_group_arn_suffix" {
  description = "ARN suffix of the NLB target group (the part after `:targetgroup/`, e.g. `targetgroup/strata-dev-mcp-tg/abc123`). Used as the TargetGroup dimension on AWS/NetworkELB metrics in the ops dashboard. Empty string disables target-group widgets."
  type        = string
  default     = ""
}

variable "strata_service_name" {
  description = "ECS service short name for the Strata service (e.g. `strata-dev`). Used as the ServiceName dimension on the ops dashboard's per-service ECS widgets. Empty string causes those panels to render with placeholder dimensions and 'no data'."
  type        = string
  default     = ""
}

variable "example_agent_service_name" {
  description = "ECS service short name for the example-agent service (e.g. `example-agent-dev`). Used as the ServiceName dimension on the ops dashboard's per-service ECS widgets. Empty string causes those panels to render with placeholder dimensions and 'no data'."
  type        = string
  default     = ""
}

###############################################################################
# Misc
###############################################################################

variable "runbook_base_url" {
  description = "Base URL prepended to alarm runbook references in alarm_description. Each alarm's description ends with `Runbook: <runbook_base_url>/<alarm-name>.md`. Default points at the in-repo runbooks/ directory; override to a hosted runbook URL when the team has one."
  type        = string
  default     = "https://github.com/kytheros/strata/blob/main/templates/aws/runbooks"
}

variable "extra_tags" {
  description = "Additional tags merged into the default tag set."
  type        = map(string)
  default     = {}
}
