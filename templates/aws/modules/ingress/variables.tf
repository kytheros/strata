###############################################################################
# strata ingress — variable surface
#
# The module is a "one-flag swap" between two backends:
#
#   backend = "apigw"  → HTTP API Gateway + VPC Link + (optional) Cognito JWT
#                        authorizer. ~$0/mo idle, $1/M req. Default for dev.
#   backend = "alb"    → internet-facing Application Load Balancer with HTTPS
#                        listener, optional Cognito-protected listener rules,
#                        and an optional CloudFront-prefix-list-only ingress
#                        policy. ~$16/mo idle + LCU charges. Default for
#                        staging/prod (set in env tfvars, not here).
#
# var.backend has NO default — env tfvars must opt in explicitly. Outputs are
# unified across backends; consumer modules don't branch on the backend value.
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
  description = "AWS region. Used to construct the Cognito issuer URL when wiring the API GW JWT authorizer."
  type        = string
  default     = "us-east-1"
}

variable "backend" {
  description = "Ingress backend — \"apigw\" (HTTP API Gateway) or \"alb\" (Application Load Balancer). Per design §\"Dev tier\": dev = apigw ($0 idle), staging/prod = alb (supports SSE/WebSockets + ECS target groups). No default — env tfvars must set this explicitly."
  type        = string

  validation {
    condition     = contains(["apigw", "alb"], var.backend)
    error_message = "backend must be \"apigw\" or \"alb\"."
  }
}

variable "vpc_id" {
  description = "VPC the ingress lives in. Used by the ALB security group and (for apigw) the VPC Link's security group / subnet anchoring."
  type        = string
}

variable "vpc_cidr" {
  description = "VPC CIDR block. Used as the destination CIDR for the ALB-egress rule (target-traffic to ECS) and as the ingress CIDR for the apigw VPC-link default security group."
  type        = string

  validation {
    condition     = can(cidrnetmask(var.vpc_cidr))
    error_message = "vpc_cidr must be a valid IPv4 CIDR block (e.g. 10.40.0.0/16)."
  }
}

variable "public_subnet_ids" {
  description = "Public subnet IDs the ALB attaches to (one per AZ). Required when backend=\"alb\"; ignored for apigw."
  type        = list(string)
  default     = []
}

variable "private_subnet_ids" {
  description = "Private subnet IDs the apigw VPC Link attaches to (one per AZ). Required when backend=\"apigw\"; ignored for alb."
  type        = list(string)
  default     = []
}

# ----------------------------------------------------------------------------
# ALB-only knobs
# ----------------------------------------------------------------------------

variable "internal" {
  description = "When backend=\"alb\", set to true to create an internal-scheme ALB. Default false (internet-facing). Ignored for apigw."
  type        = bool
  default     = false
}

variable "acm_certificate_arn" {
  description = "ACM certificate ARN attached to the HTTPS listener. Required when backend=\"alb\"; ignored for apigw. The cert is provisioned externally — this module does not create or validate certificates."
  type        = string
  default     = ""
}

variable "deletion_protection" {
  description = "ALB deletion protection. Default false in dev; staging/prod tfvars should set true. Ignored for apigw."
  type        = bool
  default     = false
}

variable "access_logs_bucket" {
  description = "S3 bucket name for ALB access logs. Empty disables access logging. Ignored for apigw. The bucket policy must already grant the AWS-managed ALB-log-delivery principal — see README §\"ALB access logs\"."
  type        = string
  default     = ""
}

variable "access_logs_prefix" {
  description = "Prefix within var.access_logs_bucket for ALB access log objects. Empty writes to the bucket root."
  type        = string
  default     = ""
}

variable "restrict_to_cloudfront_prefix_list" {
  description = "When backend=\"alb\" and the ALB sits behind CloudFront (per design §\"Edge\"), set to true to scope the 443 ingress rule to the AWS-managed CloudFront origin-facing prefix list (com.amazonaws.global.cloudfront.origin-facing). Default false — for direct-access ALBs and dev. Ignored for apigw."
  type        = bool
  default     = false
}

