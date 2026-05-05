variable "env_name" {
  description = "Environment short name (dev|staging|prod). Used in resource naming and tags."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.env_name)
    error_message = "env_name must be one of: dev, staging, prod."
  }
}

variable "aws_region" {
  description = "AWS region. Used for the kms:ViaService condition on the at-rest CMK."
  type        = string
  default     = "us-east-1"
}

variable "vpc_id" {
  description = "ID of the VPC the cache security group is attached to. Typically the network module's vpc_id output."
  type        = string

  validation {
    condition     = can(regex("^vpc-[0-9a-f]+$", var.vpc_id))
    error_message = "vpc_id must look like vpc-xxxxxxxx."
  }
}

variable "vpc_cidr" {
  description = "CIDR block of the VPC. Used as a fallback ingress source when var.allowed_security_group_ids is empty. Typically the network module's vpc_cidr output."
  type        = string

  validation {
    condition     = can(cidrnetmask(var.vpc_cidr))
    error_message = "vpc_cidr must be a valid IPv4 CIDR block."
  }
}

variable "subnet_ids" {
  description = "List of subnet IDs the cache lives in. Pass the network module's isolated_subnet_ids — the cache must not have an internet path. Minimum two subnets required by ElastiCache; this module deploys across all that are passed (typically three)."
  type        = list(string)

  validation {
    condition     = length(var.subnet_ids) >= 2
    error_message = "subnet_ids must contain at least two subnets (ElastiCache requires multi-AZ subnet groups)."
  }
}

variable "allowed_security_group_ids" {
  description = "Optional list of security-group IDs that may reach the cache on TCP/6379. Preferred over CIDR-based ingress. When empty (the default) the module falls back to ingress from var.vpc_cidr — useful for an example deploy without a real consumer SG yet. Production callers should pass the consuming service SGs explicitly."
  type        = list(string)
  default     = []
}

variable "engine_version" {
  description = "Redis engine version. ElastiCache Serverless accepts a major version like '7' and pins to the current minor at apply time. Variable-overridable so a future Valkey swap (engine = 'valkey') is a one-flag change. Major engine version auto-upgrade is intentionally OFF — engine bumps are explicit."
  type        = string
  default     = "7"
}

variable "cache_usage_limits" {
  description = "Cache usage limits. data_storage_max_gb caps stored data (Serverless billing floor is ~1 GB-hr); ecpu_per_second_max caps request rate (1 ECPU = 1 simple GET/SET; complex commands use more). Dev defaults are tight by design — bump for prod."
  type = object({
    data_storage_max_gb = number
    ecpu_per_second_max = number
  })
  default = {
    data_storage_max_gb = 1
    ecpu_per_second_max = 5000
  }

  validation {
    condition     = var.cache_usage_limits.data_storage_max_gb >= 1 && var.cache_usage_limits.data_storage_max_gb <= 5000
    error_message = "data_storage_max_gb must be in [1, 5000] (ElastiCache Serverless API range)."
  }

  validation {
    condition     = var.cache_usage_limits.ecpu_per_second_max >= 1000 && var.cache_usage_limits.ecpu_per_second_max <= 15000000
    error_message = "ecpu_per_second_max must be in [1000, 15000000] (ElastiCache Serverless API range)."
  }
}

variable "daily_snapshot_retention_limit" {
  description = "Number of days to retain automatic daily snapshots. 0 disables automatic snapshots (not recommended). Dev defaults to 1 to minimize storage cost; bump to 7 for prod. Snapshot storage equal to cache data size is included free."
  type        = number
  default     = 1

  validation {
    condition     = var.daily_snapshot_retention_limit >= 0 && var.daily_snapshot_retention_limit <= 35
    error_message = "daily_snapshot_retention_limit must be in [0, 35] (AWS-enforced range)."
  }
}

variable "extra_tags" {
  description = "Additional tags merged into the default tag set."
  type        = map(string)
  default     = {}
}
