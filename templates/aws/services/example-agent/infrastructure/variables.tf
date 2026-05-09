###############################################################################
# Inputs for the example-agent service composition.
#
# This module is a *composition* — it stitches together the cognito-user-pool
# module, the ecs-service module, and a thin SSM-allowlist resource set. Most
# inputs flow straight through to the underlying modules.
###############################################################################

variable "env_name" {
  description = "Environment short name (dev|staging|prod). Used in resource naming and tags."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.env_name)
    error_message = "env_name must be one of: dev, staging, prod."
  }
}

variable "aws_region" {
  description = "AWS region. Cognito and SSM are regional; pass the same region the rest of the deploy uses."
  type        = string
  default     = "us-east-1"
}

###############################################################################
# Cognito federation — Google
###############################################################################

variable "google_client_id" {
  description = "Google OAuth client ID. Caller creates the OAuth app in GCP console; this module passes the ID through to the cognito-user-pool module's Google IdP wiring. Empty (default) means Google federation is skipped — the Hosted UI shows local-account sign-in only."
  type        = string
  default     = ""
}

variable "google_client_secret_arn" {
  description = "Secrets Manager ARN holding the Google OAuth client secret. Caller stores the secret separately (per cognito-user-pool README); this module passes the ARN through. Empty means Google federation is skipped."
  type        = string
  default     = ""
}

###############################################################################
# Pre-signup + Post-confirmation Lambdas
#
# AWS-3.2 made these composition-owned: the source lives at
# services/example-agent/lambdas/{pre-signup,post-confirmation}/ and the
# composition packages, deploys, and wires them into the cognito-user-pool
# module. No caller-facing variable is exposed for the ARNs anymore.
###############################################################################

###############################################################################
# Allowlist seed
###############################################################################

variable "initial_allowlist" {
  description = "Initial list of email addresses allowed to sign up. Stored as a JSON-encoded array in SSM Parameter Store at /example-agent/{env}/allowed-emails (KMS-encrypted SecureString). Operators edit the parameter directly post-apply — no redeploy needed for allowlist changes. No default — operator must seed via the orchestrator's terraform.tfvars (gitignored) so operator emails never land in the repo."
  type        = list(string)

  validation {
    condition     = length(var.initial_allowlist) >= 1
    error_message = "initial_allowlist must have at least one entry — an empty array would lock everyone out."
  }
}

###############################################################################
# Hosted UI URLs — env-specific public URL
###############################################################################

variable "app_url" {
  description = "Public URL of the example-agent (the front-door from the user's browser). Used as the Cognito callback_urls / logout_urls base and as APP_URL in the container env. Dev defaults to https://localhost:3000 because the example-agent runs locally during AWS-3.1 plan-only validation; staging/prod tfvars set it to the real public hostname (e.g. https://agent.strata-aws.kytheros.dev)."
  type        = string
  default     = "https://localhost:3000"
}

###############################################################################
# ECS service wiring
#
# Caller passes the cluster + network + ingress outputs. This module composes
# them into an ecs-service module call.
###############################################################################

variable "container_image" {
  description = "Container image URI for the Next.js app (typically an ECR-pushed tag built from services/example-agent/app/Dockerfile). Sentinel default keeps `terraform validate` happy — real applies must override."
  type        = string
  default     = "public.ecr.aws/example/example-agent:placeholder"
}

variable "cluster_arn" {
  description = "ECS cluster ARN. Pass the ecs-cluster module's cluster_arn output."
  type        = string
}

variable "execution_role_arn" {
  description = "ECS task execution role ARN. Used by the agent to pull images and write logs."
  type        = string
}

variable "log_group_name" {
  description = "CloudWatch log group name for container logs."
  type        = string
}

variable "vpc_id" {
  description = "VPC ID. Pass the network module's vpc_id output."
  type        = string
}

variable "vpc_cidr" {
  description = "VPC CIDR block. Pass the network module's vpc_cidr output."
  type        = string
}

variable "subnet_ids" {
  description = "Private subnet IDs for Fargate task ENIs."
  type        = list(string)
}

###############################################################################
# Ingress backend — ALB or API GW (matches the ingress module's backend var)
###############################################################################

variable "ingress_backend" {
  description = "Which ingress backend the service attaches to. `alb` → pass attach_to_alb_listener_arn + alb_listener_priority. `apigw` → pass attach_to_apigw_vpc_link_id + apigw_api_id."
  type        = string
  default     = "apigw"

  validation {
    condition     = contains(["alb", "apigw"], var.ingress_backend)
    error_message = "ingress_backend must be 'alb' or 'apigw'."
  }
}

variable "attach_to_alb_listener_arn" {
  description = "ALB HTTPS listener ARN (when ingress_backend = alb)."
  type        = string
  default     = ""
}

