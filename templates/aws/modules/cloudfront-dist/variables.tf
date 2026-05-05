variable "env_name" {
  description = "Environment short name (dev|staging|prod). Used in resource naming and tags."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.env_name)
    error_message = "env_name must be one of: dev, staging, prod."
  }
}

variable "aws_region" {
  description = <<-EOT
    AWS region. Default us-east-1 — and this is the only supported value.
    CloudFront-scoped WAF v2 web ACLs MUST live in us-east-1, and ACM certificates
    used by a CloudFront distribution MUST be issued in us-east-1. The module
    pins the calling provider to us-east-1; running it from any other region is
    not supported. The variable exists so callers can surface the constraint
    explicitly in tfvars rather than discovering it via apply errors.
  EOT
  type        = string
  default     = "us-east-1"

  validation {
    condition     = var.aws_region == "us-east-1"
    error_message = "aws_region must be us-east-1. CloudFront-scoped WAF and ACM certs are us-east-1-only."
  }
}

variable "domain_aliases" {
  description = <<-EOT
    List of FQDNs to attach as CloudFront aliases AND create matching Route 53 A
    alias records for. Each entry must be a subdomain of var.route53_zone_name.
    Example: ["api.strata-aws.kytheros.dev"].
  EOT
  type        = list(string)

  validation {
    condition     = length(var.domain_aliases) > 0
    error_message = "domain_aliases must contain at least one FQDN."
  }
}

variable "route53_zone_name" {
  description = "Route 53 hosted zone name (no trailing dot) where alias records get created. Default 'kytheros.dev' — the project's existing zone."
  type        = string
  default     = "kytheros.dev"
}

variable "acm_certificate_arn" {
  description = <<-EOT
    ARN of the ACM certificate to attach to the CloudFront distribution.
    MUST be issued in us-east-1 — CloudFront cannot consume certs from any
    other region. The module does not create the cert; the caller provisions
    it (DNS-validated in Route 53 is the recommended pattern).
  EOT
  type        = string

  validation {
    condition     = can(regex("^arn:aws:acm:us-east-1:[0-9]{12}:certificate/[a-zA-Z0-9-]+$", var.acm_certificate_arn))
    error_message = "acm_certificate_arn must be a valid us-east-1 ACM certificate ARN."
  }
}

variable "origins" {
  description = <<-EOT
    List of CloudFront origin definitions. One element shape per origin:

      {
        origin_id   = "primary-s3"          # unique within the distribution
        origin_type = "s3" | "alb" | "custom"
        domain_name = "..."                 # e.g. bucket_regional_domain_name OR alb_dns_name

        # Required when origin_type = "s3":
        oac_id      = optional(string, "")  # CloudFront Origin Access Control id

        # Required when origin_type = "alb" or "custom":
        http_port            = optional(number, 80)
        https_port           = optional(number, 443)
        origin_protocol_policy = optional(string, "https-only")  # "http-only" | "https-only" | "match-viewer"
        origin_ssl_protocols   = optional(list(string), ["TLSv1.2"])
        origin_path            = optional(string, "")
      }

    For S3 + OAC: pass domain_name = bucket_regional_domain_name and oac_id =
    s3-bucket module's `oac_id` output. The module emits no custom_origin_config
    block in that case (S3+OAC is the AWS-recommended bucket-as-origin shape).

    For ALB / custom HTTP origins: oac_id is ignored; the module emits a
    custom_origin_config block with the supplied port/protocol/SSL fields.
  EOT
  type = list(object({
    origin_id              = string
    origin_type            = string
    domain_name            = string
    oac_id                 = optional(string, "")
    http_port              = optional(number, 80)
    https_port             = optional(number, 443)
    origin_protocol_policy = optional(string, "https-only")
    origin_ssl_protocols   = optional(list(string), ["TLSv1.2"])
    origin_path            = optional(string, "")
  }))

  validation {
    condition     = length(var.origins) > 0
    error_message = "origins must contain at least one origin definition."
  }

  validation {
    condition     = alltrue([for o in var.origins : contains(["s3", "alb", "custom"], o.origin_type)])
    error_message = "Each origin's origin_type must be one of: s3, alb, custom."
  }

  validation {
    condition     = length(var.origins) == length(distinct([for o in var.origins : o.origin_id]))
    error_message = "All origin_id values must be unique within the distribution."
  }
}

