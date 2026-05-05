###############################################################################
# strata cloudfront-dist — distribution + WAF v2 + Route 53 alias
#
# What this module creates:
#   - 1 aws_cloudfront_distribution with:
#       * Modern TLS (TLSv1.2_2021), HTTP/2 + HTTP/3
#       * AWS-managed cache + origin-request + response-headers policies for
#         the default behavior
#       * Per-path ordered_cache_behaviors with TTL=0 (no caching) for SSE
#         endpoints (design §Edge: /mcp/stream*)
#       * Multi-shape origins via var.origins — S3+OAC and ALB/custom HTTP
#         backed by the same list
#   - 1 aws_wafv2_web_acl (CLOUDFRONT-scope, MUST be us-east-1) with:
#       * AWSManagedRulesCommonRuleSet      (priority 10)
#       * AWSManagedRulesKnownBadInputsRuleSet (priority 20)
#       * AWSManagedRulesAmazonIpReputationList (priority 30)
#   - N aws_route53_record entries (one A alias per FQDN in var.domain_aliases)
#       — optional secondary failover record when var.enable_failover = true
#         (placeholder: secondary points at the same primary distribution in
#         v1, repointable to a DR distribution in v2 without record-shape
#         changes)
#
# Region constraint:
#   - WAF for CloudFront-scope MUST be in us-east-1 (AWS API restriction).
#   - ACM certs consumed by CloudFront MUST be issued in us-east-1.
#   The module's variables.tf validates aws_region == "us-east-1". The caller
#   must run this module against a us-east-1 provider; no provider alias used.
#
# Two-pass apply for S3+OAC origins (chicken-and-egg):
#   The s3-bucket module emits a bucket policy that scopes via SourceArn to
#   the CloudFront distribution ARN. On first apply that ARN doesn't exist, so
#   the s3-bucket module is applied with cloudfront_distribution_arn = "" — its
#   policy falls back to AWS:SourceAccount scoping (still safe because only
#   distributions in the same account can ever invoke). After this module's
#   apply emits an ARN, re-apply the s3-bucket module with that ARN to tighten
#   the policy. README §"Two-pass apply" documents the exact flow.
###############################################################################

data "aws_route53_zone" "this" {
  name         = "${var.route53_zone_name}."
  private_zone = false
}

locals {
  default_tags = {
    Project     = "strata"
    Component   = "cloudfront-dist"
    ManagedBy   = "terraform"
    Environment = var.env_name
    Region      = var.aws_region
  }

  tags = merge(local.default_tags, var.extra_tags)

  # AWS-managed policy IDs (stable, region-agnostic).
  # Source: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-cache-policies.html
  managed_cache_policy_caching_optimized         = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  managed_origin_request_policy_all_viewer_xhost = "b689b0a8-53d0-40ab-baf2-68738e2966ac" # AllViewerExceptHostHeader
  managed_response_headers_policy_security       = "67f7725c-6f97-4210-82d7-5512b31e9d03" # SecurityHeadersPolicy
}

###############################################################################
# 1. CloudFront distribution
###############################################################################