variable "alb_listener_priority" {
  description = "Listener-rule priority within the ALB (when ingress_backend = alb)."
  type        = number
  default     = 200
}

variable "attach_to_apigw_vpc_link_id" {
  description = "API GW VPC Link ID (when ingress_backend = apigw)."
  type        = string
  default     = ""
}

variable "apigw_api_id" {
  description = "API GW HTTP API ID (when ingress_backend = apigw)."
  type        = string
  default     = ""
}

variable "apigw_integration_uri" {
  description = "Backend URI for the API GW HTTP_PROXY integration (when ingress_backend = apigw AND var.enable_apigw_integration=true). Typically a private NLB or Service Connect endpoint."
  type        = string
  default     = ""
}

variable "enable_apigw_integration" {
  description = "Whether to create the stub `aws_apigatewayv2_integration` inside the underlying ecs-service module. Default true preserves backwards-compat with example-callers that wire a direct apigw -> ecs path through this module. The orchestrator path (envs/dev) sets this to false because services/ingress-authorizer owns the real catch-all $default integration. See Phase 5 second-cycle apply findings."
  type        = bool
  default     = true
}

variable "ingress_security_group_ids" {
  description = "Map of caller-chosen label -> security-group ID allowed to reach this service's task port. Pair with `var.ingress_security_group_labels` (static literal key list)."
  type        = map(string)
  default     = {}
}

variable "ingress_security_group_labels" {
  description = "Static literal list of labels matching the keys of var.ingress_security_group_ids. MUST be a literal at the call site so `for_each` can plan even when SG IDs are unknown until apply."
  type        = list(string)
  default     = []
}

###############################################################################
# Service Connect — registers the example-agent so internal callers (none
# in v1, but reserves the namespace surface) and exposes Strata's namespace.
# The example-agent reaches Strata via Service Connect by setting the same
# namespace_arn here; the URL it uses to reach Strata is derived from
# var.cluster_service_connect_namespace + var.strata_internal_port (already
# wired pre-1.6.1).
###############################################################################

variable "service_connect_namespace_arn" {
  description = "ARN of the Cloud Map namespace used for ECS Service Connect (from the orchestrator's `aws_service_discovery_http_namespace.this.arn`). When non-empty, the example-agent task joins the namespace so its Envoy sidecar can resolve `strata.<namespace>` into the Strata service. Empty disables Service Connect (legacy / unit-test path)."
  type        = string
  default     = ""
}

variable "service_connect_dns_name" {
  description = "DNS alias the example-agent registers under in Service Connect. Conventional value: `example-agent`. Reserved for future peer services that need to reach the example-agent internally; v1 has none. Ignored when service_connect_namespace_arn is empty."
  type        = string
  default     = "example-agent"
}

###############################################################################
# Cognito federation — App Client URLs flow through to the cognito-user-pool
# module. Default to localhost so a first plan-only apply works; real
# deployments override via terraform.tfvars.
###############################################################################

variable "callback_urls" {
  description = "OAuth callback URLs for the Cognito App Client. Defaults to localhost; tfvars override with the real domain. The /api/auth/callback route reads this value at request time, so adding new URLs here doesn't require a code change."
  type        = list(string)
  default     = ["https://localhost:3000/api/auth/callback"]
}

variable "logout_urls" {
  description = "OAuth logout URLs for the Cognito App Client."
  type        = list(string)
  default     = ["https://localhost:3000"]
}

variable "enable_test_user_client" {
  description = "When true, provisions a second Cognito app client configured for ADMIN_USER_PASSWORD_AUTH only. Used by the synthetic canary in env compositions. Default `false`."
  type        = bool
  default     = false
}

variable "attach_to_nlb_target_group_arn" {
  description = "Optional. ARN of an internal NLB target group the ECS service should register tasks with. When set, the ecs-service module wires the LoadBalancers block on the service so launched tasks join the target group as IP targets. Used by the env composition to expose the example-agent UI through API GW → VPC Link → NLB. Empty disables (default)."
  type        = string
  default     = ""
}

###############################################################################
# Strata-on-AWS internal endpoint — used by AWS-3.3 to dogfood Strata as
# the conversational memory backend. AWS-3.1 just passes the value through
# as an env var so the container can find Strata once AWS-2.1 ships.
###############################################################################

variable "strata_internal_url" {
  description = "Strata-on-AWS internal Service Connect URL (e.g. http://strata.strata-dev.local:3000). When non-empty, takes precedence over var.cluster_service_connect_namespace. When empty AND cluster_service_connect_namespace is set, the composition derives the URL as `http://strata.{namespace}.local:{strata_internal_port}`."
  type        = string
  default     = ""
}

