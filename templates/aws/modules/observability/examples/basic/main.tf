###############################################################################
# Example: minimum-viable observability for the dev account (624990353897).
#
# This wires the observability module against the *currently-applied* state of
# the dev account: only the network module is up. NAT gateway IDs come from the
# applied network example-basic state. Everything else (ALB, ECS, Aurora,
# Redis, Cognito) is left empty — the module gracefully creates only the alarms
# whose targets exist.
#
# Result: SNS topic + CMK + dashboard + 2 NAT bytes-out anomaly alarms.
#
# Run from this directory:
#   aws sts get-caller-identity   # confirm you are mike-cli @ 624990353897
#   terraform init
#   terraform plan -out plan.tfplan
#   # DO NOT apply unless you actually want the alarms attached to live NAT GWs.
###############################################################################

terraform {
  required_version = "~> 1.7"

  backend "s3" {
    bucket         = "terraform-state-624990353897-dev"
    key            = "examples/observability-basic/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "terraform-state-locks"
    encrypt        = true
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "us-east-1"

  # Sanity guard: this example is hard-coded for the dev account.
  allowed_account_ids = ["624990353897"]
}

variable "nat_gateway_ids" {
  description = "NAT gateway IDs from the applied network module's outputs. Defaults reflect the dev account's currently-applied state (2026-05-04)."
  type        = list(string)
  default = [
    "nat-026c4d2c535386417",
    "nat-08b85cf6a561d5728",
  ]
}

module "observability" {
  source = "../.."

  env_name        = "dev"
  aws_region      = "us-east-1"
  nat_gateway_ids = var.nat_gateway_ids

  # No subscribers yet — alarms still create, they just don't fan out anywhere.
  # Add { protocol = "email", endpoint = "you@example.com" } when ready; SNS
  # will send a confirmation email that must be accepted before delivery.
  alarm_subscribers = []

  # No service log groups, no metric filters, no other alarm targets — minimum
  # viable observability for the current dev-account footprint.
  service_log_groups = []
  metric_filters     = []

  extra_tags = {
    Owner   = "platform"
    Example = "observability-basic"
  }
}

output "alarm_topic_arn" {
  value = module.observability.alarm_topic_arn
}

output "kms_key_arn" {
  value = module.observability.kms_key_arn
}

output "dashboard_name" {
  value = module.observability.dashboard_name
}

output "dashboard_url" {
  value = module.observability.dashboard_url
}

output "alarm_arns" {
  value = module.observability.alarm_arns
}

output "alarm_count" {
  value = module.observability.alarm_count
}
