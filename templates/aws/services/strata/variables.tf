###############################################################################
# Identity
###############################################################################

variable "env_name" {
  description = "Environment short name (dev|staging|prod). Used in resource naming, tags, and the secret hierarchy under `strata/{env}/...`."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.env_name)
    error_message = "env_name must be one of: dev, staging, prod."
  }
}

variable "aws_region" {
  description = "AWS region. Default us-east-1 — matches the design spec's single-region v1 footprint."
  type        = string
  default     = "us-east-1"
}

###############################################################################
# Network — consumed from the `network` module
###############################################################################

variable "vpc_id" {
  description = "ID of the VPC. Comes from the `network` module's `vpc_id` output."
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR block of the VPC. Used by the underlying `ecs-service` module to emit a VPC-interior egress rule (catches Aurora + Redis + Service Connect peers)."
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet IDs the Strata Fargate tasks land in. Use the `network` module's `private_subnet_ids` output. Tasks reach AWS APIs via the VPC endpoints provisioned in AWS-1.1 and reach the internet via NAT only when those endpoints don't cover the call."
  type        = list(string)

  validation {
    condition     = length(var.private_subnet_ids) >= 2
    error_message = "private_subnet_ids must contain at least 2 subnets for AZ redundancy."
  }
}

###############################################################################
# Cluster wiring — consumed from the `ecs-cluster` module
###############################################################################

variable "cluster_arn" {
  description = "ARN of the ECS cluster (from `ecs-cluster` module's `cluster_arn` output)."
  type        = string
}

variable "cluster_execution_role_arn" {
  description = "ARN of the IAM role the ECS agent assumes to pull images, write logs, and resolve secrets at task-launch time. NOT the cluster's `exec_role_arn` (that role is the *operator* role for `aws ecs execute-command`); this is a separate task-execution role the consumer creates and grants `AmazonECSTaskExecutionRolePolicy` + secrets read on the DATABASE_URL/REDIS_AUTH/AUTH_PROXY secrets the task needs."
  type        = string
}

variable "cluster_log_group_name" {
  description = "Name of the cluster's CloudWatch log group (from `ecs-cluster` module's `log_group_name` output). Used as the awslogs target for the Strata container."
  type        = string
}

###############################################################################
# Aurora — consumed from the `aurora-postgres` module
###############################################################################

variable "aurora_proxy_endpoint" {
  description = "RDS Proxy endpoint hostname (from `aurora-postgres` module's `proxy_endpoint`). DATABASE_URL points at this, NOT the cluster writer endpoint."
  type        = string
}

variable "aurora_database_name" {
  description = "Aurora database name (from `aurora-postgres` module's `database_name`). Default `strata` matches the design spec convention."
  type        = string
  default     = "strata"
}

variable "aurora_master_username" {
  description = "Aurora master username (from `aurora-postgres` module's `master_username`). Used as the user in the synthesized DATABASE_URL."
  type        = string
}

variable "aurora_master_secret_arn" {
  description = "ARN of the Secrets Manager secret holding the Aurora master credential (from `aurora-postgres` module's `master_user_secret_arn`). RDS Proxy reads this transparently; Strata itself does NOT need direct access — DATABASE_URL embeds the password from this secret at task launch via the secrets module's reference indirection. See README §\"Why DATABASE_URL is a synthesized secret.\""
  type        = string
}

variable "aurora_consumer_iam_policy_json" {
  description = "Least-privilege IAM policy JSON granting `secretsmanager:GetSecretValue` on the Aurora master credential secret + `kms:Decrypt` on the cluster CMK. Comes from the `aurora-postgres` module's `consumer_iam_policy_json` output. Attached to the Strata task role."
  type        = string
}

variable "aurora_security_group_id" {
  description = "Security group ID protecting the Aurora cluster + RDS Proxy (from `aurora-postgres` module's `security_group_id`). The Strata service security group adds an egress rule allowing TCP/5432 to this SG."
  type        = string
}

###############################################################################
# Redis — consumed from the `elasticache-redis` module
###############################################################################

