###############################################################################
# Inputs for the cognito-user-pool module.
#
# All variables are sensibly defaulted for a dev apply. The module is account-
# agnostic; per-env overrides land in the consuming envs/{env}/main.tf or in
# example dir tfvars.
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
  description = "AWS region. Cognito User Pools are regional; the calling provider determines the actual region. This variable is used for log-group naming, IAM policy region scoping, and the JWKS URL output."
  type        = string
  default     = "us-east-1"
}

variable "domain_prefix_override" {
  description = "Optional. Override the computed Hosted UI domain prefix. The default is `strata-{env_name}-{account_id}` to guarantee global uniqueness (Cognito Hosted UI prefixes share a single global namespace per region). Use this to wire a custom-domain ACM cert flow in prod where the hosted-ui prefix is purely internal to Cognito."
  type        = string
  default     = ""
}

variable "mfa_configuration" {
  description = "Cognito MFA mode. `OPTIONAL` (default) lets users opt in; `ON` requires MFA for everyone; `OFF` disables it entirely. Prod tfvars typically pin to `ON` once the user base is past first-deploy."
  type        = string
  default     = "OPTIONAL"

  validation {
    condition     = contains(["OFF", "OPTIONAL", "ON"], var.mfa_configuration)
    error_message = "mfa_configuration must be one of: OFF, OPTIONAL, ON."
  }
}

variable "advanced_security_mode" {
  description = "Cognito advanced security feature mode. `AUDIT` (default) logs risk-detected events without blocking; `ENFORCED` adds adaptive MFA + bot-protection challenges. Dev runs `AUDIT`; prod tfvars override to `ENFORCED`. `OFF` disables the feature (and removes the Plus-tier billing line)."
  type        = string
  default     = "AUDIT"

  validation {
    condition     = contains(["OFF", "AUDIT", "ENFORCED"], var.advanced_security_mode)
    error_message = "advanced_security_mode must be one of: OFF, AUDIT, ENFORCED."
  }
}

variable "password_minimum_length" {
  description = "Minimum password length. Default 12 — exceeds NIST SP 800-63B's 8-char floor and matches the Strata baseline. Cognito hard cap is 99."
  type        = number
  default     = 12

  validation {
    condition     = var.password_minimum_length >= 8 && var.password_minimum_length <= 99
    error_message = "password_minimum_length must be in [8, 99]."
  }
}

variable "deletion_protection" {
  description = "User-pool deletion protection. `ACTIVE` blocks `DeleteUserPool` until the operator explicitly disables it; `INACTIVE` allows destroy/recreate cycles. Default `INACTIVE` so dev's task-down/task-up cadence works without manual intervention. Prod tfvars override to `ACTIVE`."
  type        = string
  default     = "INACTIVE"

  validation {
    condition     = contains(["ACTIVE", "INACTIVE"], var.deletion_protection)
    error_message = "deletion_protection must be one of: ACTIVE, INACTIVE."
  }
}

variable "callback_urls" {
  description = "OAuth callback URLs the Hosted UI will redirect to after a successful login. Default points at localhost so dev applies before any real frontend is deployed. Prod tfvars override with the public-facing URL list."
  type        = list(string)
  default     = ["https://localhost:3000/auth/callback"]

  validation {
    condition     = length(var.callback_urls) > 0
    error_message = "callback_urls must contain at least one URL — Cognito requires it."
  }
}

variable "logout_urls" {
  description = "URLs the Hosted UI may redirect to after a successful logout. Default points at localhost."
  type        = list(string)
  default     = ["https://localhost:3000"]

  validation {
    condition     = length(var.logout_urls) > 0
    error_message = "logout_urls must contain at least one URL."
  }
}

variable "generate_client_secret" {
  description = "Whether the App Client should have a confidential client secret. `true` for backend services that hold the secret server-side (the example-agent backend, Strata-on-AWS); `false` for SPAs / native apps that authenticate via PKCE only. Default `true` because the v1 consumer is a Next.js server-side app."
  type        = bool
  default     = true
}

variable "google_client_id" {
  description = "Google OAuth client ID. When non-empty AND google_client_secret_arn is also set, the module creates a Google federation IdP. Leave empty to skip Google federation."
  type        = string
  default     = ""
}

variable "google_client_secret_arn" {
  description = "Secrets Manager ARN holding the Google OAuth client secret. The secret value is read via data.aws_secretsmanager_secret_version at plan time — the value is never exposed as a Terraform variable. When empty, Google federation is skipped even if google_client_id is set."
  type        = string
  default     = ""
}

variable "github_client_id" {
  description = "GitHub OAuth App client ID. Accepted but only consumed when github_native_oidc_endpoint is also set — see README §'GitHub federation' for why GitHub OAuth ≠ OIDC."
  type        = string
  default     = ""
}

variable "github_client_secret_arn" {
  description = "Secrets Manager ARN holding the GitHub OAuth client secret. Same gating as github_client_id."
  type        = string
  default     = ""
}

variable "github_native_oidc_endpoint" {
  description = "Pre-built OIDC discovery endpoint URL for GitHub federation (e.g. a Lambda@Edge wrapper that adds OIDC discovery on top of GitHub's OAuth). When non-empty, the module creates the GitHub IdP using this URL as the `oidc_issuer`. When empty (default), GitHub federation is skipped — even if github_client_id/_secret_arn are set. See README §'GitHub federation'."
  type        = string
  default     = ""
}

variable "pre_signup_lambda_arn" {
  description = "Optional. ARN of an external PreSignUp Lambda (e.g. the example-agent allowlist enforcer). When empty, the module ships an inert pass-through stub that auto-confirms the user. Default empty — first dev apply uses the stub."
  type        = string
  default     = ""
}

variable "pre_signup_lambda_provided" {
  description = "Static toggle that mirrors `var.pre_signup_lambda_arn != \"\"` from the caller's perspective. Required because Terraform's `count` cannot key off a string only known after apply (when the caller wires `aws_lambda_function.pre_signup.arn` from the same composition). Set true when wiring an external Lambda; default false. When false, the module ships its inert stub."
  type        = bool
  default     = false
}

variable "post_confirmation_lambda_arn" {
  description = "Optional. ARN of an external PostConfirmation Lambda (e.g. the example-agent group-assigner). When empty, the module ships an inert no-op stub. Default empty."
  type        = string
  default     = ""
}

variable "post_confirmation_lambda_provided" {
  description = "Static toggle that mirrors `var.post_confirmation_lambda_arn != \"\"` from the caller's perspective. Required because Terraform's `count` cannot key off a string only known after apply. Set true when wiring an external Lambda; default false."
  type        = bool
  default     = false
}

variable "extra_tags" {
  description = "Additional tags merged into the default tag set."
  type        = map(string)
  default     = {}
}
