###############################################################################
# Dev-environment Terraform backend.
#
# This file wires Strata-on-AWS Terraform runs (every module under
# strata/templates/aws/{modules,services}/* invoked from envs/dev/) to the
# remote state bucket + DynamoDB lock table created by the bootstrap module.
#
# Prereq: `strata/templates/aws/bootstrap/examples/dev/` has been applied
# successfully against account 624990353897. Confirm via:
#
#   aws s3 ls | grep terraform-state-624990353897-dev
#   aws dynamodb describe-table --table-name terraform-state-locks
#
# To expand to staging/prod once those accounts exist:
#
#   1. Create envs/staging/backend.tf and envs/prod/backend.tf as copies of
#      this file, changing:
#        - bucket  → terraform-state-{account_id}-{env}
#        - key     → unchanged (state-key namespace is per-bucket already)
#      (Both DynamoDB and the bucket live in the env's own AWS account, so
#      the lock-table name does not need to change — accounts isolate them.)
#
#   2. Run the bootstrap module against the new account (point your AWS
#      profile at the new account, then `terraform apply` in
#      bootstrap/examples/{env}/ — copy + adjust the dev example).
#
#   3. From envs/{env}/, run `terraform init` to lock in the new backend.
#
# DO NOT change the `key` of an existing environment after first apply —
# that orphans the state file in the bucket and your next plan will look
# like "create everything from scratch."
###############################################################################

terraform {
  required_version = "~> 1.7"

  backend "s3" {
    bucket         = "terraform-state-624990353897-dev"
    key            = "envs/dev/terraform.tfstate"
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

  # Pin: dev runs only target the dev account.
  allowed_account_ids = ["624990353897"]
}
