###############################################################################
# Example: deploy the cloudfront-dist module to the dev account (624990353897).
#
# What this demonstrates:
#   - Single S3+OAC origin (a placeholder bucket created via the s3-bucket
#     module with purpose = "cloudfront-test").
#   - One alias on dev.test.kytheros.dev — a non-production FQDN that won't
#     collide with anything in the real product surface.
#   - Default WAF (CommonRuleSet + KnownBadInputs + IpReputation), default
#     PriceClass_100, default SSE carve-out on /mcp/stream*.
#   - SPA-friendly 403/404 handling.
#
# IMPORTANT — the ACM cert ARN below is a REPLACE-ME placeholder. terraform
# validate succeeds with the placeholder; terraform plan against the real
# account fails on the cert lookup. To run a real plan:
#
#   1. Issue an ACM cert in us-east-1 for dev.test.kytheros.dev (DNS-validated
#      via the kytheros.dev hosted zone).
#   2. Replace acm_certificate_arn below with the issued cert's ARN.
#   3. terraform plan / apply.
#
# Two-pass apply (chicken-and-egg with the s3-bucket module's bucket policy):
#   Pass 1 — apply this example. The bucket module is configured with
#            cloudfront_distribution_arn = "" so its policy falls back to
#            AWS:SourceAccount scoping.
#   Pass 2 — (optional) edit this file to set
#            cloudfront_distribution_arn = module.cloudfront_dist.distribution_arn
#            on the bucket module call, then re-apply. Tightens the bucket
#            policy SourceArn to this distribution.
#
# Run from this directory:
#   aws sts get-caller-identity   # confirm you are mike-cli @ 624990353897
#   terraform init
#   terraform validate            # passes with placeholder cert
#   # terraform plan              # fails on placeholder cert — expected
###############################################################################

terraform {
  required_version = "~> 1.7"

  backend "s3" {
    bucket         = "terraform-state-624990353897-dev"
    key            = "examples/cloudfront-dist-basic/terraform.tfstate"
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
  # CloudFront-scope WAF + ACM cert constraint forces us-east-1.
  allowed_account_ids = ["624990353897"]
}

###############################################################################
# 1. Test bucket — purpose = "cloudfront-test", OAC enabled.
###############################################################################

module "test_bucket" {
  # checkov:skip=CKV_AWS_109:KMS key policy uses `kms:*` to account root — see modules/s3-bucket/main.tf rationale.
  # checkov:skip=CKV_AWS_111:Same — write access via `kms:*` is scoped to a single key.
  # checkov:skip=CKV_AWS_356:`Resource: *` in a key policy refers only to this key by AWS spec.
  source = "../../../s3-bucket"

  env_name = "dev"
  purpose  = "cloudfront-test"

  cloudfront_oac_enabled = true

  # First-pass: leave the distribution ARN empty. Bucket policy falls back
  # to AWS:SourceAccount. Re-apply with module.cloudfront_dist.distribution_arn
  # later to tighten the SourceArn condition.
  # cloudfront_distribution_arn = module.cloudfront_dist.distribution_arn

  extra_tags = {
    Owner   = "platform"
    Example = "cloudfront-dist-basic"
  }
}

###############################################################################
# 2. CloudFront distribution + WAF + Route 53 alias.
###############################################################################

module "cloudfront_dist" {
  source = "../.."

  env_name = "dev"

  # Test FQDN — does not conflict with any real product surface.
  domain_aliases    = ["dev.test.kytheros.dev"]
  route53_zone_name = "kytheros.dev"

  # REPLACE-ME placeholder. Validate passes; plan fails (intentional).
  # Issue a real cert in us-east-1 for dev.test.kytheros.dev and substitute.
  acm_certificate_arn = "arn:aws:acm:us-east-1:624990353897:certificate/00000000-0000-0000-0000-000000000000"

  origins = [
    {
      origin_id   = "test-bucket-origin"
      origin_type = "s3"
      domain_name = module.test_bucket.bucket_regional_domain_name
      oac_id      = module.test_bucket.oac_id
    },
  ]

  default_origin_id = "test-bucket-origin"

  # Defaults: PriceClass_100, sse_paths = ["/mcp/stream*"],
  # spa_error_responses = true, geo_restriction_type = "none",
  # enable_failover = false.

  extra_tags = {
    Owner   = "platform"
    Example = "cloudfront-dist-basic"
  }
}

###############################################################################
# Outputs — surface load-bearing values.
###############################################################################

output "bucket_name" {
  value = module.test_bucket.bucket_name
}

output "distribution_id" {
  value = module.cloudfront_dist.distribution_id
}

output "distribution_arn" {
  value       = module.cloudfront_dist.distribution_arn
  description = "Feed back into module.test_bucket.cloudfront_distribution_arn on a follow-up apply for tighter SourceArn scoping."
}

output "distribution_domain_name" {
  value = module.cloudfront_dist.distribution_domain_name
}

output "waf_acl_arn" {
  value = module.cloudfront_dist.waf_acl_arn
}

output "route53_record_fqdns" {
  value = module.cloudfront_dist.route53_record_fqdns
}
