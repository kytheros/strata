###############################################################################
# Strata-on-AWS dev orchestrator (AWS-1.5.1).
#
# Canonical "task up brings the whole stack up" entry point. Every Phase 1
# module + Phase 2 + Phase 3 service is instantiated here, with module
# outputs flowing directly between them via Terraform's resource graph.
# State lives in the bootstrap-provisioned S3 backend — see backend.tf.
#
# Per-module examples/basic/ remain as standalone validation harnesses
# (good for unit-testing module changes); this orchestrator is the
# integration path that proves Phase 1 + 2 + 3 compose correctly without
# sentinel ARNs.
#
# What's deliberately excluded from the orchestrator:
#   - cloudfront-dist     — requires a real ACM cert in us-east-1; remains
#                           a standalone module the operator applies after
#                           provisioning a cert (see modules/cloudfront-dist).
#   - s3-bucket           — no downstream consumer in v1 (Strata runs in
#                           pure-Postgres mode; example-agent uses Service
#                           Connect for inter-service traffic). Re-enable
#                           when the v2 SQLite/Litestream path lands.
#   - ecs-service example — modules/ecs-service is consumed transitively
#                           by services/strata + services/example-agent;
#                           the standalone basic example is a unit-test
#                           harness, not an orchestrator dependency.
###############################################################################

data "aws_caller_identity" "current" {}

locals {
  env_name   = "dev"
  account_id = data.aws_caller_identity.current.account_id

  default_tags = {
    Project     = "strata"
    Environment = local.env_name
    Owner       = "platform"
    CostCenter  = "engineering"
    ManagedBy   = "terraform"
  }
}

###############################################################################
# Phase 1.1 — Network. VPC + 3-AZ subnets + NAT + 11 endpoints + flow logs.
# Foundation for every downstream module that needs subnet IDs or VPC CIDR.
###############################################################################

module "network" {
  source = "../../modules/network"

  env_name   = local.env_name
  aws_region = var.aws_region
  vpc_cidr   = var.vpc_cidr

  extra_tags = local.default_tags
}

###############################################################################
# Phase 1.2 — ECS cluster. Fargate + Spot + KMS-encrypted log group.
# Both services land here; consumes nothing from network.
###############################################################################

module "ecs_cluster" {
  source = "../../modules/ecs-cluster"

  env_name   = local.env_name
  aws_region = var.aws_region

  extra_tags = local.default_tags
}

###############################################################################
# Phase 1.4 — Aurora Postgres Serverless v2 + RDS Proxy. Strata's storage.
###############################################################################

module "aurora_postgres" {
  source = "../../modules/aurora-postgres"

  env_name   = local.env_name
  aws_region = var.aws_region

  vpc_id     = module.network.vpc_id
  vpc_cidr   = module.network.vpc_cidr
  subnet_ids = module.network.isolated_subnet_ids

  # Service-SG-scoped ingress is wired post-apply: each service's task SG
  # adds an egress rule to the Aurora SG, and the Aurora SG accepts ingress
  # from its own VPC CIDR (the module default when allowed_security_group_ids
  # is empty). Tightening to specific service SGs requires a second apply
  # because the service modules don't exist until ecs_cluster + ingress are up.
  # In dev that's an acceptable simplification.

  database_name   = "strata"
  master_username = "strata_admin"

  extra_tags = local.default_tags
}

###############################################################################
# Phase 1.5 — ElastiCache Redis Serverless. Used by Strata + example-agent.
###############################################################################

module "elasticache_redis" {
  source = "../../modules/elasticache-redis"

  env_name   = local.env_name
  aws_region = var.aws_region

  vpc_id     = module.network.vpc_id
  vpc_cidr   = module.network.vpc_cidr
  subnet_ids = module.network.isolated_subnet_ids

  # Same ingress story as Aurora — VPC-CIDR fallback in dev.

  extra_tags = local.default_tags
}

###############################################################################
# Phase 1.9 — Anthropic API key secret. Created empty; operator seeds the
# value post-apply via `aws secretsmanager put-secret-value`. Wired into
# the example-agent module so its task definition resolves it at task launch.
###############################################################################

module "secrets_anthropic_key" {
  source = "../../modules/secrets"

  env_name    = local.env_name
  aws_region  = var.aws_region
  secret_name = "example-agent/anthropic-api-key-orchestrator"
  description = "Anthropic API key for the example-agent's tool-use loop. Created empty; populate post-apply via `aws secretsmanager put-secret-value --secret-id <arn> --secret-string sk-ant-...`. Distinct from the example-agent module's internally-managed Anthropic secret to avoid collision when operators flip between orchestrator and per-module applies."