variable "cluster_service_connect_namespace" {
  description = "Cloud Map namespace name used for ECS Service Connect (e.g. `strata-dev`). When non-empty AND var.strata_internal_url is empty, the composition derives STRATA_INTERNAL_URL as `http://strata.{namespace}.local:{strata_internal_port}` and surfaces it to the container. Empty (default) means Service Connect is not in use; caller must set strata_internal_url directly."
  type        = string
  default     = ""
}

variable "strata_internal_port" {
  description = "Port the Strata service listens on inside Service Connect. Matches the strata service's container_port (default 3000)."
  type        = number
  default     = 3000
}

variable "strata_auth_proxy_token_secret_arn" {
  description = "Secrets Manager ARN holding the STRATA_AUTH_PROXY_TOKEN (the shared secret the upstream proxy adds to X-Strata-Verified). Empty for AWS-3.1."
  type        = string
  default     = ""
}

variable "strata_auth_proxy_token_kms_key_arn" {
  description = "KMS CMK ARN encrypting the STRATA_AUTH_PROXY_TOKEN secret. When set, included in the runtime KMS carve-out for the deny-iam-secrets-kms-reads policy so the explicit Deny on kms:Decrypt does not shadow the legitimate runtime decrypt path. Phase 5 IAM review MEDIUM-1."
  type        = string
  default     = ""
}

###############################################################################
# Capacity / autoscaling — hand off to the ecs-service module
###############################################################################

variable "cpu" {
  description = "Fargate task CPU units. 512 is the AWS-3.1 default (Next.js standalone has modest CPU needs at idle)."
  type        = number
  default     = 512
}

variable "memory" {
  description = "Fargate task memory (MiB)."
  type        = number
  default     = 1024
}

variable "desired_count" {
  description = "Desired running task count. Dev = 1; staging/prod tfvars override to 2 for AZ redundancy."
  type        = number
  default     = 1
}

variable "container_port" {
  description = "Container port the Next.js app listens on. Matches the Dockerfile's EXPOSE."
  type        = number
  default     = 3000
}

###############################################################################
# ElastiCache Redis (AWS-3.3) — LRU cache for the SDK tool catalog.
#
# The example-agent's tool wrappers cache every read-only AWS SDK call to
# ElastiCache Redis Serverless with per-tool TTLs (30s for log tails,
# 1h for STS/cost). Caller passes the elasticache-redis module's outputs:
#   redis_endpoint   = module.cache.endpoint
#   redis_port       = module.cache.port
#   redis_auth_secret_arn = module.cache.auth_secret_arn
#   redis_auth_secret_consumer_iam_policy_json =
#     module.cache.auth_secret_consumer_iam_policy_json
# Empty defaults keep `terraform validate` green when the cache module
# isn't applied yet — the application gracefully falls through to direct
# SDK calls when REDIS_ENDPOINT is unset.
###############################################################################

variable "redis_endpoint" {
  description = "ElastiCache Redis Serverless endpoint hostname. Empty disables caching — every SDK call fires fresh."
  type        = string
  default     = ""
}

variable "redis_port" {
  description = "Redis port. Defaults to 6379 (ElastiCache Serverless standard)."
  type        = number
  default     = 6379
}

variable "redis_auth_secret_arn" {
  description = "Secrets Manager ARN holding the Redis AUTH token. Sourced from elasticache-redis module's auth_secret_arn output. Empty disables caching."
  type        = string
  default     = ""
}

variable "redis_auth_secret_consumer_iam_policy_json" {
  description = "Pre-baked least-privilege policy JSON granting GetSecretValue + KMS Decrypt on the Redis AUTH secret + its CMK. Sourced from elasticache-redis module's auth_secret_consumer_iam_policy_json output. Empty when caching is disabled."
  type        = string
  default     = ""
}

variable "redis_enabled" {
  description = "Static toggle that mirrors `var.redis_auth_secret_consumer_iam_policy_json != \"\"` from the caller's perspective. Required because Terraform's plan-time evaluator marks the policy_names list as 'known after apply' when the conditional `... != \"\" ? [...] : []` keys off an unknown string. Set true when Redis caching is wired; default false."
  type        = bool
  default     = false
}

variable "redis_auth_secret_kms_key_arn" {
  description = "KMS CMK ARN encrypting the Redis AUTH-token secret. Sourced from `module.elasticache_redis.kms_key_arn`. When set, included in the runtime KMS carve-out for the deny-iam-secrets-kms-reads policy so the explicit Deny on kms:Decrypt does not shadow the legitimate runtime decrypt path. Phase 5 IAM review MEDIUM-1."
  type        = string
  default     = ""
}

###############################################################################
# Tags
###############################################################################

variable "extra_tags" {
  description = "Additional tags merged into the default tag set."
  type        = map(string)
  default     = {}
}