variable "redis_endpoint" {
  description = "ElastiCache Serverless endpoint hostname (from `elasticache-redis` module's `endpoint`). TLS is enforced — Strata connects via `rediss://`."
  type        = string
}

variable "redis_port" {
  description = "ElastiCache port (from `elasticache-redis` module's `port`). Always 6379 for Redis Serverless."
  type        = number
  default     = 6379
}

variable "redis_auth_secret_arn" {
  description = "ARN of the Secrets Manager secret holding the Redis AUTH token (from `elasticache-redis` module's `auth_secret_arn`). Injected into the Strata task as the REDIS_AUTH_TOKEN secret env var."
  type        = string
}

variable "redis_consumer_iam_policy_json" {
  description = "Least-privilege IAM policy JSON granting read access to the Redis AUTH-token secret + `kms:Decrypt` on the cache CMK. Comes from the `elasticache-redis` module's `auth_secret_consumer_iam_policy_json`. Attached to the Strata task role."
  type        = string
}

variable "redis_security_group_id" {
  description = "Security group ID protecting the ElastiCache cluster (from `elasticache-redis` module's `security_group_id`). The Strata service security group adds an egress rule allowing TCP/6379 to this SG."
  type        = string
}

###############################################################################
# Cognito — consumed from the `cognito-user-pool` module
###############################################################################

variable "cognito_user_pool_id" {
  description = "Cognito User Pool ID (from `cognito-user-pool` module's `user_pool_id`). Wired into the ingress JWT authorizer; the Strata service itself trusts the proxy header (see README §Auth flow)."
  type        = string
}

variable "cognito_user_pool_client_id" {
  description = "Cognito App Client ID (from `cognito-user-pool` module's `user_pool_client_id`). Wired into the ingress JWT authorizer's audience list."
  type        = string
}

variable "cognito_jwks_uri" {
  description = "Cognito User Pool JWKS URI (from `cognito-user-pool` module's `jwks_uri`). Documented in this module's README as the URL the ingress JWT verifier fetches at boot. Strata itself does NOT call this URI — JWT verification happens at the ingress layer per the AWS-1.11 + AWS-1.8 design."
  type        = string
}

###############################################################################
# Ingress — consumed from the `ingress` module
###############################################################################

variable "ingress_backend" {
  description = "Ingress backend selector — `\"alb\"` or `\"apigw\"`. Mirrors the `backend` variable on the `ingress` module. Dev defaults `apigw` per design §\"Dev tier\"; staging/prod use `alb`."
  type        = string

  validation {
    condition     = contains(["alb", "apigw"], var.ingress_backend)
    error_message = "ingress_backend must be \"alb\" or \"apigw\"."
  }
}

variable "ingress_listener_arn" {
  description = "When ingress_backend = \"alb\": the HTTPS listener ARN (from `ingress` module's `listener_arn`). The underlying `ecs-service` module attaches a target group + listener rule pointing path-pattern conditions at this service's tasks. Required for backend=alb; ignored otherwise."
  type        = string
  default     = ""
}

variable "ingress_alb_listener_priority" {
  description = "Priority assigned to this service's ALB listener rule. Caller is responsible for picking a unique priority across services on the same listener. Ignored when ingress_backend = \"apigw\"."
  type        = number
  default     = 100
}

variable "ingress_alb_path_patterns" {
  description = "Path-pattern conditions for the ALB listener rule. Default `[\"/*\"]` — catches everything. Tighten to `[\"/mcp/*\", \"/health\"]` when other services share the listener."
  type        = list(string)
  default     = ["/*"]
}

variable "ingress_alb_host_headers" {
  description = "Optional host-header conditions for the ALB listener rule. Empty list disables host-based routing."
  type        = list(string)
  default     = []
}

variable "ingress_vpc_link_id" {
  description = "When ingress_backend = \"apigw\": the API GW VPC Link ID (from `ingress` module's `vpc_link_id`). Required for backend=apigw; ignored otherwise."
  type        = string
  default     = ""
}

variable "ingress_apigw_api_id" {
  description = "When ingress_backend = \"apigw\": the API GW HTTP API ID (from `ingress` module's `api_id`). Required for backend=apigw; ignored otherwise."
  type        = string
  default     = ""
}

