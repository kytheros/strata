###############################################################################
# strata custom-domain — ACM cert + API GW custom domain + API mapping
#
# What this module creates:
#   - 1 aws_acm_certificate (DNS validation, RSA-2048) in the same region as
#     the API GW. NOT us-east-1-pinned: regional API GW HTTP custom domains
#     require the cert in the API's own region (the us-east-1 pin is a
#     CloudFront constraint, not an API GW one).
#   - 1 aws_acm_certificate_validation that gates the rest of the graph until
#     the operator has pasted the validation CNAMEs into Cloudflare and ACM
#     has flipped the cert to ISSUED. Without this gate the api-gateway
#     domain-name resource fails fast on a pending cert.
#   - 1 aws_apigatewayv2_domain_name (regional endpoint, TLS 1.2) consuming
#     the validated cert.
#   - 1 aws_apigatewayv2_api_mapping joining the custom domain to a specific
#     API + stage.
#
# What this module deliberately does NOT do:
#   - Create DNS records. The operator owns DNS for kytheros.dev in
#     Cloudflare; this module emits the records they need to paste via
#     outputs.cloudflare_dns_records. A future iteration could add an
#     optional `cloudflare` provider integration, but right now the
#     copy-paste loop is the explicit, auditable contract.
#   - Manage Route 53. There is no Route 53 hosted zone for kytheros.dev —
#     all DNS lives in Cloudflare. Adding the route53 data source / record
#     resources would force the operator to migrate the zone first.
#
# Why this is a separate module from `ingress`:
#   The ingress module is consumed by both ALB and API GW backends, and by
#   compositions that may not want a custom domain at all (e.g. ephemeral
#   PR previews keying off the raw `*.execute-api.*` URL). Splitting the
#   custom-domain wiring into its own module keeps the ingress module's
#   blast radius narrow and lets compositions toggle the domain on/off
#   independently of the ingress lifecycle.
#
# Two-pass apply pattern (operator-facing):
#   Apply 1: cert created → ACM emits validation CNAME(s) (visible via
#            `terraform output cloudflare_dns_records`). Plan apply BLOCKS
#            on aws_acm_certificate_validation until DNS is in place.
#   Operator: paste validation CNAME(s) into Cloudflare (DNS-only, grey
#             cloud — proxied / orange-cloud breaks the validation HTTP
#             path because Cloudflare returns its own cert at the edge).
#   Apply 2 (or same apply, after ~3 min): ACM flips to ISSUED, validation
#            resource resolves, api_mapping is created.
#   Operator: paste the final CNAME (aws.strata.kytheros.dev → API GW
#             regional domain) into Cloudflare. Sign-in works on the new
#             domain immediately.
#
# Lifecycle note on the cert:
#   `create_before_destroy = true` matters for cert ROTATION, not initial
#   creation. When the SAN list changes, Terraform issues a NEW cert,
#   waits for it to validate, then swaps it on the domain-name resource
#   before destroying the old cert. Without this, applying a SAN change
#   would briefly serve a 4xx while the cert is being torn down.
###############################################################################

locals {
  default_tags = {
    Project     = "strata"
    Component   = "custom-domain"
    ManagedBy   = "terraform"
    Environment = var.env_name
    Region      = var.aws_region
    Domain      = var.domain_name
  }

  tags = merge(local.default_tags, var.extra_tags)
}

###############################################################################
# 1. ACM certificate — DNS-validated, RSA-2048.
#
# DNS validation is the only sane choice when the operator's zone is on a
# foreign provider (Cloudflare in this case). Email validation requires a
# WHOIS-published admin address that kytheros.dev does not publish.
###############################################################################

resource "aws_acm_certificate" "this" {
  domain_name       = var.domain_name
  validation_method = "DNS"
  key_algorithm     = "RSA_2048"

  lifecycle {
    create_before_destroy = true
  }

  tags = local.tags
}

###############################################################################
# 2. ACM certificate validation gate.
#
# This resource is a no-op data-fetch that completes once the cert flips to
# ISSUED. We use its completion as the dependency edge for downstream
# resources — the api-gateway domain-name resource cannot consume a
# pending-validation cert (it errors out at apply with
# `BadRequestException: ACM Certificate ... is in pending state`).
#
# We DO NOT pass `validation_record_fqdns` here because the records live in
# Cloudflare, not Route 53. Without `validation_record_fqdns`, the resource
# polls ACM for the cert status and resolves once ACM marks it ISSUED.
# This is the documented external-DNS pattern.
###############################################################################

resource "aws_acm_certificate_validation" "this" {
  certificate_arn = aws_acm_certificate.this.arn

  # Long-poll: ACM validation can legitimately take a few minutes from when
  # the operator pastes the CNAME (DNS propagation + ACM polling cadence).
  timeouts {
    create = "30m"
  }
}

###############################################################################
# 3. API GW custom domain — regional endpoint, TLS 1.2 minimum.
#
# REGIONAL endpoint type matches the rest of the stack (the ingress module
# creates a regional HTTP API). The EDGE endpoint type is CloudFront-fronted
# and forces the cert into us-east-1, which we don't want here — that's
# what the cloudfront-dist module is for, separately.
###############################################################################

resource "aws_apigatewayv2_domain_name" "this" {
  domain_name = var.domain_name

  domain_name_configuration {
    certificate_arn = aws_acm_certificate_validation.this.certificate_arn
    endpoint_type   = "REGIONAL"
    security_policy = "TLS_1_2"
  }

  tags = local.tags
}

###############################################################################
# 4. API mapping — join domain ↔ API + stage.
#
# Mapping with an empty `api_mapping_key` makes the entire API reachable at
# the apex of the custom domain (i.e. https://aws.strata.kytheros.dev/...).
# Setting a key (e.g. "v1") would scope the API under /v1 — not what we
# want for a clean cutover from the raw execute-api URL.
###############################################################################

resource "aws_apigatewayv2_api_mapping" "this" {
  api_id      = var.apigw_api_id
  domain_name = aws_apigatewayv2_domain_name.this.id
  stage       = var.apigw_stage_name
}