variable "alb_idle_timeout_seconds" {
  description = "ALB connection idle timeout. 60s default matches the AWS default; bump to 300+ for SSE/long-poll endpoints (per design §\"CloudFront fronts the ALB\"). Ignored for apigw."
  type        = number
  default     = 60

  validation {
    condition     = var.alb_idle_timeout_seconds >= 1 && var.alb_idle_timeout_seconds <= 4000
    error_message = "alb_idle_timeout_seconds must be between 1 and 4000."
  }
}

variable "ssl_policy" {
  description = "ALB HTTPS listener SSL policy. TLS-1.3-1.2-2021-06 is the strongest broadly-supported policy at AWS. Ignored for apigw."
  type        = string
  default     = "ELBSecurityPolicy-TLS13-1-2-2021-06"
}

# ----------------------------------------------------------------------------
# Cognito wiring (used by both backends, in different ways)
# ----------------------------------------------------------------------------

variable "cognito_user_pool_id" {
  description = "Cognito User Pool ID. When set with backend=\"apigw\", a JWT authorizer is created. Empty disables Cognito wiring."
  type        = string
  default     = ""
}

variable "cognito_user_pool_client_id" {
  description = "Cognito App Client ID. Used as the JWT audience (apigw) and the authenticate_cognito client_id (alb)."
  type        = string
  default     = ""
}

variable "cognito_user_pool_arn" {
  description = "Cognito User Pool ARN. Required by the alb authenticate_cognito action; ignored for apigw (which uses cognito_user_pool_id to construct the issuer)."
  type        = string
  default     = ""
}

variable "cognito_user_pool_domain" {
  description = "Cognito hosted-UI domain prefix (just the prefix, not the FQDN). Required by the alb authenticate_cognito action; ignored for apigw."
  type        = string
  default     = ""
}

variable "cognito_protected_paths" {
  description = "List of ALB listener-rule path patterns that require Cognito-authenticated access. Each generates an aws_lb_listener_rule with authenticate_cognito + a fixed-response 401 fallback. Ignored for apigw — apigw uses route-level authorizer attachment, which the consumer wires when creating routes."
  type        = list(string)
  default     = []
}

# ----------------------------------------------------------------------------
# API GW-only knobs
# ----------------------------------------------------------------------------

variable "cors_config" {
  description = "CORS config for the apigw HTTP API. Default is permissive to keep dev unblocked; prod tfvars should constrain allow_origins. Ignored for alb."
  type = object({
    allow_origins     = optional(list(string), ["*"])
    allow_methods     = optional(list(string), ["*"])
    allow_headers     = optional(list(string), ["*"])
    expose_headers    = optional(list(string), [])
    max_age           = optional(number, 0)
    allow_credentials = optional(bool, false)
  })
  default = {}
}

variable "vpc_link_security_group_ids" {
  description = "Security groups attached to the apigw VPC Link ENIs. Empty defaults to a module-created SG that allows everything from the VPC CIDR. Ignored for alb."
  type        = list(string)
  default     = []
}

variable "enable_logging" {
  description = "Create a CloudWatch log group for API GW execution logs (apigw only). Ignored for alb (use var.access_logs_bucket instead)."
  type        = bool
  default     = true
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention for the apigw execution-log group. Ignored when enable_logging=false or backend=alb."
  type        = number
  default     = 30

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1827, 3653], var.log_retention_days)
    error_message = "log_retention_days must be a CloudWatch-supported value (1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1827, 3653)."
  }
}

# ----------------------------------------------------------------------------
# Tagging
# ----------------------------------------------------------------------------

variable "extra_tags" {
  description = "Additional tags merged into the default tag set."
  type        = map(string)
  default     = {}
}
