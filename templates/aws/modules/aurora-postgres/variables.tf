variable "env_name" {
  description = "Environment short name (dev|staging|prod). Used in resource naming and tags."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.env_name)
    error_message = "env_name must be one of: dev, staging, prod."
  }
}

variable "aws_region" {
  description = "AWS region. Used for the kms:ViaService condition on the cluster CMK."
  type        = string
  default     = "us-east-1"
}

variable "vpc_id" {
  description = "ID of the VPC the cluster security group is attached to. Typically the network module's vpc_id output."
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
  description = "List of subnet IDs the DB subnet group spans. Pass the network module's isolated_subnet_ids — Aurora must not have an internet path. Minimum two subnets required by Aurora; this module deploys across all that are passed (typically three)."
  type        = list(string)

  validation {
    condition     = length(var.subnet_ids) >= 2
    error_message = "subnet_ids must contain at least two subnets (Aurora requires multi-AZ subnet groups)."
  }
}

variable "allowed_security_group_ids" {
  description = "Optional list of security-group IDs that may reach the cluster on TCP/5432. Preferred over CIDR-based ingress. When empty (the default) the module falls back to ingress from var.vpc_cidr — useful for an example deploy without a real consumer SG yet. Production callers should pass the consuming service SGs explicitly."
  type        = list(string)
  default     = []
}

variable "engine_version" {
  description = "Aurora PostgreSQL major.minor version. 15.x is the current Strata target. Aurora Serverless v2 supports 13.x+; 15.x is the active default. Change tracks the AWS-published `DescribeDBEngineVersions` list — pin a value here rather than letting AWS auto-select to keep plans stable."
  type        = string
  default     = "15.13"
}

variable "min_capacity" {
  description = "Aurora Serverless v2 minimum ACU. AWS provider 5.92+ (Feb 2025) supports min_capacity = 0 (scale-to-zero) when paired with seconds_until_auto_pause. Older providers require min_capacity >= 0.5 and have no auto-pause field. Dev defaults to 0 (scale-to-zero); prod typically uses 0.5 to avoid cold-start tail latency on the first request after idle."
  type        = number
  default     = 0

  validation {
    condition     = var.min_capacity >= 0 && var.min_capacity <= 256
    error_message = "min_capacity must be between 0 and 256 ACU."
  }
}

variable "max_capacity" {
  description = "Aurora Serverless v2 maximum ACU. Hard cap on burst scale-up. Dev: 8 (sufficient for any single-tester workload). Prod: tune to expected p99 load — each ACU ≈ 2 GiB memory + matched CPU/network."
  type        = number
  default     = 8

  validation {
    condition     = var.max_capacity >= 1 && var.max_capacity <= 256
    error_message = "max_capacity must be between 1 and 256 ACU."
  }
}

variable "seconds_until_auto_pause" {
  description = "Idle duration (in seconds) before Aurora Serverless v2 auto-pauses to scale-to-zero. Only meaningful when min_capacity = 0; ignored otherwise. AWS-supported range: 300 (5 min) to 86400 (24 hr). Dev default 1800 (30 min) — short enough that idle hours pause cleanly, long enough that brief test-suite gaps don't cycle. Set to null in prod to disable auto-pause."
  type        = number
  default     = 1800

  validation {
    condition     = var.seconds_until_auto_pause == null || (var.seconds_until_auto_pause >= 300 && var.seconds_until_auto_pause <= 86400)
    error_message = "seconds_until_auto_pause must be null OR between 300 and 86400 seconds (5 min – 24 hr)."
  }
}

variable "instance_count" {
  description = "Number of Aurora cluster instances (writer + readers). 1 is dev-default (writer only). Production should use 2+ for HA — Aurora Serverless v2 promotes a reader to writer in ~30s on AZ failure, but only if a reader exists."
  type        = number
  default     = 1

  validation {
    condition     = var.instance_count >= 1 && var.instance_count <= 15
    error_message = "instance_count must be between 1 and 15 (Aurora cluster instance limit)."
  }
}

