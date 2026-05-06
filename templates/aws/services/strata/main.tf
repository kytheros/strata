###############################################################################
# Strata-on-AWS service composition (AWS-2.1).
#
# Instantiates the Phase 1 modules with the wiring needed to run the community
# Strata MCP server (ghcr.io/kytheros/strata-mcp:latest) in multi-tenant
# Postgres mode behind a Cognito-authenticating ingress.
#
# This module DOES NOT define new low-level resources (no aws_ecs_*, no
# aws_db_*) directly — it composes the existing modules' contracts. The only
# things that live here are:
#   - The synthesized DATABASE_URL secret (because no Phase 1 module owns
#     "compose this URL from these parts and inject it as a secret").
#   - The STRATA_AUTH_PROXY_TOKEN secret (the per-deployment shared sentinel
#     that the ingress sets on `X-Strata-Verified` after JWT verification —
#     see README §"Auth flow").
#   - The optional user-data S3 bucket (off by default; v2 Litestream path).
###############################################################################

locals {
  service_name = "strata-${var.env_name}"

  # DATABASE_URL value as Strata's pg adapter expects:
  # postgres://{user}:{password}@{proxy_endpoint}:5432/{db}?sslmode=require
  #
  # The password component is a Secrets Manager dynamic reference — ECS resolves
  # it at task-launch time, plaintext never lands in plan output. We use the
  # JSON pointer form for the AWS-managed Aurora master credential, which stores
  # `{"username": "...", "password": "..."}` JSON.
  database_url_value = format(
    "postgres://%s:{{resolve:secretsmanager:%s:SecretString:password}}@%s:5432/%s?sslmode=require",
    var.aurora_master_username,
    var.aurora_master_secret_arn,
    var.aurora_proxy_endpoint,
    var.aurora_database_name,
  )

  # ALB vs API GW backend gating — drives which subset of ecs-service variables
  # we populate. Only one of the two attach paths is active per apply.
  is_alb   = var.ingress_backend == "alb"
  is_apigw = var.ingress_backend == "apigw"

  default_tags = merge(
    {
      Project     = "strata"
      Component   = "strata-service"
      Environment = var.env_name
      Service     = local.service_name
      ManagedBy   = "terraform"
    },
    var.extra_tags,
  )
}

###############################################################################
# Auth-proxy shared secret — sourced or self-minted.
#
# Strata's multi-tenant HTTP transport refuses to trust the X-Strata-User
# header unless the upstream proxy also sets X-Strata-Verified to a known
# shared secret. There are two supported wiring modes:
#
#   1. EXTERNAL (orchestrator path, AWS-1.6.1+):
#      The shared secret is owned by services/ingress-authorizer/, which
#      both injects it into the API GW integration's request_parameters and
#      passes its ARN here via var.auth_proxy_secret_arn. This is the
#      canonical path for any deployment that wants external MCP clients to
#      hit /mcp directly with a Cognito JWT.
#
#   2. STANDALONE (legacy / unit-test path):
#      No external secret supplied — this module mints its own. The secret
#      is unreachable by the ingress in this mode (no X-Strata-Verified is
#      ever set), so /mcp is reachable only over Service Connect from the
#      example-agent, which itself sets the header to the same minted
#      value via internal configuration. Used by services/strata/examples/
#      and by environments where AWS-1.6.1 has not yet been applied.
#
# See strata/CLAUDE.md §"REST transport token secret" / §"Multi-tenant
# deployments MUST run behind a verified auth proxy".
###############################################################################

locals {
  use_external_auth_proxy_secret = var.auth_proxy_secret_arn != ""
}

# Pair-validate the optional auth-proxy override inputs. Surfaced via
# check{} block so plan output names the failure clearly instead of
# emitting a confusing "value cannot be null" error from the IAM document.
check "auth_proxy_inputs_paired" {
  assert {
    condition     = !local.use_external_auth_proxy_secret || var.auth_proxy_secret_kms_key_arn != ""
    error_message = "auth_proxy_secret_arn was set but auth_proxy_secret_kms_key_arn is empty. Both must be supplied together when overriding the auth-proxy secret (the kms key arn is required for the kms:Decrypt grant on the task role)."
  }
}

resource "random_password" "auth_proxy_token" {
  count = local.use_external_auth_proxy_secret ? 0 : 1

  # 64 chars matches services/ingress-authorizer/main.tf (AWS-1.6.5).
  # Both modes mint the same width sentinel so cross-mode swaps (standalone
  # -> external) do not change Strata's STRATA_AUTH_PROXY_TOKEN entropy
  # profile. ASCII-only; special characters are excluded so the value can
  # be embedded as-is in the API GW integration's request_parameters.
  length  = 64
  special = false
}

module "auth_proxy_secret" {
  source = "../../modules/secrets"
  count  = local.use_external_auth_proxy_secret ? 0 : 1

  env_name    = var.env_name
  aws_region  = var.aws_region
  secret_name = "strata-service/auth-proxy-token"
  description = "Shared sentinel set by the ${var.ingress_backend} ingress on X-Strata-Verified after Cognito JWT verification. Strata's multi-tenant HTTP transport rejects any request whose X-Strata-Verified does not match this value. STANDALONE mode — the orchestrator path replaces this with a secret owned by services/ingress-authorizer."

