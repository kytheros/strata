###############################################################################
# MODULE-VALIDATION HARNESS — not the canonical apply target.
#
# As of AWS-1.5.1, `envs/dev/main.tf` is the canonical apply path for the
# dev account. This file is kept around for `terraform validate` / unit-
# testing changes to aurora-postgres in isolation. The hardcoded VPC + subnet
# IDs below are stale by design (the orchestrator's apply may rotate them
# on each cycle) — re-discover them per the steps below if you need to run
# this harness against a live network apply.
###############################################################################

###############################################################################
# Example: deploy the aurora-postgres module to the dev account (624990353897).
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
# Or wire via remote state instead of literals (production pattern):
#
#   data "terraform_remote_state" "network" {
#     backend = "s3"
#     config = {
#       bucket = "terraform-state-624990353897-dev"
#       key    = "examples/network-basic/terraform.tfstate"
#       region = "us-east-1"
#     }
#   }
#   # Then reference: data.terraform_remote_state.network.outputs.vpc_id, etc.
#
# Run from this directory:
#   aws sts get-caller-identity   # confirm 624990353897 / mike-cli
#   terraform init
#   terraform plan -out plan.tfplan
#   # Review carefully — Aurora cluster + proxy + KMS key + parameter group.
#   # APPROXIMATE APPLY TIME: 10–15 min (Aurora cluster bootstrap is slow).
#   terraform apply plan.tfplan
###############################################################################

terraform {
  required_version = "~> 1.7"

  backend "s3" {
    bucket         = "terraform-state-624990353897-dev"
    key            = "examples/aurora-postgres-basic/terraform.tfstate"
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
# aurora-postgres module — Serverless v2 Postgres + RDS Proxy + per-cluster CMK
###############################################################################

module "aurora" {
  source = "../.."

  env_name = "dev"

  vpc_id     = local.vpc_id
  vpc_cidr   = local.vpc_cidr
  subnet_ids = local.isolated_subnet_ids

  # No consumer SGs in this example — the module falls back to VPC-CIDR
  # ingress, which is fine for plan validation. A real consumer (e.g., the
  # Strata Fargate service in AWS-2.1) would supply its own SG ID here.
  allowed_security_group_ids = []

  # Dev defaults: scale-to-zero (min_capacity = 0) with a 30-min auto-pause
  # window, single writer instance, 1-day backup retention, destroy-friendly.
  # All of these are also the module defaults — listed here for documentation
  # rather than override.
  min_capacity             = 0
  max_capacity             = 8
  seconds_until_auto_pause = 1800
  instance_count           = 1
  backup_retention_period  = 1
  skip_final_snapshot      = true
  deletion_protection      = false
  apply_immediately        = true

  extra_tags = {
    Owner   = "platform"
    Example = "aurora-postgres-basic"
  }
}

###############################################################################
# Outputs — same names as the module so consumers can copy-paste between
# example and service-module compositions.
###############################################################################

output "cluster_id" {
  value = module.aurora.cluster_id
}

output "cluster_arn" {
  value = module.aurora.cluster_arn
}

output "cluster_endpoint" {
  description = "Direct writer endpoint — typically NOT what consumers use; see proxy_endpoint."
  value       = module.aurora.cluster_endpoint
}

output "cluster_reader_endpoint" {
  value = module.aurora.cluster_reader_endpoint
}

output "proxy_endpoint" {
  description = "RDS Proxy endpoint — the hostname consumers put in DATABASE_URL."
  value       = module.aurora.proxy_endpoint
}

output "proxy_arn" {
  value = module.aurora.proxy_arn
}

output "database_name" {
  value = module.aurora.database_name
}

output "master_user_secret_arn" {
  description = "ARN of the AWS-managed master credential secret. Plaintext is never output."
  value       = module.aurora.master_user_secret_arn
}

output "kms_key_arn" {
  value = module.aurora.kms_key_arn
}

output "kms_key_alias" {
  value = module.aurora.kms_key_alias
}

output "security_group_id" {
  value = module.aurora.security_group_id
}

output "consumer_iam_policy_json" {
  description = "Attach to a consumer task role to grant least-privilege read on the master credential."
  value       = module.aurora.consumer_iam_policy_json
}