variable "ingress_apigw_integration_uri" {
  description = "Backend URI for the HTTP_PROXY API GW integration (when backend=apigw). Typically a private NLB URL or Service Connect DNS for the Strata service. Required for backend=apigw; ignored otherwise. NOTE: API GW VPC-Link integrations require an NLB or Cloud Map endpoint; the v1 wiring is documented in README §\"API GW backend gap.\""
  type        = string
  default     = ""
}

variable "ingress_endpoint_dns" {
  description = "Public DNS hostname of the ingress (from `ingress` module's `endpoint_dns`). Used to construct the `health_check_url` output — operators paste it into a browser to confirm the service is reachable."
  type        = string
}

###############################################################################
# Container shape
###############################################################################

variable "container_image" {
  description = "OCI image URI for the Strata MCP server. Defaults to the published community image — `ghcr.io/kytheros/strata-mcp:latest`. Pin to a tagged version (e.g. `:2.1.0`) for production. The community image already supports `STORAGE_BACKEND=pg` per `strata/CLAUDE.md` — no AWS-specific build is required."
  type        = string
  default     = "ghcr.io/kytheros/strata-mcp:latest"
}

variable "container_port" {
  description = "Port the Strata HTTP transport listens on inside the container. Strata's default is 3000."
  type        = number
  default     = 3000
}

variable "cpu" {
  description = "Fargate task-level CPU units. Default 512 (0.5 vCPU) — Strata is a Node 22 process; 256 is enough for cold starts but tight for a chatty agent's burst load. Bump to 1024 in prod."
  type        = number
  default     = 512

  validation {
    condition     = contains([256, 512, 1024, 2048, 4096], var.cpu)
    error_message = "cpu must be one of 256, 512, 1024, 2048, 4096."
  }
}

variable "memory" {
  description = "Fargate task-level memory (MiB). Default 1024 — paired with cpu=512 per the Fargate matrix."
  type        = number
  default     = 1024
}

variable "desired_count" {
  description = "Desired Strata task count. Default 1 in dev for cost; bump to ≥2 in staging/prod for AZ redundancy. Autoscaling overrides this within [autoscaling_min, autoscaling_max]."
  type        = number
  default     = 1
}

variable "autoscaling_min" {
  description = "Minimum task count under autoscaling. Default 1 in dev; bump to 2 for prod AZ redundancy."
  type        = number
  default     = 1
}

variable "autoscaling_max" {
  description = "Maximum task count under autoscaling. Default 3 — covers Strata's expected traffic shape with headroom; raise after measuring."
  type        = number
  default     = 3
}

variable "log_level" {
  description = "Strata log level (`debug`|`info`|`warn`|`error`). Default `info`. `debug` is fine in dev; never `debug` in prod (high CloudWatch Logs cost + leaks request bodies)."
  type        = string
  default     = "info"

  validation {
    condition     = contains(["debug", "info", "warn", "error"], var.log_level)
    error_message = "log_level must be one of: debug, info, warn, error."
  }
}

variable "max_dbs" {
  description = "Multi-tenant LRU pool size — max concurrent open per-tenant SQLite databases. Strata's `--max-dbs` flag. Only meaningful when STORAGE_BACKEND has a SQLite per-tenant component; for pure-Postgres mode this is ignored by Strata at runtime but is plumbed for forward-compat with the v2 Litestream-on-AWS path."
  type        = number
  default     = 200
}

###############################################################################
# Optional: per-tenant SQLite user-data bucket
###############################################################################

variable "create_user_data_bucket" {
  description = "When true, provision an S3 bucket via the `s3-bucket` module with `purpose = \"user-data\"`. Reserved for the v2 multi-tenant SQLite + Litestream-on-AWS path. Default false — pure-Postgres mode in v1 has no S3 dependency."
  type        = bool
  default     = false
}

###############################################################################
# Tags
###############################################################################

variable "extra_tags" {
  description = "Additional tags merged into the default tag set. Defaults: Project=strata, Component=strata-service, Environment=<env_name>, Service=strata-<env_name>, ManagedBy=terraform."
  type        = map(string)
  default     = {}
}
