###############################################################################
# Example: deploy the elasticache-redis module to the dev account (<ACCOUNT_ID>).
#
# Prerequisite: the network module has already been applied via
# `task network:up` (or `terraform apply` in modules/network/examples/basic/).
# This example consumes the resulting VPC + isolated subnets by passing in
# literal IDs as locals — that's intentional. Production callers would consume
# these via remote state or via composition in a higher-level service module;
# the example exists only to validate `terraform plan` end-to-end against the
# real account.
#
# To find the actual values for your account:
#
#   cd ../../../network/examples/basic
#   terraform output vpc_id
#   terraform output vpc_cidr
#   terraform output isolated_subnet_ids
#
# The values pinned below match the dev account (<ACCOUNT_ID>) at the time
# this example was authored. Update them if the network module is recreated.
#
# Run from this directory:
#   aws sts get-caller-identity   # confirm <ACCOUNT_ID> / <your-cli-user>
#   terraform init
#   terraform plan -out plan.tfplan
#   # Review carefully — check that AUTH-token Secrets Manager secret is
#   # marked sensitive and the CMK alias is alias/strata-dev-cache.
#   terraform apply plan.tfplan   # ~5–7 min
###############################################################################

terraform {
  required_version = "~> 1.7"

  backend "s3" {
    bucket         = "terraform-state-<ACCOUNT_ID>-dev"
    key            = "examples/elasticache-redis-basic/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "terraform-state-locks"
    encrypt        = true
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "aws" {
  region = "us-east-1"

  # Sanity guard: this example is hard-coded for the dev account.
  allowed_account_ids = ["<ACCOUNT_ID>"]
}

###############################################################################
# Network values from the already-applied network module in dev.
# Source: `terraform output` from modules/network/examples/basic/.
###############################################################################

locals {
  # Network module outputs (dev account, captured 2026-05-04):
  vpc_id   = "vpc-0da4fadaa6e653c5b"
  vpc_cidr = "10.40.0.0/16"

  # The three isolated subnets (10.40.64.0/22, 10.40.68.0/22, 10.40.72.0/22)
  # across us-east-1a/b/c. Hardcoded subnet IDs are NOT recoverable across
  # network destroy/recreate cycles — re-run `terraform output isolated_subnet_ids`
  # in the network example after every cycle and update this list.
  isolated_subnet_ids = [
    # us-east-1a — 10.40.64.0/22
    "subnet-0d3d801e9e426956d",
    # us-east-1b — 10.40.68.0/22
    "subnet-002102c33df797511",
    # us-east-1c — 10.40.72.0/22
    "subnet-0642a35e5755f1431",
  ]
}

###############################################################################
# elasticache-redis module — Serverless Redis with TLS + AUTH + per-cache CMK
###############################################################################

module "cache" {
  source = "../.."

  env_name = "dev"

  vpc_id     = local.vpc_id
  vpc_cidr   = local.vpc_cidr
  subnet_ids = local.isolated_subnet_ids

  # No consumer SGs in this example — the module falls back to VPC-CIDR
  # ingress, which is fine for plan validation. A real consumer (e.g., the
  # Strata Fargate service in AWS-2.1) would supply its own SG ID here.
  allowed_security_group_ids = []

  # Dev defaults: 1 GB max stored data, 5K ECPU/s rate cap. Keeps the idle
  # bill near the Serverless floor (~$10/mo).
  cache_usage_limits = {
    data_storage_max_gb = 1
    ecpu_per_second_max = 5000
  }

  # Dev cycling: 1-day snapshot retention to minimize storage cost during
  # task up / task down churn. Bump to 7 in prod via terraform.tfvars.
  daily_snapshot_retention_limit = 1

  extra_tags = {
    Owner   = "platform"
    Example = "elasticache-redis-basic"
  }
}

###############################################################################
# Outputs — same names as the module so consumers can copy-paste between
# example and service-module compositions.
###############################################################################

output "cache_id" {
  value = module.cache.cache_id
}

output "cache_arn" {
  value = module.cache.cache_arn
}

output "endpoint" {
  value = module.cache.endpoint
}

output "port" {
  value = module.cache.port
}

output "auth_secret_arn" {
  description = "ARN of the Secrets Manager secret containing the AUTH token. Plaintext is never output."
  value       = module.cache.auth_secret_arn
}

output "security_group_id" {
  value = module.cache.security_group_id
}

output "kms_key_arn" {
  value = module.cache.kms_key_arn
}

output "kms_key_alias" {
  value = module.cache.kms_key_alias
}
