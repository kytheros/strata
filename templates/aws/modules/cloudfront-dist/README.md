# `aws/modules/cloudfront-dist` — distribution + WAF v2 + Route 53 alias

**Tool choice: Terraform (OpenTofu compatible).** Reason: matches the rest of the AWS deploy template; CloudFront + WAF v2 + Route 53 form a tightly-coupled resource graph (alias target depends on the distribution; bucket policy depends on the distribution ARN; WAF must be attached at distribution-create time) that Terraform's plan model surfaces clearly. CDK would also be reasonable — `aws-cdk-lib/aws-cloudfront` covers the surface — but mixing IaC tools across the AWS deploy adds review friction without proportional benefit.

## What this creates

The production CDN front-door for the Strata-on-AWS deploy: TLS-terminating, WAF-protected, Route-53-aliased CloudFront distribution backed by one or more origins (S3 + OAC and / or ALB / custom HTTP).

| Resource | Count | Notes |
|---|---|---|
| `aws_cloudfront_distribution` | 1 | `comment = strata-{env}`. HTTP/2+3, IPv6, TLSv1.2_2021 minimum, SNI-only. Default behavior uses AWS-managed `Managed-CachingOptimized` + `Managed-AllViewerExceptHostHeader` + `Managed-SecurityHeadersPreset`. SPA-friendly 403/404 → `/index.html` (toggle-able). |
| `aws_wafv2_web_acl` | 1 | `scope = "CLOUDFRONT"` (mandatory us-east-1). Three AWS-managed rule groups: `CommonRuleSet` (priority 10), `KnownBadInputsRuleSet` (priority 20), `AmazonIpReputationList` (priority 30). Default action `allow`. |
| `aws_route53_record` (primary) | N | One per FQDN in `var.domain_aliases`. Type A alias → distribution. Failover policy attached only when `var.enable_failover = true`. |
| `aws_route53_record` (secondary) | 0 or N | Created only when `var.enable_failover = true`. Placeholder slot — alias target points at the same primary distribution in v1; v2 multi-region repoints it to a DR distribution. |

All resources tagged `Project=strata`, `Component=cloudfront-dist`, `ManagedBy=terraform`, `Environment={env_name}`.

## Region constraint — us-east-1 only

CloudFront has two hard us-east-1 dependencies that the module enforces via variable validation:

1. **WAF v2 with `scope = "CLOUDFRONT"`** can only be created in us-east-1. There is no provider-alias workaround that delivers a different result.
2. **ACM certificates consumed by a CloudFront distribution** must be issued in us-east-1. Certs from any other region fail at distribution-create time.

The module pins both behaviors by validating `var.aws_region == "us-east-1"`. The caller must run this module against a us-east-1 provider context. No multi-provider / `provider = aws.us-east-1` alias indirection — the dev account is already us-east-1, and adding alias plumbing for a constraint that is never going to relax is a needless cost.

## Two-pass apply for S3+OAC origins

The s3-bucket module (`AWS-1.6`) emits a bucket policy with an `AllowCloudFrontServicePrincipalReadOnly` statement scoped via `AWS:SourceArn` to the CloudFront distribution ARN. That ARN doesn't exist on the very first apply, creating a chicken-and-egg loop. The s3-bucket module already handles this by accepting an empty `cloudfront_distribution_arn` and falling back to `AWS:SourceAccount` (still safe — only distributions in the same account can ever invoke it). The full flow:

```
Pass 1 — apply s3-bucket with cloudfront_distribution_arn = "" → bucket + OAC + account-scoped policy
Pass 2 — apply cloudfront-dist with origins[*].oac_id = module.bucket.oac_id → distribution exists, ARN known
Pass 3 — re-apply s3-bucket with cloudfront_distribution_arn = module.cloudfront_dist.distribution_arn → policy tightens to per-distribution SourceArn
```

