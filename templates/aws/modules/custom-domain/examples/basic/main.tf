###############################################################################
# Standalone validation harness for modules/custom-domain.
#
# This is NOT how the env composition uses the module — it's a unit-test
# fixture that creates a sentinel API Gateway HTTP API alongside the custom
# domain so `terraform plan` can run end-to-end without an upstream stack.
#
# Run from THIS directory:
#   terraform init && terraform plan -var domain_name=test.example.com
#
# An apply against a real domain WILL block on cert validation until the
# operator pastes the validation CNAME into the controlling DNS provider.
###############################################################################

terraform {
  required_version = "~> 1.7"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "us-east-1"
}

variable "domain_name" {
  description = "FQDN to test against. Use a name you actually control if you intend to apply; for plan-only validation any FQDN works."
  type        = string
  default     = "custom-domain-example.invalid"
}

# Sentinel HTTP API — matches the shape the ingress module produces in real
# envs but stays self-contained here.
resource "aws_apigatewayv2_api" "sentinel" {
  name          = "custom-domain-example"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.sentinel.id
  name        = "$default"
  auto_deploy = true
}

module "custom_domain" {
  source = "../../"

  env_name    = "example"
  aws_region  = "us-east-1"
  domain_name = var.domain_name

  apigw_api_id     = aws_apigatewayv2_api.sentinel.id
  apigw_stage_name = aws_apigatewayv2_stage.default.name
}

output "cloudflare_dns_records" {
  value = module.custom_domain.cloudflare_dns_records
}