  create_initial_version = true
  initial_value          = random_password.auth_proxy_token[0].result

  extra_tags = local.default_tags
}

# Resolved auth-proxy secret values — either the external inputs or the
# locally-minted secret's outputs. Downstream IAM grants and the ECS task
# definition consume these instead of branching on the gating signal.
locals {
  effective_auth_proxy_secret_arn = (
    local.use_external_auth_proxy_secret
    ? var.auth_proxy_secret_arn
    : module.auth_proxy_secret[0].secret_arn
  )

  effective_auth_proxy_kms_key_arn = (
    local.use_external_auth_proxy_secret
    ? var.auth_proxy_secret_kms_key_arn
    : module.auth_proxy_secret[0].kms_key_arn
  )
}

###############################################################################
# DATABASE_URL secret.
#
# Strata's Postgres adapter reads DATABASE_URL on boot. Rather than parsing
# host/user/db/password into separate env vars in the task definition, we
# synthesize the URL into a single Secrets Manager entry and expose it as the
# DATABASE_URL secret in the ECS task definition. ECS resolves the
# secretsmanager dynamic reference at task launch — the password never crosses
# Terraform state.
#
# See README §"Why DATABASE_URL is a synthesized secret".
###############################################################################

module "database_url_secret" {
  source = "../../modules/secrets"

  env_name    = var.env_name
  aws_region  = var.aws_region
  secret_name = "strata-service/database-url"
  description = "Synthesized Postgres connection string for Strata. References the Aurora master password from ${var.aurora_master_secret_arn} via Secrets Manager dynamic reference; not a copy."

  create_initial_version = true
  initial_value          = local.database_url_value

  extra_tags = local.default_tags
}

###############################################################################
# Optional: per-tenant SQLite user-data bucket.
#
# v1 ships pure-Postgres mode — this bucket is unused. Reserved for the v2
# Litestream-on-AWS path where each tenant gets a SQLite + S3 replica pair.
###############################################################################

module "user_data_bucket" {
  source = "../../modules/s3-bucket"
  count  = var.create_user_data_bucket ? 1 : 0

  env_name   = var.env_name
  aws_region = var.aws_region
  purpose    = "user-data"

  versioning_enabled     = true
  cloudfront_oac_enabled = false

  extra_tags = local.default_tags
}

###############################################################################
# Inline IAM policy granting the task role the rights to read its own
# secrets-module-managed secrets (DATABASE_URL synthesizer + auth-proxy token).
# Aurora and Redis ship their own consumer policy JSON via module outputs;
# we attach those alongside this one on the task role.
###############################################################################

data "aws_iam_policy_document" "service_secrets_consumer" {
  statement {
    sid    = "ReadServiceSecrets"
    effect = "Allow"
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
    ]
    resources = [
      module.database_url_secret.secret_arn,
      local.effective_auth_proxy_secret_arn,
    ]
  }

  statement {
    sid    = "DecryptServiceSecretCmks"
    effect = "Allow"
    actions = [
      "kms:Decrypt",
    ]
    resources = [
      module.database_url_secret.kms_key_arn,
      local.effective_auth_proxy_kms_key_arn,
    ]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${var.aws_region}.amazonaws.com"]
    }
  }
}

###############################################################################
# ECS service composition.
#
# All ALB-vs-APIGW switching happens here via the module's attach_to_*_listener
# / attach_to_apigw_vpc_link variables. Each service module call exercises
# exactly one ingress path.
###############################################################################

module "service" {
  source = "../../modules/ecs-service"

  env_name     = var.env_name
  aws_region   = var.aws_region
  service_name = local.service_name

  cluster_arn        = var.cluster_arn
  execution_role_arn = var.cluster_execution_role_arn
  log_group_name     = var.cluster_log_group_name

  vpc_id     = var.vpc_id
  vpc_cidr   = var.vpc_cidr
  subnet_ids = var.private_subnet_ids

  cpu              = var.cpu
  memory           = var.memory
  desired_count    = var.desired_count
  autoscaling_min  = var.autoscaling_min
  autoscaling_max  = var.autoscaling_max
  runtime_platform = "LINUX/X86_64"

