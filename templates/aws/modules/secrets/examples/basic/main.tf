###############################################################################
# Example: stub secret in the dev account (<ACCOUNT_ID>), no rotation.
#
# Demonstrates the simplest case: a static secret bootstrapped with an initial
# value, encrypted with a module-created per-secret CMK.
#
# Run from this directory:
#   aws sts get-caller-identity   # confirm you are <your-cli-user> @ <ACCOUNT_ID>
#   terraform init
#   terraform plan -out plan.tfplan
#   terraform apply plan.tfplan
###############################################################################

terraform {
  required_version = "~> 1.7"

  backend "s3" {
    bucket         = "terraform-state-<ACCOUNT_ID>-dev"
    key            = "examples/secrets-basic/terraform.tfstate"
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
  region              = "us-east-1"
  allowed_account_ids = ["<ACCOUNT_ID>"]
}

module "static_secret" {
  source = "../.."

  env_name    = "dev"
  secret_name = "example-static-api-key"
  description = "Stub static API key — example deployment of the secrets module. Not consumed by any service."

  # Demonstrate the bootstrap-with-initial-value pattern. In real use, prefer
  # writing the value via `aws secretsmanager put-secret-value` after apply
  # so the value never lands in terraform.tfvars.
  create_initial_version = false

  extra_tags = {
    Owner   = "platform"
    Example = "secrets-basic"
  }
}

output "secret_arn" {
  value = module.static_secret.secret_arn
}

output "secret_name" {
  value = module.static_secret.secret_name
}

output "kms_key_arn" {
  value = module.static_secret.kms_key_arn
}

output "kms_key_alias" {
  value = module.static_secret.kms_key_alias
}

output "consumer_iam_policy_json" {
  description = "Attach this to a consumer task role to grant least-privilege read."
  value       = module.static_secret.consumer_iam_policy_json
}
