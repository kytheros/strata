variable "env_name" {
  description = "Environment short name (dev|staging|prod). Used in resource naming and tags."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.env_name)
    error_message = "env_name must be one of: dev, staging, prod."
  }
}

variable "aws_region" {
  description = "AWS region. Used for the KMS key alias scoping comment in tags; the secret itself is region-bound by the calling provider."
  type        = string
  default     = "us-east-1"
}

variable "secret_name" {
  description = "Short, hierarchical name for the secret. Combined with env_name into the path-style identifier `strata/{env_name}/{secret_name}`. Lowercase letters, digits, hyphens, and forward-slashes only."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9-/]+$", var.secret_name))
    error_message = "secret_name must match ^[a-z0-9-/]+$ (lowercase letters, digits, hyphens, slashes)."
  }
}

variable "description" {
  description = "Human-readable description of what this secret is for. Required — the description shows up in Secrets Manager listings and is the only place an on-call engineer sees the purpose without dereferencing IaC."
  type        = string

  validation {
    condition     = length(var.description) > 0
    error_message = "description must not be empty."
  }
}

variable "kms_key_id" {
  description = "Optional. KMS key ID, ARN, or alias to encrypt the secret. When empty (the default) the module creates a per-secret CMK with rotation enabled. Pass an existing key ARN to share encryption across multiple secrets (e.g. one CMK per service)."
  type        = string
  default     = ""
}

variable "recovery_window_days" {
  description = "Number of days a deleted secret can be restored before AWS permanently destroys it. AWS minimum is 7. The module never exposes force_delete_without_recovery — accidental deletion of a rotated DB credential is too high a blast radius."
  type        = number
  default     = 7

  validation {
    condition     = var.recovery_window_days >= 7 && var.recovery_window_days <= 30
    error_message = "recovery_window_days must be between 7 and 30 (AWS-enforced range; immediate-delete is intentionally not exposed)."
  }
}

variable "create_initial_version" {
  description = "When true, create an initial AWSCURRENT version using var.initial_value. Use for bootstrap secrets like static API keys; leave false for secrets whose first value is written by a rotation Lambda (Aurora master credential pattern)."
  type        = bool
  default     = false
}

variable "initial_value" {
  description = "Initial secret string for the AWSCURRENT version. Only consumed when var.create_initial_version = true. Marked sensitive so it never lands in plan output. Acceptable values: any non-empty UTF-8 string (Secrets Manager treats it as opaque). Rotation Lambdas overwrite this on first run."
  type        = string
  default     = ""
  sensitive   = true
}

variable "rotation_lambda_arn" {
  description = "Optional. ARN of an existing Lambda function configured per the Secrets Manager rotation contract (https://docs.aws.amazon.com/secretsmanager/latest/userguide/rotating-secrets-lambda-function-overview.html). When set, the module attaches the Lambda as the rotator and grants it least-privilege access to this specific secret. When empty, no rotation is configured."
  type        = string
  default     = ""
}

variable "rotation_days" {
  description = "Number of days between automatic rotations. Only consumed when rotation_lambda_arn is non-empty. 30 is the AWS-recommended default for database credentials; bump to 90 for low-blast-radius static credentials, or down to 1 for force-rotate-on-deploy patterns."
  type        = number
  default     = 30

  validation {
    condition     = var.rotation_days >= 1 && var.rotation_days <= 365
    error_message = "rotation_days must be between 1 and 365 (Secrets Manager API range)."
  }
}

variable "extra_tags" {
  description = "Additional tags merged into the default tag set."
  type        = map(string)
  default     = {}
}