variable "database_name" {
  description = "Initial database name created on cluster bootstrap. Lowercase letters, digits, underscores. Cannot be changed after creation without a snapshot-restore cycle."
  type        = string
  default     = "strata"

  validation {
    condition     = can(regex("^[a-z][a-z0-9_]{0,62}$", var.database_name))
    error_message = "database_name must start with a lowercase letter and contain only lowercase letters, digits, and underscores (max 63 chars)."
  }
}

variable "master_username" {
  description = "Master DB user name. AWS auto-generates the password and stores it in Secrets Manager (manage_master_user_password = true). The username itself is not sensitive."
  type        = string
  default     = "strata_admin"

  validation {
    condition     = can(regex("^[a-z][a-z0-9_]{0,62}$", var.master_username))
    error_message = "master_username must start with a lowercase letter and contain only lowercase letters, digits, and underscores."
  }
}

variable "backup_retention_period" {
  description = "Number of days to retain automated backups. AWS minimum is 1, maximum is 35. Dev defaults to 1 (cycling cadence makes longer retention wasteful); production should use 7+ to cover a full incident-investigation window."
  type        = number
  default     = 1

  validation {
    condition     = var.backup_retention_period >= 1 && var.backup_retention_period <= 35
    error_message = "backup_retention_period must be between 1 and 35 days."
  }
}

variable "preferred_backup_window" {
  description = "Daily time range during which automated backups are taken. Format: HH:MM-HH:MM (UTC). Default 03:00-04:00 (10–11pm ET) avoids US business hours."
  type        = string
  default     = "03:00-04:00"
}

variable "preferred_maintenance_window" {
  description = "Weekly time range for maintenance. Format: ddd:HH:MM-ddd:HH:MM (UTC). Default Sunday 04:30-05:30 follows backup window."
  type        = string
  default     = "sun:04:30-sun:05:30"
}

variable "skip_final_snapshot" {
  description = "Skip the final snapshot when the cluster is destroyed. Dev: true (destroy-friendly cycling). Prod: false — terraform destroy must always leave a snapshot behind."
  type        = bool
  default     = true
}

variable "deletion_protection" {
  description = "Block accidental terraform destroy / aws delete-db-cluster. Dev: false (cycling). Prod: true."
  type        = bool
  default     = false
}

variable "apply_immediately" {
  description = "Apply parameter and infrastructure changes immediately rather than during the next maintenance window. Dev: true (faster iteration). Prod: false (controlled change windows)."
  type        = bool
  default     = true
}

variable "performance_insights_retention_period" {
  description = "Days of Performance Insights data to retain. 7 is the free tier; 31, 93, 186, 372, 731 require paid tier. Dev sticks to the free tier."
  type        = number
  default     = 7

  validation {
    condition     = contains([7, 31, 93, 186, 372, 731], var.performance_insights_retention_period)
    error_message = "performance_insights_retention_period must be one of 7, 31, 93, 186, 372, 731 (AWS-supported values)."
  }
}

variable "proxy_idle_client_timeout" {
  description = "RDS Proxy idle client timeout in seconds. Connections idle longer than this are closed. AWS range: 1 to 28800. Default 1800 (30 min) matches Aurora's auto-pause window in dev."
  type        = number
  default     = 1800

  validation {
    condition     = var.proxy_idle_client_timeout >= 1 && var.proxy_idle_client_timeout <= 28800
    error_message = "proxy_idle_client_timeout must be between 1 and 28800 seconds."
  }
}

variable "proxy_max_connections_percent" {
  description = "RDS Proxy max % of cluster connections it will hold open. 50 leaves headroom for direct (non-proxy) admin connections. Bump to 75–100 only when no admin tooling bypasses the proxy."
  type        = number
  default     = 50

  validation {
    condition     = var.proxy_max_connections_percent >= 1 && var.proxy_max_connections_percent <= 100
    error_message = "proxy_max_connections_percent must be between 1 and 100."
  }
}

variable "extra_tags" {
  description = "Additional tags merged into the default tag set."
  type        = map(string)
  default     = {}
}
