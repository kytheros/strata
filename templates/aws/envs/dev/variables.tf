###############################################################################
# Strata-on-AWS dev orchestrator — top-level inputs.
#
# Most module-internal knobs are sensibly defaulted in the module itself; this
# file lists only the values an operator must (or wants to) override at the
# env level. Seed via `cp terraform.tfvars.example terraform.tfvars`.
###############################################################################

variable "aws_region" {
  description = "AWS region for the dev deployment. The bootstrap S3 backend lives in this region too — see backend.tf. Default us-east-1 matches the design spec's single-region v1 footprint."
  type        = string
  default     = "us-east-1"
}

variable "vpc_cidr" {
  description = "VPC CIDR for the dev environment. Per design §Network: dev=10.40.0.0/16, staging=10.41.0.0/16, prod=10.42.0.0/16."
  type        = string
  default     = "10.40.0.0/16"

  validation {
    condition     = can(cidrnetmask(var.vpc_cidr))
    error_message = "vpc_cidr must be a valid IPv4 CIDR block."
  }
}

variable "example_agent_app_url" {
  description = "Public URL where the example-agent UI is served. Used as the Cognito callback / logout URL base. Format: `https://<host>` with no trailing slash. After the first apply lands the ingress, update this to `https://<module.ingress.endpoint_dns>` and re-apply — see README §\"Two-pass apply pattern\"."
  type        = string

  validation {
    condition     = can(regex("^https?://[^/]+$", var.example_agent_app_url))
    error_message = "example_agent_app_url must be `https://<host>` (or `http://...` for local) with no trailing slash."
  }
}

variable "google_client_id" {
  description = "Google OAuth 2.0 client ID for Cognito federation. Create the OAuth app at https://console.cloud.google.com/apis/credentials. Empty string disables Google federation (Hosted UI shows local-account sign-in only)."
  type        = string
  default     = ""
}

variable "google_client_secret_arn" {
  description = "ARN of a Secrets Manager secret containing the Google OAuth client secret. Empty string disables Google federation. The secret is created manually via `aws secretsmanager create-secret` — never managed by Terraform, to keep the plaintext value out of state."
  type        = string
  default     = ""
}

variable "allowlist_emails" {
  description = "Initial seed for the example-agent SSM allowlist. Federated users not in this list are rejected at PreSignUp with `Not authorized`. Operators add/remove emails post-apply via `aws ssm put-parameter --name <path> --value '[...]' --overwrite` — Terraform's lifecycle.ignore_changes keeps subsequent applies from churning it."
  type        = list(string)
  default     = ["mkavalich@gmail.com"]

  validation {
    condition     = length(var.allowlist_emails) >= 1
    error_message = "allowlist_emails must have at least one entry — an empty array would lock everyone out."
  }
}

variable "alarm_subscribers" {
  description = "List of {protocol, endpoint} subscribers for the observability SNS alarm topic. Default empty — alarms publish to nothing until populated. For `email`, SNS sends a confirmation message that the recipient must accept before alerts are delivered."
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

variable "strata_container_image" {
  description = "Container image URI for the Strata MCP service. Defaults to the published community image. Pin to a tagged version (e.g. `:2.1.0`) for reproducible applies."
  type        = string
  default     = "ghcr.io/kytheros/strata-mcp:latest"
}

variable "example_agent_container_image" {
  description = "Container image URI for the example-agent Next.js service. Caller's deploy pipeline builds + pushes this (typically to ECR) before applying. No default — populating this is part of the operational setup."
  type        = string

  validation {
    condition     = length(var.example_agent_container_image) > 0
    error_message = "example_agent_container_image must be set — build the image, push to ECR, then populate this."
  }
}

variable "canary_enabled" {
  description = "Phase 4 (AWS-4.1) — enable the EventBridge + Lambda synthetic canary that exercises the full external-MCP path every 5 minutes. The credentials secret is always provisioned (so operators can stage creds before turning the canary on); only the Lambda + IAM role + EventBridge rule + alarm are gated on this flag. Default true; flip to false during initial bring-up before the test user exists, or while the stack is intentionally torn down for extended periods."
  type        = bool
  default     = true
}