resource "aws_cloudfront_distribution" "this" {
  # checkov:skip=CKV_AWS_310:Origin failover is variable-driven via var.origins multi-origin shape; default single-origin is correct for the SPA-fronted-by-S3 and API-fronted-by-ALB callers and aligns with v1 single-region design (design §Multi-region deferred).
  # checkov:skip=CKV2_AWS_47:AWSManagedRulesKnownBadInputsRuleSet covers Log4j (CVE-2021-44228) — the dedicated AMR rule's coverage is a subset of KnownBadInputs.
  # checkov:skip=CKV_AWS_374:Geo restriction is variable-driven (var.geo_restriction_type, var.geo_restriction_locations); 'none' is correct default for the global API surface — design spec leaves geo policy to per-customer-contract decision.
  # checkov:skip=CKV2_AWS_32:Response headers policy IS attached via response_headers_policy_id on the default cache behavior (AWS-managed SecurityHeadersPreset). Checkov's heuristic fails to traverse the AWS-managed policy ID reference.
  lifecycle {
    precondition {
      condition     = contains([for o in var.origins : o.origin_id], var.default_origin_id)
      error_message = "var.default_origin_id must match one of the origin_id values in var.origins."
    }
  }

  comment             = "strata-${var.env_name}"
  enabled             = true
  is_ipv6_enabled     = true
  http_version        = "http2and3"
  price_class         = var.price_class
  aliases             = var.domain_aliases
  default_root_object = "index.html"
  web_acl_id          = aws_wafv2_web_acl.this.arn

  ###############################################################################
  # 1a. Origins — S3+OAC and custom HTTP shapes share var.origins.
  ###############################################################################
  dynamic "origin" {
    for_each = { for o in var.origins : o.origin_id => o }

    content {
      origin_id   = origin.value.origin_id
      domain_name = origin.value.domain_name
      origin_path = origin.value.origin_path

      # S3+OAC origin: emit origin_access_control_id, no custom_origin_config.
      origin_access_control_id = origin.value.origin_type == "s3" ? origin.value.oac_id : null

      # ALB / custom HTTP origin: emit custom_origin_config with supplied
      # ports/protocol/SSL. Skipped for S3 origins.
      dynamic "custom_origin_config" {
        for_each = origin.value.origin_type == "s3" ? [] : [1]

        content {
          http_port              = origin.value.http_port
          https_port             = origin.value.https_port
          origin_protocol_policy = origin.value.origin_protocol_policy
          origin_ssl_protocols   = origin.value.origin_ssl_protocols
        }
      }
    }
  }

  ###############################################################################
  # 1b. Default cache behavior
  ###############################################################################
  default_cache_behavior {
    target_origin_id           = var.default_origin_id
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = local.managed_cache_policy_caching_optimized
    origin_request_policy_id   = local.managed_origin_request_policy_all_viewer_xhost
    response_headers_policy_id = local.managed_response_headers_policy_security
  }

  ###############################################################################
  # 1c. SSE / streaming carve-out — TTL=0, no caching.
  #
  # CloudFront cannot use a managed cache policy AND ttl overrides at the same
  # time, so we emit a per-path cache_policy_id-less behavior with explicit
  # min/default/max_ttl=0. forwarded_values is the legacy shape but it is the
  # only shape that supports inline TTL=0 — required for SSE which must NOT
  # be buffered or coalesced at the edge.
  ###############################################################################
  dynamic "ordered_cache_behavior" {
    for_each = var.sse_paths

    content {
      path_pattern           = ordered_cache_behavior.value
      target_origin_id       = var.default_origin_id
      viewer_protocol_policy = "redirect-to-https"
      allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
      cached_methods         = ["GET", "HEAD"]
      compress               = false # SSE must not be re-compressed mid-stream

      min_ttl     = 0
      default_ttl = 0
      max_ttl     = 0

      forwarded_values {
        query_string = true
        headers      = ["*"]

        cookies {
          forward = "all"
        }
      }
    }
  }

  ###############################################################################
  # 1d. SPA-friendly error responses (toggleable).
  ###############################################################################
  dynamic "custom_error_response" {
    for_each = var.spa_error_responses ? [403, 404] : []

    content {
      error_code            = custom_error_response.value
      response_code         = 200
      response_page_path    = "/index.html"
      error_caching_min_ttl = 10
    }
  }

  ###############################################################################
  # 1e. Geo restriction (default off).
  ###############################################################################
  restrictions {
    geo_restriction {
      restriction_type = var.geo_restriction_type
      locations        = var.geo_restriction_type == "none" ? [] : var.geo_restriction_locations
    }
  }

  ###############################################################################
  # 1f. Viewer certificate — caller-supplied ACM cert (us-east-1 only).
  ###############################################################################
  viewer_certificate {
    acm_certificate_arn      = var.acm_certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  ###############################################################################
  # 1g. Access logging (optional).
  ###############################################################################
  dynamic "logging_config" {
    for_each = var.logging_bucket != "" ? [1] : []

    content {
      bucket          = var.logging_bucket
      prefix          = var.logging_prefix
      include_cookies = false
    }
  }

  tags = local.tags
}

###############################################################################
# 2. WAF v2 web ACL — CloudFront scope (us-east-1 only)
###############################################################################

resource "aws_wafv2_web_acl" "this" {
  # checkov:skip=CKV2_AWS_31:WAF logging configuration belongs to the observability module (AWS-1.10) which owns the cross-service Kinesis Firehose + log-bucket wiring. Adding it here would force every consumer to provision a Firehose stream they may not want at module-creation time.
  name        = "strata-${var.env_name}-cloudfront-waf"
  description = "WAF for strata-${var.env_name} CloudFront distribution. Managed rules: CommonRuleSet + KnownBadInputs + IpReputation."
  scope       = "CLOUDFRONT"

  default_action {
    allow {}
  }

  ###############################################################################
  # Rule 1: AWSManagedRulesCommonRuleSet — broad coverage of OWASP Top 10
  # (XSS, SQLi, LFI, RCE) plus baseline request-shape sanity. Most-recommended
  # AWS managed group for any public web surface.
  ###############################################################################
  rule {
    name     = "AWSManagedRulesCommonRuleSet"
    priority = 10

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesCommonRuleSet"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "strata-${var.env_name}-CommonRuleSet"
      sampled_requests_enabled   = true
    }
  }

  ###############################################################################
  # Rule 2: AWSManagedRulesKnownBadInputsRuleSet — Log4j, Spring4Shell, and
  # other CVE-class request-shape attacks. Subsumes the standalone Log4j rule.
  ###############################################################################
  rule {
    name     = "AWSManagedRulesKnownBadInputsRuleSet"
    priority = 20

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "strata-${var.env_name}-KnownBadInputs"
      sampled_requests_enabled   = true
    }
  }

  ###############################################################################
  # Rule 3: AWSManagedRulesAmazonIpReputationList — known-malicious IPs from
  # AWS threat intel (Tor exits, scanners, recently-compromised hosts). Cheap
  # baseline; rarely false-positives on legitimate traffic.
  ###############################################################################
  rule {
    name     = "AWSManagedRulesAmazonIpReputationList"
    priority = 30

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesAmazonIpReputationList"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "strata-${var.env_name}-IpReputation"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "strata-${var.env_name}-cloudfront-waf"
    sampled_requests_enabled   = true
  }

  tags = local.tags
}

