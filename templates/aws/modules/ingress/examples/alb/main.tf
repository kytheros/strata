###############################################################################
# Example: ingress module with backend="alb" — staging/prod default shape.
#
# Demonstrates the production-shape pattern, but applied against the dev
# account so the same example can drive smoke tests in dev. ACM certificate
# ARN is a sentinel placeholder — `terraform plan` against this example
# requires a real cert. We deliberately do NOT exercise plan in CI for this
# example; `terraform validate` is the validation gate here.
#
# To make this example plan-clean:
#   1. Provision an ACM cert for the intended hostname (e.g.
#      api.dev.strata-aws.kytheros.dev) via the cloudfront-dist module or
#      a standalone aws_acm_certificate.
#   2. Replace the sentinel acm_certificate_arn below with the real ARN.
#   3. terraform init && terraform plan
#
# Run from this directory:
#   aws sts get-caller-identity   # confirm you are mike-cli @ 624990353897
#   terraform init
#   terraform validate            # this example only — plan needs a real cert
###############################################################################

terraform {
  required_version = "~> 1.7"

  backend "s3" {
    bucket         = "terraform-state-624990353897-dev"
    key            = "examples/ingress-alb/terraform.tfstate"
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
# Inputs sourced from the already-applied dev network module.
###############################################################################

locals {
  dev_vpc_id   = "vpc-0da4fadaa6e653c5b"
  dev_vpc_cidr = "10.40.0.0/16"

  dev_public_subnet_ids = [
    "subnet-005e3c9cee20e3c45",
    "subnet-0e5e641237d891e10",
    "subnet-03aaeca1838f1ea4d",
  ]

  # SENTINEL — replace with a real ACM cert ARN before running `terraform plan`.
  # The format is intentionally well-formed so the module's check{} block
  # passes at validate time.
  placeholder_acm_arn = "arn:aws:acm:us-east-1:624990353897:certificate/00000000-0000-0000-0000-000000000000"
}

module "ingress" {
  source = "../.."

  env_name = "dev"
  backend  = "alb"

  vpc_id            = local.dev_vpc_id
  vpc_cidr          = local.dev_vpc_cidr
  public_subnet_ids = local.dev_public_subnet_ids

  acm_certificate_arn = local.placeholder_acm_arn

  # Dev posture: deletion protection off, internet-facing, idle timeout
  # bumped to 300s for the SSE/long-poll surface (per design §"CloudFront
  # fronts the ALB").
  internal                 = false
  deletion_protection      = false
  alb_idle_timeout_seconds = 300

  # Production posture (commented): scope ALB ingress to CloudFront prefix
  # list once cloudfront-dist is wired in front of this ALB.
  # restrict_to_cloudfront_prefix_list = true

  # No access logging in this example — wire access_logs_bucket once the
  # s3-bucket module's strata-logs-{account} bucket is provisioned.
  # access_logs_bucket = "strata-logs-624990353897"
  # access_logs_prefix = "alb/dev"

  # Cognito wiring shape — leave empty in this example. Consumer module
  # passes these in once cognito-user-pool is applied:
  # cognito_user_pool_arn       = module.cognito_user_pool.user_pool_arn
  # cognito_user_pool_client_id = module.cognito_user_pool.user_pool_client_id
  # cognito_user_pool_domain    = module.cognito_user_pool.hosted_ui_domain
  # cognito_protected_paths     = ["/admin/*"]

  extra_tags = {
    Owner   = "platform"
    Example = "ingress-alb"
  }
}

output "backend" {
  value = module.ingress.backend
}

output "endpoint_dns" {
  value = module.ingress.endpoint_dns
}

output "endpoint_zone_id" {
  value = module.ingress.endpoint_zone_id
}

output "alb_arn" {
  value = module.ingress.alb_arn
}

output "listener_arn" {
  value = module.ingress.listener_arn
}

output "http_listener_arn" {
  value = module.ingress.http_listener_arn
}

output "security_group_id" {
  value = module.ingress.security_group_id
}

output "target_group_arn" {
  value = module.ingress.target_group_arn
}

output "cognito_wired" {
  value = module.ingress.cognito_wired
}