  create_initial_version = false

  extra_tags = local.default_tags
}

###############################################################################
# Phase 3.1 — example-agent service composition.
#
# This is instantiated BEFORE the cognito-user-pool module because Cognito's
# Lambda triggers (PreSignUp + PostConfirmation) live inside the example-agent
# composition, and Cognito needs their ARNs at create time.
#
# Cognito ↔ example-agent Lambda circular dependency resolution:
#   The example-agent's PostConfirmation Lambda IAM policy references
#   `cognito-idp:userpool/*` (account+region wildcard) instead of the
#   specific user pool ARN — see services/example-agent/infrastructure/main.tf
#   §"data.aws_iam_policy_document.post_confirmation_inline". This breaks the
#   inner cycle: the Lambda's IAM doesn't depend on the Cognito user pool ARN,
#   so Cognito can consume the Lambda ARN at create time. The Cognito user pool
#   itself is created INSIDE the example-agent composition (it owns the pool
#   because the pool is example-agent-specific — the Strata service does not
#   need its own pool, it consumes the same pool's outputs as informational
#   env vars).
#
# The implication: this orchestrator does NOT instantiate the cognito-user-pool
# module directly. The example-agent composition does, and surfaces the pool's
# outputs to the strata service.
###############################################################################

module "example_agent" {
  source = "../../services/example-agent/infrastructure"

  env_name   = local.env_name
  aws_region = var.aws_region

  # ---- Cognito federation ------------------------------------------------
  google_client_id         = var.google_client_id
  google_client_secret_arn = var.google_client_secret_arn

  # ---- Allowlist seed ----------------------------------------------------
  initial_allowlist = var.allowlist_emails

  # ---- App URL — drives Cognito callback / logout URLs -------------------
  # On first apply, var.example_agent_app_url is the placeholder from
  # tfvars (no ingress yet). After the first apply lands the ingress, the
  # operator updates the tfvars to module.ingress.endpoint_dns and re-applies
  # — Cognito picks up the new URLs. See README §"Two-pass apply pattern".
  app_url       = var.example_agent_app_url
  callback_urls = ["${var.example_agent_app_url}/api/auth/callback"]
  logout_urls   = [var.example_agent_app_url]

  # ---- Container image ---------------------------------------------------
  container_image = var.example_agent_container_image

  # ---- Cluster + network wiring ------------------------------------------
  cluster_arn        = module.ecs_cluster.cluster_arn
  execution_role_arn = aws_iam_role.task_exec.arn
  log_group_name     = module.ecs_cluster.log_group_name

  vpc_id     = module.network.vpc_id
  vpc_cidr   = module.network.vpc_cidr
  subnet_ids = module.network.private_subnet_ids

  # ---- Ingress wiring (apigw backend, dev tier) --------------------------
  ingress_backend             = "apigw"
  attach_to_apigw_vpc_link_id = module.ingress.vpc_link_id
  apigw_api_id                = module.ingress.api_id
  # Service Connect URL — namespace is named after the cluster.
  apigw_integration_uri = "http://example-agent.strata-${local.env_name}.local:3000"

  # ---- Strata-on-AWS internal endpoint -----------------------------------
  # CYCLE-BREAKING NOTE: strata_auth_proxy_token_secret_arn is deliberately
  # NOT wired here in v1. Wiring it would create a cycle:
  #   example_agent → strata_service.auth_proxy_secret_arn
  #   strata_service → example_agent.user_pool_id (cognito_user_pool_id)
  # The X-Strata-Verified header injection moves to v2 when the ingress owns
  # JWT verification centrally; v1 example-agent calls Strata over Service
  # Connect with the example-agent's task SG allow-listed on Strata's SG.
  cluster_service_connect_namespace = "strata-${local.env_name}"
  strata_internal_port              = 3000

  # ---- Redis SDK cache (AWS-3.3) -----------------------------------------
  redis_endpoint                             = module.elasticache_redis.endpoint
  redis_port                                 = module.elasticache_redis.port
  redis_auth_secret_arn                      = module.elasticache_redis.auth_secret_arn
  redis_auth_secret_consumer_iam_policy_json = module.elasticache_redis.auth_secret_consumer_iam_policy_json

