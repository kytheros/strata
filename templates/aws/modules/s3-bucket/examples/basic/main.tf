###############################################################################
# Example: deploy the s3-bucket module to the dev account (<ACCOUNT_ID>).
#
# Demonstrates default config:
#   - purpose = "artifacts"
#   - versioning ENABLED (default)
#   - module-created KMS CMK (default)
#   - no CloudFront OAC
#   - no lifecycle rules
#
# Run from this directory:
#   aws sts get-caller-identity   # <your-cli-user> @ <ACCOUNT_ID>
#   terraform init
#   terraform plan -out plan.tfplan
#   terraform apply plan.tfplan
###############################################################################

terraform {
  required_version = "~> 1.7"

  backend "s3" {
    bucket         = "terraform-state-<ACCOUNT_ID>-dev"
    key            = "examples/s3-bucket-basic/terraform.tfstate"
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
  allowed_account_ids = ["<ACCOUNT_ID>"]
}

module "artifacts_bucket" {
  # checkov:skip=CKV_AWS_109:KMS key policy uses `kms:*` to account root — see modules/s3-bucket/main.tf rationale (AWS-recommended baseline; alternative shapes risk orphaning the key).
  # checkov:skip=CKV_AWS_111:Same — write access via `kms:*` is scoped to a single key; identity policies on principals enforce least privilege.
  # checkov:skip=CKV_AWS_356:`Resource: *` in a key policy refers only to this key by AWS spec.
  source = "../.."

  env_name = "dev"
  purpose  = "artifacts"

  extra_tags = {
    Owner = "platform"
  }
}

output "bucket_id" {
  value = module.artifacts_bucket.bucket_id
}

output "bucket_name" {
  value = module.artifacts_bucket.bucket_name
}

output "bucket_arn" {
  value = module.artifacts_bucket.bucket_arn
}

output "bucket_regional_domain_name" {
  value = module.artifacts_bucket.bucket_regional_domain_name
}

output "kms_key_arn" {
  value = module.artifacts_bucket.kms_key_arn
}

output "kms_key_alias" {
  value = module.artifacts_bucket.kms_key_alias
}

output "oac_id" {
  value = module.artifacts_bucket.oac_id
}
