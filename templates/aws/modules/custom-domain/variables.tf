###############################################################################
# Strata-on-AWS custom-domain module — inputs.
#
# Wraps an API Gateway HTTP API with an operator-owned FQDN. Cert validation
# DNS records are emitted as outputs so the operator can paste them into the
# external DNS provider (Cloudflare, in dev — no Route 53 for kytheros.dev).
###############################################################################

variable "env_name" {
  description = "Environment short-name (dev/staging/prod). Used in tags only — the FQDN itself is operator-supplied via var.domain_name."
  type        = string

  validation {
    condition     = length(var.env_name) > 0
    error_message = "env_name must be non-empty."
  }
}

variable "aws_region" {
  description = "AWS region the API GW HTTP API lives in. The ACM certificate is issued in this same region (regional API GW custom domains require a cert in the same region — UNLIKE CloudFront, which mandates us-east-1)."
  type        = string

  validation {
    condition     = length(var.aws_region) > 0
    error_message = "aws_region must be non-empty."
  }
}

variable "domain_name" {
  description = "Fully qualified domain name to attach to the API GW (e.g. `aws.strata.kytheros.dev`). Must be a name the operator controls in their DNS provider — they paste the cert validation CNAME and the final alias CNAME emitted by this module's outputs."
  type        = string

  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}$", var.domain_name))
    error_message = "domain_name must be a valid lowercase FQDN with at least two labels (e.g. aws.strata.kytheros.dev)."
  }
}

variable "apigw_api_id" {
  description = "API Gateway HTTP API ID to map this domain to. Sourced from module.ingress.api_id in env compositions."
  type        = string

  validation {
    condition     = length(var.apigw_api_id) > 0
    error_message = "apigw_api_id must be non-empty — pass module.ingress.api_id."
  }
}

variable "apigw_stage_name" {
  description = "API GW stage name to map under this custom domain. The ingress module emits `$default`. The aws_apigatewayv2_api_mapping resource accepts `$default` literally — Terraform escapes the `$` for the AWS API."
  type        = string
  default     = "$default"
}

variable "extra_tags" {
  description = "Additional resource tags merged onto the module-default tag set."
  type        = map(string)
  default     = {}
}
