###############################################################################
# Example: deploy the s3-bucket module with CloudFront OAC end-to-end.
#
# What this demonstrates:
#   - purpose = "user-data" (private bucket, fronted by CloudFront via OAC)
#   - module creates the OAC + bucket policy with AllowCloudFrontServicePrincipal
#   - a stub aws_cloudfront_distribution consumes the OAC and the bucket as
#     its origin
#   - the chicken-and-egg loop (bucket policy needs distribution ARN; the
#     distribution depends on the OAC + the origin bucket) is broken by
#     leaving cloudfront_distribution_arn empty on the first apply (policy
#     scopes via aws:SourceAccount), then re-applying with the ARN populated
#     for tighter SourceArn scoping.
#
# This is NOT a production-quality CDN config. It uses CloudFront's default
# certificate (no ACM/Route 53 wiring), no WAF, PriceClass_100, and a single
# bare origin. AWS-1.7 (cloudfront-dist module) ships the production form.
#
# Run from this directory:
#   terraform init
#   terraform validate    # validation only — full plan/apply not required
###############################################################################

terraform {
  required_version = "~> 1.7"

  backend "s3" {
    bucket         = "terraform-state-624990353897-dev"
    key            = "examples/s3-bucket-with-oac/terraform.tfstate"
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
  allowed_account_ids = ["624990353897"]
}

###############################################################################
# 1. The bucket — private + OAC-enabled
###############################################################################

module "user_data_bucket" {
  # checkov:skip=CKV_AWS_109:KMS key policy uses `kms:*` to account root — see modules/s3-bucket/main.tf rationale.
  # checkov:skip=CKV_AWS_111:Same — write access via `kms:*` is scoped to a single key.
  # checkov:skip=CKV_AWS_356:`Resource: *` in a key policy refers only to this key by AWS spec.
  source = "../.."

  env_name = "dev"
  purpose  = "user-data"

  cloudfront_oac_enabled = true

  # Note: cloudfront_distribution_arn left empty on first apply. After the
  # CloudFront distribution stabilizes, set this to
  # `aws_cloudfront_distribution.stub.arn` and re-apply to tighten the
  # bucket-policy SourceArn condition.

  extra_tags = {
    Owner = "platform"
  }
}

###############################################################################
# 2. Stub CloudFront distribution wired through the OAC
#
# Minimal viable config — uses the default CloudFront certificate (no ACM,
# no custom domain), no WAF, no Route 53 record, single origin, single
# default cache behavior. Production wiring lives in modules/cloudfront-dist
# (AWS-1.7).
###############################################################################

resource "aws_cloudfront_distribution" "stub" {
  # This is an EXAMPLE-ONLY stub. The production CloudFront wiring lives in
  # AWS-1.7 (modules/cloudfront-dist) — that module ships ACM, WAF, custom
  # origin failover, response headers policy, geo restriction, and access
  # logging. The skips below acknowledge those gaps in the stub.
  #
  # checkov:skip=CKV_AWS_86:Access logs are owned by the cloudfront-dist module (AWS-1.7); not appropriate for an OAC-wiring example.
  # checkov:skip=CKV_AWS_310:Origin failover is multi-origin design; this stub has one origin.
  # checkov:skip=CKV_AWS_374:Geo restriction is policy-level; cloudfront-dist module owns it.
  # checkov:skip=CKV_AWS_174:Default cert ships with TLS 1.0 minimum; cloudfront-dist module bumps to TLSv1.2_2021 with custom certs.
  # checkov:skip=CKV_AWS_68:WAF is owned by the cloudfront-dist module; not appropriate for a bucket-OAC example.
  # checkov:skip=CKV2_AWS_42:Custom SSL cert (and ACM wiring) is the cloudfront-dist module's job.
  # checkov:skip=CKV2_AWS_32:Response headers policy is owned by the cloudfront-dist module.
  # checkov:skip=CKV2_AWS_47:Log4j AMR rule lives in the WAF that the cloudfront-dist module attaches.
  # checkov:skip=CKV_AWS_305:No default root object — this stub is for OAC-wiring validation only; cloudfront-dist module sets index.html or similar.
  enabled         = true
  is_ipv6_enabled = true
  comment         = "Stub distribution exercising s3-bucket OAC wiring (env=dev, purpose=user-data)."
  price_class     = "PriceClass_100"

  origin {
    domain_name              = module.user_data_bucket.bucket_regional_domain_name
    origin_access_control_id = module.user_data_bucket.oac_id
    origin_id                = "user-data-origin"
  }

  default_cache_behavior {
    target_origin_id       = "user-data-origin"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]

    # AWS-managed CachingOptimized policy (no header/cookie/query forwarding;
    # 1d default TTL). Real distribution uses a custom policy.
    cache_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = {
    Project     = "strata"
    Component   = "s3-bucket-example"
    ManagedBy   = "terraform"
    Environment = "dev"
    Purpose     = "user-data-cf-stub"
  }
}

###############################################################################
# Outputs
###############################################################################

output "bucket_name" {
  value = module.user_data_bucket.bucket_name
}

output "bucket_arn" {
  value = module.user_data_bucket.bucket_arn
}

output "kms_key_arn" {
  value = module.user_data_bucket.kms_key_arn
}

output "oac_id" {
  value = module.user_data_bucket.oac_id
}

output "cloudfront_distribution_arn" {
  value       = aws_cloudfront_distribution.stub.arn
  description = "ARN to feed back into module.user_data_bucket.cloudfront_distribution_arn on a follow-up apply for tighter SourceArn scoping."
}

output "cloudfront_domain_name" {
  value = aws_cloudfront_distribution.stub.domain_name
}
