###############################################################################
# Example: ingress module with backend="apigw" — dev-tier default.
#
# Demonstrates the cheapest-possible HTTP API setup for the dev account:
#   - HTTP API + VPC Link into the existing dev private subnets
#   - Permissive CORS (default)
#   - No Cognito authorizer (Cognito vars left empty)
#   - Execution logging on (30d)
#
# Cognito wiring lands when AWS-1.8 is consumed by AWS-2.1 — the consumer
# module passes user_pool_id + client_id and routes get protected via
# authorizer_id at the route level (this module just creates the authorizer
# resource).
#
# Run from this directory:
#   aws sts get-caller-identity   # confirm you are mike-cli @ 624990353897
#   terraform init
#   terraform plan -out plan.tfplan
###############################################################################

terraform {
  required_version = "~> 1.7"

  backend "s3" {
    bucket         = "terraform-state-624990353897-dev"
    key            = "examples/ingress-apigw/terraform.tfstate"
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
# Inputs sourced from the already-applied dev network module
# (see modules/network/examples/basic). Hardcoded here to keep the example
# self-contained — production uses tfvars or remote-state references.
###############################################################################

locals {
  dev_vpc_id   = "vpc-0da4fadaa6e653c5b"
  dev_vpc_cidr = "10.40.0.0/16"

  dev_private_subnet_ids = [
    "subnet-0d73b510d4f133e39",
    "subnet-026485c08d8165cb1",
    "subnet-0f4d29d6534a7b9d0",
  ]
}

module "ingress" {
  source = "../.."

  env_name = "dev"
  backend  = "apigw"

  vpc_id             = local.dev_vpc_id
  vpc_cidr           = local.dev_vpc_cidr
  private_subnet_ids = local.dev_private_subnet_ids

  # Cognito left empty — JWT authorizer is skipped. The consumer service
  # module (AWS-2.1) re-applies this with the user-pool wired in.
  # cognito_user_pool_id        = ""
  # cognito_user_pool_client_id = ""

  enable_logging     = true
  log_retention_days = 30

  extra_tags = {
    Owner   = "platform"
    Example = "ingress-apigw"
  }
}

output "backend" {
  value = module.ingress.backend
}

output "endpoint_dns" {
  value = module.ingress.endpoint_dns
}

output "api_id" {
  value = module.ingress.api_id
}

output "api_arn" {
  value = module.ingress.api_arn
}

output "vpc_link_id" {
  value = module.ingress.vpc_link_id
}

output "stage_name" {
  value = module.ingress.stage_name
}

output "authorizer_id" {
  value = module.ingress.authorizer_id
}

output "log_group_name" {
  value = module.ingress.log_group_name
}

output "security_group_id" {
  value = module.ingress.security_group_id
}

output "cognito_wired" {
  value = module.ingress.cognito_wired
}
