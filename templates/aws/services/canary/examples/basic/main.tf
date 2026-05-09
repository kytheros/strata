###############################################################################
# MODULE-VALIDATION HARNESS — services/canary (AWS-4.1).
#
# This example wires services/canary against sentinel inputs that match the
# shape of the AWS-1.x example basics. It is NOT the canonical apply target —
# `envs/dev/main.tf` orchestrates the canary against live module outputs
# (Cognito user pool, ingress endpoint DNS, observability SNS topic).
#
# Use:
#   terraform init -backend=false
#   terraform validate
#
# DO NOT `terraform plan` from this directory — sentinel ARNs do not resolve
# to live resources. The example exists to prove the canary composition
# surface is shape-valid in isolation.
###############################################################################

terraform {
  required_version = "~> 1.7"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }
}

provider "aws" {
  region              = "us-east-1"
  allowed_account_ids = ["<ACCOUNT_ID>"]
}

locals {
  account_id = "<ACCOUNT_ID>"
  region     = "us-east-1"
  env        = "dev"

  # cognito-user-pool sentinels
  cognito_user_pool_id        = "${local.region}_XXXXXXXXX"
  cognito_user_pool_arn       = "arn:aws:cognito-idp:${local.region}:${local.account_id}:userpool/${local.cognito_user_pool_id}"
  cognito_user_pool_client_id = "Xxxxxxxxxxxxxxxxxxxxxxxxxxxx"

  # ingress sentinel
  apigw_endpoint_dns = "Xxxxxxxxxx.execute-api.${local.region}.amazonaws.com"

  # observability sentinel
  alarm_topic_arn = "arn:aws:sns:${local.region}:${local.account_id}:strata-${local.env}-alarms"
}

###############################################################################
# Canary under test.
###############################################################################

module "canary" {
  source = "../.."

  env_name   = local.env
  aws_region = local.region

  canary_enabled = true

  cognito_user_pool_id        = local.cognito_user_pool_id
  cognito_user_pool_arn       = local.cognito_user_pool_arn
  cognito_user_pool_client_id = local.cognito_user_pool_client_id

  mcp_endpoint_url = "https://${local.apigw_endpoint_dns}/mcp"

  alarm_topic_arn = local.alarm_topic_arn

  extra_tags = {
    Owner   = "platform"
    Example = "basic"
  }
}

output "credentials_secret_arn" {
  value = module.canary.credentials_secret_arn
}

output "function_name" {
  value = module.canary.function_name
}

output "log_group_name" {
  value = module.canary.log_group_name
}

output "failure_alarm_arn" {
  value = module.canary.failure_alarm_arn
}

output "schedule_rule_arn" {
  value = module.canary.schedule_rule_arn
}