  # ---- Capacity ---------------------------------------------------------
  cpu            = 512
  memory         = 1024
  desired_count  = 1
  container_port = 3000

  extra_tags = local.default_tags
}

###############################################################################
# Phase 1.11 — Ingress (API Gateway HTTP API + VPC Link).
#
# CYCLE-BREAKING NOTE: the ingress module is provisioned WITHOUT a Cognito
# JWT authorizer in v1 because:
#
#   - ingress would consume example_agent.user_pool_id to wire the authorizer
#   - example_agent already consumes ingress.vpc_link_id + ingress.api_id
#     for its HTTP_PROXY integration
#
# Wiring both edges creates a Terraform cycle (ingress ↔ example_agent).
# Resolution: ingress provisions the API + VPC Link only; each service's
# composition wires its own JWT verification:
#
#   - example-agent: Next.js layer verifies the JWT against Cognito's JWKS
#     URI in middleware (no API GW authorizer needed).
#   - strata-service: STRATA_REQUIRE_AUTH_PROXY=1 gates requests on the
#     X-Strata-Verified header that the upstream proxy sets. Cognito
#     verification happens at the Next.js layer in front of /mcp calls.
#
# Centralizing the JWT authorizer at the ingress is a v2 hardening — see
# the design spec §"Auth flow" for the v2 layout.
###############################################################################

module "ingress" {
  source = "../../modules/ingress"

  env_name   = local.env_name
  aws_region = var.aws_region

  backend = "apigw"

  vpc_id             = module.network.vpc_id
  vpc_cidr           = module.network.vpc_cidr
  public_subnet_ids  = module.network.public_subnet_ids
  private_subnet_ids = module.network.private_subnet_ids

  # Cognito left empty to break the ingress ↔ example_agent cycle. See note
  # above. Route-level authorizer attachment is owned by each service.

  enable_logging     = true
  log_retention_days = 30

  extra_tags = local.default_tags
}

###############################################################################
# Phase 2.1 — Strata-on-AWS service composition.
#
# Consumes Aurora + Redis + Cognito (via example-agent) + ingress + cluster.
# Ingress wiring uses the apigw backend — Service Connect is the path.
###############################################################################

module "strata_service" {
  source = "../../services/strata"

  env_name   = local.env_name
  aws_region = var.aws_region

  vpc_id             = module.network.vpc_id
  vpc_cidr           = module.network.vpc_cidr
  private_subnet_ids = module.network.private_subnet_ids

  cluster_arn                = module.ecs_cluster.cluster_arn
  cluster_execution_role_arn = aws_iam_role.task_exec.arn
  cluster_log_group_name     = module.ecs_cluster.log_group_name

  # ---- Aurora ------------------------------------------------------------
  aurora_proxy_endpoint           = module.aurora_postgres.proxy_endpoint
  aurora_database_name            = module.aurora_postgres.database_name
  aurora_master_username          = module.aurora_postgres.master_username
  aurora_master_secret_arn        = module.aurora_postgres.master_user_secret_arn
  aurora_consumer_iam_policy_json = module.aurora_postgres.consumer_iam_policy_json
  aurora_security_group_id        = module.aurora_postgres.security_group_id

  # ---- Redis -------------------------------------------------------------
  redis_endpoint                 = module.elasticache_redis.endpoint
  redis_port                     = module.elasticache_redis.port
  redis_auth_secret_arn          = module.elasticache_redis.auth_secret_arn
  redis_consumer_iam_policy_json = module.elasticache_redis.auth_secret_consumer_iam_policy_json
  redis_security_group_id        = module.elasticache_redis.security_group_id

  # ---- Cognito (sourced via example-agent's pool) ------------------------
  cognito_user_pool_id        = module.example_agent.user_pool_id
  cognito_user_pool_client_id = module.example_agent.user_pool_client_id
  cognito_jwks_uri            = module.example_agent.cognito_jwks_uri

  # ---- Ingress (apigw backend) -------------------------------------------
  ingress_backend               = "apigw"
  ingress_vpc_link_id           = module.ingress.vpc_link_id
  ingress_apigw_api_id          = module.ingress.api_id
  ingress_apigw_integration_uri = "http://strata.strata-${local.env_name}.local:3000"
  ingress_endpoint_dns          = module.ingress.endpoint_dns

  # ---- Container shape ---------------------------------------------------
  container_image = var.strata_container_image
  cpu             = 512
  memory          = 1024
  desired_count   = 1
  log_level       = "info"

  extra_tags = local.default_tags
}

