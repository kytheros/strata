###############################################################################
# Dev-environment Terraform backend.
#
# This file wires Strata-on-AWS Terraform runs (every module under
# strata/templates/aws/{modules,services}/* invoked from envs/dev/) to the
# remote state bucket + DynamoDB lock table created by the bootstrap module.
#
# Prereq: `strata/templates/aws/bootstrap/examples/dev/` has been applied
# successfully against account <ACCOUNT_ID>. Confirm via:
#
#   aws s3 ls | grep terraform-state-<ACCOUNT_ID>-dev
#   aws dynamodb describe-table --table-name terraform-state-locks
#
# This is a PARTIAL backend config — bucket + dynamodb_table are operator-
# specific and supplied at init time via:
#
#   terraform init -reconfigure -backend-config=backend.dev.hcl
#
# `backend.dev.hcl` is gitignored (see .gitignore). A committed example
# lives at backend.dev.hcl.example — copy + edit on first checkout.
#
# To expand to staging/prod once those accounts exist:
#
#   1. Create envs/staging/backend.tf and envs/prod/backend.tf as copies of
#      this file, changing only the `key` to envs/{env}/terraform.tfstate.
#      (The bucket + lock-table values come from the env's own
#      backend.{env}.hcl — accounts isolate them.)
#
#   2. Run the bootstrap module against the new account (point your AWS
#      profile at the new account, then `terraform apply` in
#      bootstrap/examples/{env}/ — copy + adjust the dev example).
#
#   3. From envs/{env}/, run `terraform init -backend-config=backend.{env}.hcl`
#      to lock in the new backend.
#
# DO NOT change the `key` of an existing environment after first apply —
# that orphans the state file in the bucket and your next plan will look
# like "create everything from scratch."
###############################################################################

terraform {
  required_version = "~> 1.7"

  backend "s3" {
    # Partial config — `bucket` and `dynamodb_table` are operator-supplied
    # via `terraform init -backend-config=backend.dev.hcl`.
    key     = "envs/dev/terraform.tfstate"
    region  = "us-east-1"
    encrypt = true
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

  # Pin: dev runs only target the dev account. Sourced from var.aws_account_id
  # so the operator's account ID is never committed to source.
  allowed_account_ids = [var.aws_account_id]
}
