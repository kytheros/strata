variable "env_name" {
  description = "Environment short name (dev|staging|prod). Used in resource naming and tags."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.env_name)
    error_message = "env_name must be one of: dev, staging, prod."
  }
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC. Per design §Network: dev=10.40.0.0/16, staging=10.41.0.0/16, prod=10.42.0.0/16. /16 carves cleanly into 3 AZs × 3 tiers (public /24, private /20, isolated /22) with room left over."
  type        = string
  default     = "10.40.0.0/16"

  validation {
    condition     = can(cidrnetmask(var.vpc_cidr))
    error_message = "vpc_cidr must be a valid IPv4 CIDR block (e.g. 10.40.0.0/16)."
  }
}

variable "aws_region" {
  description = "AWS region. Subnets and AZs are scoped to this region."
  type        = string
  default     = "us-east-1"
}

variable "availability_zones" {
  description = "Three availability zones to spread subnets across. Order matters: index 0 hosts NAT-a (and AZ-c falls back to it), index 1 hosts NAT-b, index 2 routes to NAT-a."
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b", "us-east-1c"]

  validation {
    condition     = length(var.availability_zones) == 3
    error_message = "Exactly 3 availability zones are required by the subnet/NAT layout."
  }
}

variable "flow_log_retention_days" {
  description = "CloudWatch Logs retention for VPC flow logs. 30 days balances cost vs. incident-investigation horizon; bump to 90+ if compliance requires."
  type        = number
  default     = 30

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1827, 3653], var.flow_log_retention_days)
    error_message = "flow_log_retention_days must be a CloudWatch-supported value (1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1827, 3653)."
  }
}

variable "extra_tags" {
  description = "Additional tags merged into the default tag set."
  type        = map(string)
  default     = {}
}
