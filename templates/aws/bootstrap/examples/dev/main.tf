###############################################################################
# Example: bootstrap the dev account (624990353897).
#
# Run from this directory:
#   aws sts get-caller-identity   # confirm you are mike-cli @ 624990353897
#   terraform init
#   terraform plan -out=plan.tfplan
#   terraform apply plan.tfplan
#
# After apply, run-from-this-folder outputs become the inputs for
# `strata/templates/aws/envs/dev/backend.tf`.
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

  # Sanity guard: this example is hard-coded for the dev account. Remove or
  # change when you re-run the module against staging/prod.
  allowed_account_ids = ["624990353897"]
}

module "bootstrap" {
  source = "../.."

  env_name  = "dev"
  repo_slug = "mkavalich/strata"

  allowed_branches = ["main"]

  # In a multi-account world, you would also set:
  #   allowed_environments = ["dev"]
  # so the GHA `dev` environment with required reviewers can deploy.
  allowed_environments = ["dev"]

  # First-time bootstrap creates the OIDC provider. If you ever destroy and
  # re-create this module, flip to false and the data source will pick up the
  # existing one (per-account singleton).
  create_oidc_provider = true
}

output "state_bucket_name" {
  value = module.bootstrap.state_bucket_name
}

output "lock_table_name" {
  value = module.bootstrap.lock_table_name
}

output "deploy_role_arn" {
  value = module.bootstrap.deploy_role_arn
}

output "oidc_provider_arn" {
  value = module.bootstrap.oidc_provider_arn
}

output "account_id" {
  value = module.bootstrap.account_id
}

output "readonly_role_arn" {
  value = module.bootstrap.readonly_role_arn
}