variable "default_origin_id" {
  description = "origin_id of the origin that backs the default cache behavior. Must match exactly one entry in var.origins."
  type        = string
}

variable "price_class" {
  description = <<-EOT
    CloudFront price class. PriceClass_100 (US/Canada/Europe) is the design
    default per spec §Open Questions — adequate for portfolio demo and most
    NA/EU customers. PriceClass_200 adds Asia/Middle East/Africa. PriceClass_All
    triples per-GB cost; only use when global coverage is contractually required.
  EOT
  type        = string
  default     = "PriceClass_100"

  validation {
    condition     = contains(["PriceClass_100", "PriceClass_200", "PriceClass_All"], var.price_class)
    error_message = "price_class must be one of: PriceClass_100, PriceClass_200, PriceClass_All."
  }
}

variable "sse_paths" {
  description = <<-EOT
    Path patterns that must NOT be cached at the CloudFront edge — typically
    SSE / streaming endpoints. Each entry gets an ordered_cache_behavior with
    min_ttl=default_ttl=max_ttl=0 (CloudFront proxies every request, no
    buffering). Default ["/mcp/stream*"] — the Strata MCP HTTP transport's
    streamable endpoint, per design §Edge.
  EOT
  type        = list(string)
  default     = ["/mcp/stream*"]
}

variable "spa_error_responses" {
  description = <<-EOT
    When true, custom error responses for 403/404 return /index.html with HTTP
    200 — standard SPA-friendly behavior so React/Next.js client routers handle
    deep links. Set false for non-SPA origins (raw API, static asset CDN) where
    surfacing the upstream error code is preferable.
  EOT
  type        = bool
  default     = true
}

variable "logging_bucket" {
  description = <<-EOT
    S3 bucket regional domain name (NOT bucket name) for CloudFront access logs.
    Default empty — no access logging. When set, must be a bucket configured
    with `Object Ownership: BucketOwnerPreferred` and an ACL grant allowing
    CloudFront's awslogsdelivery account to write — the s3-bucket module's
    `logs` purpose plus a caller-owned ACL grant covers this. Pass the bucket's
    `bucket_regional_domain_name` output, e.g. `strata-logs-…s3.amazonaws.com`.
  EOT
  type        = string
  default     = ""
}

variable "logging_prefix" {
  description = "Object key prefix for CloudFront access log objects. Default 'cloudfront/'. Ignored when logging_bucket is empty."
  type        = string
  default     = "cloudfront/"
}

variable "geo_restriction_type" {
  description = "Geo-restriction mode: 'none' (default), 'whitelist', or 'blacklist'."
  type        = string
  default     = "none"

  validation {
    condition     = contains(["none", "whitelist", "blacklist"], var.geo_restriction_type)
    error_message = "geo_restriction_type must be one of: none, whitelist, blacklist."
  }
}

variable "geo_restriction_locations" {
  description = "ISO 3166-1 alpha-2 country codes for whitelist/blacklist. Empty when geo_restriction_type = 'none'."
  type        = list(string)
  default     = []
}

variable "enable_failover" {
  description = <<-EOT
    When true, also create a Route 53 secondary failover record per alias.
    The secondary record's alias target points to the same primary distribution
    in v1 (placeholder slot — design §Architecture: 'secondary slot empty,
    v2-ready'). When v2 stands up a second-region distribution, the secondary
    record's target gets repointed without a record-shape change. Default false.
  EOT
  type        = bool
  default     = false
}

variable "extra_tags" {
  description = "Additional tags merged into the default tag set."
  type        = map(string)
  default     = {}
}