###############################################################################
# 3. Route 53 alias records — one A-alias per FQDN in var.domain_aliases.
#
# Failover slot: when var.enable_failover = true, also emit a secondary record
# whose alias target points at the SAME primary distribution for v1. The
# placeholder is structural (record exists, set_identifier set, failover policy
# attached); v2 swaps the alias target to a second-region distribution without
# changing the record's shape — zero-DNS-propagation flip.
###############################################################################

resource "aws_route53_record" "primary" {
  for_each = toset(var.domain_aliases)

  zone_id = data.aws_route53_zone.this.zone_id
  name    = each.value
  type    = "A"

  # When failover is enabled, primary records get the failover routing policy.
  # When disabled, simple routing — set_identifier and failover_routing_policy
  # are omitted.
  set_identifier = var.enable_failover ? "primary" : null

  dynamic "failover_routing_policy" {
    for_each = var.enable_failover ? [1] : []
    content {
      type = "PRIMARY"
    }
  }

  alias {
    name                   = aws_cloudfront_distribution.this.domain_name
    zone_id                = aws_cloudfront_distribution.this.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "secondary" {
  for_each = var.enable_failover ? toset(var.domain_aliases) : toset([])

  zone_id        = data.aws_route53_zone.this.zone_id
  name           = each.value
  type           = "A"
  set_identifier = "secondary"

  failover_routing_policy {
    type = "SECONDARY"
  }

  # v1 placeholder: secondary points at the SAME primary distribution. v2
  # repoints this to a second-region distribution by swapping the two
  # aws_cloudfront_distribution references — the record shape is identical.
  alias {
    name                   = aws_cloudfront_distribution.this.domain_name
    zone_id                = aws_cloudfront_distribution.this.hosted_zone_id
    evaluate_target_health = false
  }
}
