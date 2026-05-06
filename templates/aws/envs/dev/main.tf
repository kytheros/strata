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
# Service Connect namespace (added in AWS-1.6.1 follow-up; pre-Phase-1.4).
#
# Owned by the orchestrator (not modules/ecs-cluster) because:
#   - ecs-cluster is intentionally tight: cluster + log group + KMS + exec
#     role only. Adding service discovery there conflates "compute" with
#     "discovery" and forces every standalone ecs-cluster consumer to
#     decide whether they want a namespace.
#   - The namespace name is a deterministic string already referenced by
#     three consumer module calls (strata service, example-agent service,
#     and ingress-authorizer's integration URI). Co-locating the resource
#     with the references that need it keeps the contract visible.
#
# Why aws_service_discovery_http_namespace and NOT private_dns_namespace:
# ECS Service Connect uses Envoy sidecars to translate `<dns_name>.<ns>`
# aliases at the client task — there is no actual DNS resolution. The HTTP
# namespace skips the Route 53 zone (saves cost + plan time) and gives the
# example-agent everything it needs to reach Strata over Service Connect.
#
# The aws_service_discovery_http_namespace resource does NOT take a `vpc`
# argument — Service Connect aliases are scoped to the cluster, not the VPC.
# (private_dns_namespace would take vpc, but is overkill here.)
#
# KNOWN GAP: external-client API GW path.
# The API GW VPC link cannot resolve Service Connect aliases (they only
# work inside Envoy-sidecar-instrumented tasks). The /mcp routes wired in
# services/ingress-authorizer reach Strata fine for ECS-internal callers,
# but external MCP clients hitting the API GW will 503 until the
# integration_uri is changed to either an NLB listener ARN or a Cloud Map
# service ARN. Tracked as AWS-1.6.6. The example-agent demo flow is
# unaffected: it goes through Service Connect, not the API GW.
###############################################################################

resource "aws_service_discovery_http_namespace" "this" {
  name        = "strata-${local.env_name}"
  description = "ECS Service Connect namespace for Strata + example-agent in ${local.env_name}. Aliases under this namespace (e.g. strata.strata-${local.env_name}) are translated by the Envoy sidecar in each consumer task; not resolvable outside Service Connect."

  tags = local.default_tags
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
  # Service Connect alias — used by the API GW HTTP_PROXY integration's URI.
  # See KNOWN GAP note on the namespace resource above: the API GW VPC link
  # cannot resolve Service Connect aliases. The URI here is structural; the
  # working internal path between example-agent and Strata is the
  # client_alias-resolved DNS handled by each task's Envoy sidecar.
  apigw_integration_uri = "http://example-agent.strata-${local.env_name}:3000"

  # ---- Ingress security-group allow-list (HIGH from AWS-1.6.1 review) ---
  ingress_security_group_ids = [module.ingress.security_group_id]

  # ---- Service Connect (MEDIUM-1 from AWS-1.6.1 review) ------------------
  # Joins the orchestrator-owned namespace so the example-agent's Envoy
  # sidecar can resolve `strata.strata-{env}` to the Strata service tasks.
  service_connect_namespace_arn = aws_service_discovery_http_namespace.this.arn

  # ---- Strata-on-AWS internal endpoint -----------------------------------
  # The example-agent reaches Strata over Service Connect (not via the API
  # GW). It does NOT need to set X-Strata-Verified because the example-agent
  # itself is the trusted internal caller — its task SG is on Strata's SG
  # ingress allow-list. External MCP clients hit /mcp through the API GW
  # path that AWS-1.6.1's services/ingress-authorizer wires (centralized
  # JWT authorizer + header injection).
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
# This module provisions the API + VPC Link only. The Cognito JWT authorizer
# and the Strata-bound /mcp routes are owned by services/ingress-authorizer
# (AWS-1.6.1) below — see that composition for the cycle-break rationale
# and the X-Strata-Verified injection contract.
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

  # Cognito left empty intentionally. Authorizer attachment is the job of
  # services/ingress-authorizer, which owns the /mcp routes that need it.
  # Setting cognito_user_pool_id here would create the authorizer twice
  # (once on the ingress module, once on ingress-authorizer) for no gain.

  enable_logging     = true
  log_retention_days = 30

  extra_tags = local.default_tags
}

###############################################################################
# Phase 1.6 — Ingress authorizer + auth-proxy secret (AWS-1.6.1).
#
# Closes both Phase 1.5 deferrals:
#   1. Cognito JWT authorizer attached to the API GW /mcp routes.
#   2. X-Strata-Verified header injection on the Strata-bound integration.
#
# Owns the shared STRATA_AUTH_PROXY_TOKEN secret (per-secret CMK). Its
# outputs flow into module.strata_service below — that's the only edge.
# Consumes raw IDs/strings from cognito (via module.example_agent), the
# ingress module, and a deterministic Service Connect URL for Strata.
#
# See services/ingress-authorizer/README.md §"How a request flows" for
# the end-to-end auth path this composition wires.
###############################################################################

module "ingress_authorizer" {
  source = "../../services/ingress-authorizer"

  env_name   = local.env_name
  aws_region = var.aws_region

  # ---- Cognito (sourced via example-agent's pool) ------------------------
  cognito_user_pool_id        = module.example_agent.user_pool_id
  cognito_user_pool_client_id = module.example_agent.user_pool_client_id

  # ---- Ingress (raw IDs from the ingress module) -------------------------
  apigw_api_id      = module.ingress.api_id
  apigw_vpc_link_id = module.ingress.vpc_link_id

