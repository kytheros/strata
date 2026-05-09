variable "env_name" {
  description = "Environment short name (dev|staging|prod). Used in bucket naming and tags."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.env_name)
    error_message = "env_name must be one of: dev, staging, prod."
  }
}

variable "repo_slug" {
  description = "GitHub repo in {owner}/{name} form, e.g. mkavalich/strata. Used to scope the OIDC trust policy."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.repo_slug))
    error_message = "repo_slug must look like 'owner/repo'."
  }
}

variable "allowed_branches" {
  description = "Git branches the OIDC role will trust (refs/heads/*). The principal pin lets these branches assume the role via GitHub Actions."
  type        = list(string)
  default     = ["main"]
}

variable "allowed_environments" {
  description = "GitHub Actions environments the OIDC role will trust (matches `environment:{name}` in the OIDC sub claim). Use this to gate prod deploys behind a GitHub environment with required reviewers."
  type        = list(string)
  default     = []
}

variable "create_oidc_provider" {
  description = "If true, create the GitHub OIDC identity provider in this account. Set to false in accounts where the provider already exists (it's an account-wide singleton). When false, the module looks up the existing provider via a data source."
  type        = bool
  default     = true
}

variable "state_bucket_name_override" {
  description = "Optional override for the state bucket name. When empty, defaults to terraform-state-{account_id}-{env_name} (account-id suffix guarantees global uniqueness)."
  type        = string
  default     = ""
}

variable "lock_table_name" {
  description = "DynamoDB lock table name. Same name across envs is fine since each env has its own AWS account."
  type        = string
  default     = "terraform-state-locks"
}

variable "noncurrent_version_expiration_days" {
  description = "Days before noncurrent S3 object versions are expired. 90 = quarter of safety, then prune."
  type        = number
  default     = 90
}

variable "deploy_role_name" {
  description = "Name of the IAM role assumed by GitHub Actions via OIDC."
  type        = string
  default     = "strata-cicd-deploy-role"
}

variable "create_readonly_role" {
  description = "If true, create a read-only OIDC role for plan-on-PR jobs. The role is assumable from any pull_request from the same repo (sub claim: repo:{slug}:pull_request) and carries the AWS-managed ReadOnlyAccess policy. Used by .github/workflows/aws-template-ci.yml so plans run with no mutation surface."
  type        = bool
  default     = true
}

variable "readonly_role_name" {
  description = "Name of the read-only IAM role assumed by GitHub Actions plan jobs via OIDC."
  type        = string
  default     = "strata-cicd-readonly-role"
}

variable "extra_tags" {
  description = "Additional tags merged into the default tag set."
  type        = map(string)
  default     = {}
}