###############################################################################
# Shared task-execution role.
#
# Both services share a single execution role — it's the role ECS assumes
# at task-launch time to pull the image, write logs, and resolve secrets.
# Per-service runtime IAM lives on the task ROLE (separate from this), which
# each service's composition owns.
#
# Real envs/staging/main.tf and envs/prod/main.tf will keep this same shape;
# secret-resolution permissions are added per-secret-ARN below as services
# come online (initially via wildcard scoped to the env's secret prefix).
###############################################################################

data "aws_iam_policy_document" "task_exec_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "task_exec" {
  name               = "strata-${local.env_name}-task-exec"
  assume_role_policy = data.aws_iam_policy_document.task_exec_assume.json
  description        = "Shared ECS task-execution role for the Strata + example-agent services in ${local.env_name}. Pulls images, writes logs, and resolves Secrets Manager secrets at task launch."

  tags = local.default_tags
}

resource "aws_iam_role_policy_attachment" "task_exec_managed" {
  role       = aws_iam_role.task_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Allow the execution role to read every secret under strata/<env>/* and
# example-agent/<env>/* — this is the AWSCURRENT-version dynamic-reference
# resolution the ECS agent does at task launch. The wildcard is scoped to
# the env's secret prefix and the account/region; it does NOT permit cross-
# env reads.
data "aws_iam_policy_document" "task_exec_secrets_read" {
  statement {
    sid     = "ReadEnvScopedSecrets"
    effect  = "Allow"
    actions = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    resources = [
      "arn:aws:secretsmanager:${var.aws_region}:${local.account_id}:secret:strata/${local.env_name}/*",
      "arn:aws:secretsmanager:${var.aws_region}:${local.account_id}:secret:example-agent/${local.env_name}/*",
      "arn:aws:secretsmanager:${var.aws_region}:${local.account_id}:secret:rds!cluster-*",
    ]
  }

  # Each module's per-resource CMK lets the ECS agent decrypt the secret.
  # The `kms:ViaService` condition restricts use to the Secrets Manager
  # backplane — the role can't use these keys for arbitrary decrypt calls.
  statement {
    sid       = "DecryptEnvScopedSecretCmks"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${var.aws_region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "task_exec_secrets_read" {
  name   = "env-scoped-secrets-read"
  role   = aws_iam_role.task_exec.id
  policy = data.aws_iam_policy_document.task_exec_secrets_read.json
}

###############################################################################
# Phase 1.10 — Observability. Provisioned LAST because most of its variables
# require live ARNs from upstream modules. Empty-default args mean alarms
# only get created when their underlying resource is present — defensive
# against partial deploys.
###############################################################################

module "observability" {
  source = "../../modules/observability"

  env_name   = local.env_name
  aws_region = var.aws_region

  alarm_subscribers = var.alarm_subscribers

  # Cluster log group already provisioned by ecs-cluster — pass it through
  # so EMF metric filters can attach. (Empty service_log_groups + empty
  # metric_filters in v1; consumer adds them as needs arise.)
  cluster_log_group_name = module.ecs_cluster.log_group_name

  # ---- ALB (null when backend=apigw — alb_arn left empty disables alarms) -
  # ALB-specific alarms (5xx rate, p99 latency) only fire when an ALB exists.
  # Dev runs apigw; staging/prod tfvars override `backend = "alb"` and
  # populate `alb_arn` + `alb_arn_suffix` from module.ingress outputs.

  # ---- ECS task shortfall alarms -----------------------------------------
  ecs_cluster_arn  = module.ecs_cluster.cluster_arn
  ecs_cluster_name = module.ecs_cluster.cluster_name
  ecs_service_names = [
    module.strata_service.service_name,
    module.example_agent.service_name,
  ]

  # ---- Aurora ACU + CPU alarms -------------------------------------------
  aurora_cluster_arn        = module.aurora_postgres.cluster_arn
  aurora_cluster_identifier = module.aurora_postgres.cluster_id

  # ---- Redis CPU + storage alarms ----------------------------------------
  redis_cache_arn  = module.elasticache_redis.cache_arn
  redis_cache_name = module.elasticache_redis.cache_id

  # ---- NAT anomaly alarms (catches design Risk #3) -----------------------
  nat_gateway_ids = module.network.nat_gateway_ids

  # ---- Cognito auth-failure-rate alarm -----------------------------------
  cognito_user_pool_id = module.example_agent.user_pool_id

  extra_tags = local.default_tags
}