  # ---- Internal NLB (AWS-1.6.6) ------------------------------------------
  # Closes the runtime gap: API GW VPC links cannot resolve Service Connect
  # aliases. The composition stands up a private NLB and the JWT-authorized
  # integration routes through it via the listener ARN. NLB lives in the
  # same private subnets as the VPC link. Strata's tasks register on the
  # NLB target group below (module.strata_service.attach_to_nlb_target_group_arn).
  vpc_id                = module.network.vpc_id
  vpc_cidr              = module.network.vpc_cidr
  private_subnet_ids    = module.network.private_subnet_ids
  strata_container_port = 3000

  # ---- DEPRECATED in v1.6.6 — kept for example back-compat ---------------
  # Routing now uses the NLB listener ARN above; this string is unused.
  strata_integration_uri = "http://strata.strata-${local.env_name}:3000"

  # ---- Example-agent integration target for $default ---------------------
  example_agent_integration_id = module.example_agent.apigw_integration_id

  extra_tags = local.default_tags
}

###############################################################################
# Phase 2.1 — Strata-on-AWS service composition.
#
# Consumes Aurora + Redis + Cognito (via example-agent) + ingress + cluster.
# Ingress wiring uses the apigw backend — Service Connect is the path.
#
# Auth-proxy secret comes from services/ingress-authorizer above (AWS-1.6.1).
# That composition owns the secret because it ALSO injects the same value
# into the API GW integration's request_parameters; sourcing both reads from
# one resource keeps them in lockstep.
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
  ingress_apigw_integration_uri = "http://strata.strata-${local.env_name}:3000"
  ingress_endpoint_dns          = module.ingress.endpoint_dns

  # Both the API GW VPC link SG and the NLB SG must be allowed to reach
  # Strata's task port. The VPC link SG covers the example-agent path
  # (still routed via Service Connect from inside the cluster, but the link
  # SG is the legacy entry point for any direct-to-task fallbacks); the
  # NLB SG covers the external-MCP path wired in AWS-1.6.6.
  ingress_security_group_ids = [
    module.ingress.security_group_id,
    module.ingress_authorizer.strata_nlb_security_group_id,
  ]

  # ---- Internal NLB target group (AWS-1.6.6) -----------------------------
  # Strata's tasks register here so the API GW VPC link can reach them via
  # the NLB listener ARN. Separate from Service Connect; both paths coexist.
  attach_to_nlb_target_group_arn = module.ingress_authorizer.strata_nlb_target_group_arn

  # ---- Service Connect (MEDIUM-1 from AWS-1.6.1 review) ------------------
  # Registers Strata under `strata.strata-{env}` so the example-agent's
  # Envoy sidecar can reach it as `http://strata.strata-{env}:3000`.
  service_connect_namespace_arn = aws_service_discovery_http_namespace.this.arn
  service_connect_dns_name      = "strata"

  # ---- Auth-proxy secret (sourced from services/ingress-authorizer) ------
  # When set, services/strata skips minting its own secret and reads the
  # shared one. This is the canonical orchestrator path — the same secret
  # value is injected as X-Strata-Verified on the API GW /mcp routes.
  auth_proxy_secret_arn         = module.ingress_authorizer.auth_proxy_secret_arn
  auth_proxy_secret_kms_key_arn = module.ingress_authorizer.auth_proxy_secret_kms_key_arn

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

  # ---- Phase 4 ops dashboard + JWT-error metric filter (AWS-4.1) ---------
  # API GW, NLB, and per-service ECS dimensions feed the strata-<env>-ops
  # dashboard. The JWT auth-error rate alarm consumes the API GW access log
  # group (which AWS-1.6.4 enriched with the `sub` and `authError` fields).
  enable_ops_dashboard        = true
  apigw_api_id                = module.ingress.api_id
  apigw_log_group_name        = module.ingress.log_group_name
  nlb_arn_suffix              = module.ingress_authorizer.strata_nlb_arn_suffix
  nlb_target_group_arn_suffix = module.ingress_authorizer.strata_nlb_target_group_arn_suffix
  strata_service_name         = module.strata_service.service_name
  example_agent_service_name  = module.example_agent.service_name

  extra_tags = local.default_tags
}

###############################################################################
# Phase 4 — Synthetic canary (AWS-4.1).
#
# EventBridge + Lambda cadence over CloudWatch Synthetics: cost-aligned with
# the destroy-when-not-working operating model and gives us direct control
# over the failure signal (CANARY_FAIL log lines → metric filter → existing
# SNS alarm topic). See services/canary/main.tf for the rationale.
#
# `count = var.canary_enabled` per the spec — flips the canary off when the
# stack is intentionally torn down or before the test user exists. The
# credentials secret is always provisioned so operators can stage creds
# before the first enable.
###############################################################################

module "canary" {
  source = "../../services/canary"

  env_name   = local.env_name
  aws_region = var.aws_region

  canary_enabled = var.canary_enabled

  # Cognito (sourced via example-agent's pool, same as ingress-authorizer).
  cognito_user_pool_id        = module.example_agent.user_pool_id
  cognito_user_pool_arn       = module.example_agent.user_pool_arn
  cognito_user_pool_client_id = module.example_agent.user_pool_client_id

  # Hits the public API GW endpoint with a real Cognito JWT — exercises the
  # full external-MCP path: API GW JWT authorizer → header-injecting
  # integration → internal NLB → Strata.
  mcp_endpoint_url = "https://${module.ingress.endpoint_dns}/mcp"

  alarm_topic_arn = module.observability.alarm_topic_arn

  extra_tags = local.default_tags
}