Pass 3 is optional in dev (the SourceAccount fallback is operationally safe), but `security-compliance` will request it for staging/prod review. The example in `examples/basic/` illustrates pass 1 + pass 2 (the s3-bucket stub is intentionally not re-applied with a tighter ARN — that's a documented follow-up).

## SSE / streaming carve-out

CloudFront's default cache behavior uses `Managed-CachingOptimized` (1-day TTL, query/cookie/header stripping). That kills SSE: the edge buffers the response until the upstream closes the connection. The module emits one `ordered_cache_behavior` per entry in `var.sse_paths` with `min_ttl = default_ttl = max_ttl = 0` and `forwarded_values { query_string = true; headers = ["*"]; cookies { forward = "all" } }` — proxies every byte without buffering or coalescing.

Default `sse_paths = ["/mcp/stream*"]` matches the Strata MCP HTTP transport's streamable endpoint. Add other patterns as services land:

```hcl
sse_paths = [
  "/mcp/stream*",         # Strata MCP HTTP streamable
  "/api/agent/stream*",   # example-agent SSE chat stream (if added)
]
```

## Multi-shape origins via `var.origins`

The same list-of-objects variable supports both S3+OAC and ALB / custom HTTP origins. Each entry's `origin_type` field selects the shape:

```hcl
origins = [
  {
    origin_id   = "primary-bucket"
    origin_type = "s3"
    domain_name = module.user_data_bucket.bucket_regional_domain_name
    oac_id      = module.user_data_bucket.oac_id
  },
  {
    origin_id              = "primary-alb"
    origin_type            = "alb"
    domain_name            = module.alb.dns_name
    https_port             = 443
    origin_protocol_policy = "https-only"
    origin_ssl_protocols   = ["TLSv1.2"]
  },
]
default_origin_id = "primary-alb"
```

For S3 origins, the module emits `origin_access_control_id` and skips `custom_origin_config`. For `alb` / `custom` origins, the inverse — `custom_origin_config` is emitted and `origin_access_control_id` is null. Mixing both shapes in one distribution (e.g. SPA on S3 + API on ALB with path-based routing) is supported by the design but requires the caller to add `ordered_cache_behavior`s mapping path patterns to origin IDs at the service-module layer (the module's v1 surface only ships SSE carve-outs as pre-baked ordered behaviors).

## Inputs

See `variables.tf` for the full list with validations.

| Variable | Required? | Default | Notes |
|---|---|---|---|
| `env_name` | yes | — | One of `dev`, `staging`, `prod`. |
| `aws_region` | no | `us-east-1` | Validated == us-east-1. CloudFront WAF + ACM constraint. |
| `domain_aliases` | yes | — | List of FQDNs. Each must be a subdomain of `route53_zone_name`. |
| `route53_zone_name` | no | `kytheros.dev` | Project's existing hosted zone. Looked up via data source. |
| `acm_certificate_arn` | yes | — | us-east-1 ACM cert ARN. Module does not create the cert. |
| `origins` | yes | — | List of `{origin_id, origin_type, domain_name, ...}`. See "Multi-shape origins". |
| `default_origin_id` | yes | — | Must match exactly one entry in `origins`. |
| `price_class` | no | `PriceClass_100` | US/Canada/Europe — design default per spec §Open Questions. |
| `sse_paths` | no | `["/mcp/stream*"]` | TTL=0 path patterns. |
| `spa_error_responses` | no | `true` | 403/404 → /index.html for SPA-friendly routing. |
| `logging_bucket` | no | `""` | Empty disables access logging. Pass an S3 bucket regional domain name to enable. |
| `logging_prefix` | no | `cloudfront/` | Object key prefix when logging enabled. |
| `geo_restriction_type` | no | `none` | One of `none`, `whitelist`, `blacklist`. |
| `geo_restriction_locations` | no | `[]` | ISO-3166-1 alpha-2 codes. |
| `enable_failover` | no | `false` | When true, also creates secondary R53 records (placeholder for v2 multi-region). |
| `extra_tags` | no | `{}` | Merged into default tags. |

## Outputs

`distribution_id`, `distribution_arn`, `distribution_domain_name`, `distribution_hosted_zone_id`, `waf_acl_id`, `waf_acl_arn`, `route53_record_fqdns`, `route53_zone_id`.

## Examples

- `examples/basic/` — single S3+OAC origin in dev, one alias on `dev.test.kytheros.dev`, a placeholder ACM cert ARN. `terraform validate` clean; `terraform plan` against the real account fails on the placeholder cert (documented as expected).

## Caller patterns

### CloudFront in front of an ALB

```hcl
module "cloudfront_dist" {
  source = "../../modules/cloudfront-dist"

  env_name             = "dev"
  domain_aliases       = ["api.strata-aws.kytheros.dev"]
  acm_certificate_arn  = aws_acm_certificate.api.arn

  origins = [{
    origin_id              = "strata-alb"
    origin_type            = "alb"
    domain_name            = module.alb.dns_name
    origin_protocol_policy = "https-only"
  }]

  default_origin_id = "strata-alb"
  sse_paths         = ["/mcp/stream*"]
}
```

### CloudFront in front of an S3 SPA

```hcl
module "cloudfront_dist" {
  source = "../../modules/cloudfront-dist"

  env_name             = "dev"
  domain_aliases       = ["app.strata-aws.kytheros.dev"]
  acm_certificate_arn  = aws_acm_certificate.app.arn

  origins = [{
    origin_id   = "strata-spa"
    origin_type = "s3"
    domain_name = module.spa_bucket.bucket_regional_domain_name
    oac_id      = module.spa_bucket.oac_id
  }]

  default_origin_id   = "strata-spa"
  spa_error_responses = true # 403/404 → /index.html for client-side router
}
```

## How to run (dev account, today)

```bash
# 1. Confirm identity
aws sts get-caller-identity   # mike-cli @ 624990353897

# 2. From modules/cloudfront-dist/examples/basic/
terraform init
terraform validate
# Note: terraform plan against the real account will fail because
# examples/basic/ uses a placeholder ACM cert ARN. Validate-only is the
# documented stop point until a real cert exists for *.test.kytheros.dev.
```

## Cost

| Component | Monthly idle |
|---|---|
| CloudFront distribution | $0 (pay per request + GB transferred; PriceClass_100 keeps per-GB cost low) |
| WAF v2 web ACL | $5.00 (per ACL, regardless of traffic) |
| WAF managed rule groups (3) | $3.00 ($1.00 each for CommonRuleSet, KnownBadInputs, IpReputation) |
| WAF request charges | ~$0 at idle ($0.60/M requests) |
| Route 53 alias records | ~$0.50/zone-month (record itself is free; the hosted zone is the floor cost shared across all records) |
| **Total at idle** | **~$8 / month** |

At dev demo traffic (< 1k req/day), all-up is ~$8/mo. WAF is the dominant idle line item; if a portfolio walkthrough doesn't need WAF, the module can be re-pointed at a lighter `aws_wafv2_web_acl` shape (drop priority-30 IpReputation to skip $1) — but the design baseline ships all three.

## Reviewers required before apply

- **`security-compliance`** — WAF rule selection, geo-restriction policy, TLS minimum version, OAC bucket-policy SourceArn scoping (the two-pass apply pattern), Route 53 record exposure of internal hostnames. **Request review on the WAF rule list specifically — adding/dropping a managed rule group is a security policy decision, not a tuning knob.**
- **`network-architect`** — formal owner of this module per the plan (read-only). Confirm origin protocol policy (https-only on ALB origins; should match the ALB listener), SSE carve-out path patterns match the actual transport routes, Route 53 zone choice.
- **`finops-analyst`** — confirm the WAF + managed-rule-group cost projection if multiple distributions are stood up (each carries its own $5 ACL + $3 rule groups).
- **`observability-sre`** — adds CloudFront 4xx/5xx, WAF blocked-request, and Route 53 health check alarms after apply.

## Verification (post-apply)

```bash
# Distribution exists, deployed (state == "Deployed" not "InProgress")
aws cloudfront get-distribution --id <distribution_id> \
  --query 'Distribution.{Status:Status,Domain:DomainName,Aliases:DistributionConfig.Aliases.Items}'

# WAF attached
aws wafv2 list-resources-for-web-acl --scope CLOUDFRONT \
  --web-acl-arn <waf_acl_arn> --resource-type CLOUDFRONT

# Three managed rule groups present
aws wafv2 get-web-acl --scope CLOUDFRONT --id <waf_acl_id> \
  --name strata-dev-cloudfront-waf \
  --query 'WebACL.Rules[].Name'

# Route 53 records resolve
dig api.strata-aws.kytheros.dev
nslookup api.strata-aws.kytheros.dev

# TLS posture
curl -vI https://api.strata-aws.kytheros.dev/health 2>&1 | grep -E '(TLS|SSL|HTTP)'
```

## Related tickets

- **This:** AWS-1.7 (`specs/2026-04-25-strata-deploy-aws-plan.md`).
- **Blocked-by:** AWS-1.6 (`s3-bucket`) — supplies `bucket_regional_domain_name` and `oac_id` for S3 origin shape.
- **Unblocks on apply:**
  - **AWS-2.1** — Strata MCP service runs behind this distribution (CloudFront → ALB → Fargate). Wire `domain_aliases = ["api.strata-aws.kytheros.dev"]` and the `alb` origin shape.
  - **AWS-3.1** — example-agent UI runs behind this distribution (CloudFront → ALB → Next.js Fargate task) on a different alias (e.g. `agent.strata-aws.kytheros.dev`). One distribution per service is the v1 pattern; v2 may consolidate behind a single distribution with path-based routing if cost requires.
- **Coordinates with:**
  - **AWS-1.6** (`s3-bucket`) — two-pass apply pattern for OAC bucket policy SourceArn tightening.
  - **AWS-1.10** (`observability`) — alarms on CloudFront 4xx/5xx ratios, WAF blocked-request rate, Route 53 health checks.
