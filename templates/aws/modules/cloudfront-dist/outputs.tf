output "distribution_id" {
  description = "CloudFront distribution ID. Use to wire S3 bucket policies (SourceArn condition), CloudWatch alarms, and invalidation jobs."
  value       = aws_cloudfront_distribution.this.id
}

output "distribution_arn" {
  description = "CloudFront distribution ARN. Pass to the s3-bucket module's `cloudfront_distribution_arn` input on a follow-up apply to tighten the bucket-policy SourceArn condition (see README §Two-pass apply)."
  value       = aws_cloudfront_distribution.this.arn
}

output "distribution_domain_name" {
  description = "CloudFront-assigned domain (e.g. d1234abcd.cloudfront.net). Used as the alias target for Route 53 records — the module already wires the records, so callers rarely need this directly."
  value       = aws_cloudfront_distribution.this.domain_name
}

output "distribution_hosted_zone_id" {
  description = "Route 53 hosted zone ID for CloudFront aliases (Z2FDTNDATAQYW2 — global constant). Surfaced for callers wiring their own Route 53 records outside the module."
  value       = aws_cloudfront_distribution.this.hosted_zone_id
}

output "waf_acl_id" {
  description = "WAF v2 web ACL ID. Use to attach additional rules (rate limits, custom IP allow/deny) at the service-module layer if the baseline three managed groups are not enough."
  value       = aws_wafv2_web_acl.this.id
}

output "waf_acl_arn" {
  description = "WAF v2 web ACL ARN. Already attached to the distribution via web_acl_id. Surfaced for cross-module association (e.g. attaching the same ACL to a second distribution in v2 multi-region)."
  value       = aws_wafv2_web_acl.this.arn
}

output "route53_record_fqdns" {
  description = "List of FQDNs for which Route 53 alias records were created. Equals var.domain_aliases when enable_failover = false; same list, doubled (one primary + one secondary per FQDN) when enable_failover = true."
  value = concat(
    [for r in aws_route53_record.primary : r.fqdn],
    [for r in aws_route53_record.secondary : r.fqdn],
  )
}

output "route53_zone_id" {
  description = "Resolved Route 53 hosted zone ID. Surfaced so callers wiring additional records (CNAMEs for verification, MX, etc.) on the same zone don't have to re-do the data-source lookup."
  value       = data.aws_route53_zone.this.zone_id
}