  containers = [
    {
      name      = "strata"
      image     = var.container_image
      essential = true
      port_mappings = [
        {
          container_port = var.container_port
          protocol       = "tcp"
          # Named port — referenced by Service Connect's port_name when
          # var.service_connect_namespace_arn is set.
          name = "strata-http"
        },
      ]
      environment = [
        # ---- Storage backend ----------------------------------------------
        { name = "STORAGE_BACKEND", value = "pg" },
        { name = "NODE_ENV", value = "production" },
        { name = "STRATA_LOG_LEVEL", value = var.log_level },

        # ---- Multi-tenant HTTP transport ----------------------------------
        # Strata's `serve --multi-tenant` accepts these as env-var equivalents
        # of the CLI flags. The image's entrypoint maps them onto the right
        # CLI invocation. See strata/CLAUDE.md §"Transport Modes".
        { name = "STRATA_TRANSPORT", value = "http" },
        { name = "STRATA_MULTI_TENANT", value = "1" },
        { name = "STRATA_PORT", value = tostring(var.container_port) },
        { name = "STRATA_MAX_DBS", value = tostring(var.max_dbs) },
        { name = "STRATA_DATA_DIR", value = "/var/strata" },

        # ---- Auth-proxy enforcement ---------------------------------------
        # Strata refuses the X-Strata-User header unless X-Strata-Verified
        # matches STRATA_AUTH_PROXY_TOKEN. The ingress is responsible for
        # injecting both headers after Cognito JWT verification.
        { name = "STRATA_REQUIRE_AUTH_PROXY", value = "1" },

        # ---- Cognito context (informational, NOT used for verification) --
        # Strata itself does not call Cognito at runtime; ingress does the JWT
        # work. These are surfaced for log/diagnostic emission only.
        { name = "STRATA_COGNITO_USER_POOL_ID", value = var.cognito_user_pool_id },
        { name = "STRATA_COGNITO_CLIENT_ID", value = var.cognito_user_pool_client_id },
        { name = "STRATA_COGNITO_JWKS_URI", value = var.cognito_jwks_uri },

        # ---- Redis ---------------------------------------------------------
        # Endpoint + port; the AUTH token lands as a secret below.
        { name = "STRATA_REDIS_HOST", value = var.redis_endpoint },
        { name = "STRATA_REDIS_PORT", value = tostring(var.redis_port) },
        { name = "STRATA_REDIS_TLS", value = "1" },
      ]
      secrets = [
        {
          name       = "DATABASE_URL"
          value_from = module.database_url_secret.secret_arn
        },
        {
          name       = "STRATA_AUTH_PROXY_TOKEN"
          value_from = local.effective_auth_proxy_secret_arn
        },
        {
          name       = "REDIS_AUTH_TOKEN"
          value_from = var.redis_auth_secret_arn
        },
      ]
      health_check = {
        command      = ["CMD-SHELL", "wget -qO- http://localhost:${var.container_port}/health || exit 1"]
        interval     = 30
        timeout      = 5
        retries      = 3
        start_period = 30
      }
    },
  ]

  container_port_for_ingress = var.container_port

  # ---- ALB attachment (active when backend=alb) ----------------------------
  attach_to_alb_listener_arn = local.is_alb ? var.ingress_listener_arn : ""
  alb_path_patterns          = var.ingress_alb_path_patterns
  alb_host_headers           = var.ingress_alb_host_headers
  alb_listener_priority      = var.ingress_alb_listener_priority
  target_group_port          = var.container_port
  health_check_path          = "/health"

  # ---- API GW attachment (active when backend=apigw) -----------------------
  attach_to_apigw_vpc_link_id = local.is_apigw ? var.ingress_vpc_link_id : ""
  apigw_integration_uri       = local.is_apigw ? var.ingress_apigw_integration_uri : ""
  apigw_api_id                = local.is_apigw ? var.ingress_apigw_api_id : ""

  # ---- Internal NLB attachment (AWS-1.6.6) --------------------------------
  # Closes the runtime gap: API GW VPC links cannot resolve Service Connect
  # aliases, so the JWT-authorized /mcp routes target an internal NLB the
  # ingress-authorizer composition creates. Strata's tasks register on its
  # target group via this pass-through.
  attach_to_nlb_target_group_arn = var.attach_to_nlb_target_group_arn

  # ---- Ingress security-group allow-list (HIGH from AWS-1.6.1 review) -----
  # Without this the task SG accepts no inbound traffic and the API GW VPC
  # link / NLB cannot reach Strata. See variables.tf §"ingress_security_group_ids".
  ingress_security_group_ids = var.ingress_security_group_ids

  # ---- Service Connect (MEDIUM-1 from AWS-1.6.1 review) -------------------
  # Registers this Strata service under `<service_connect_dns_name>.<ns>` so
  # the example-agent can reach it as `http://strata.strata-{env}:3000`.
  # Empty namespace ARN disables Service Connect (legacy / unit-test path).
  service_connect_namespace_arn = var.service_connect_namespace_arn
  service_connect_config = var.service_connect_namespace_arn != "" ? {
    services = [
      {
        port_name      = "strata-http"
        discovery_name = var.service_connect_dns_name
        client_alias = [
          {
            port     = var.container_port
            dns_name = var.service_connect_dns_name
          },
        ]
      },
    ]
  } : null

  # ---- Egress to Aurora + Redis -------------------------------------------
  allowed_egress_security_group_ids = [
    var.aurora_security_group_id,
    var.redis_security_group_id,
  ]

  # ---- IAM task role inline policies ---------------------------------------
  task_role_inline_policies = [
    {
      name        = "aurora-consumer"
      policy_json = var.aurora_consumer_iam_policy_json
    },
    {
      name        = "redis-consumer"
      policy_json = var.redis_consumer_iam_policy_json
    },
    {
      name        = "service-secrets-consumer"
      policy_json = data.aws_iam_policy_document.service_secrets_consumer.json
    },
  ]

  extra_tags = local.default_tags
}
