###############################################################################
# Example: realistic Strata-service shape demonstrating the wiring Phase 2 will
# use. This is a `terraform validate` target only — the Aurora/Redis/Secrets
# ARNs below are stubs. Do not `terraform plan` (the data lookups would fail);
# do not `terraform apply` (would error against stub ARNs).
#
# What this demonstrates:
#   - 1 container `strata-mcp:latest` (placeholder image), 512 CPU / 1024 MiB
#   - API GW VPC-link integration (the dev path per spec §"Dev tier: API GW")
#   - Task-role inline policies stitched from aurora.consumer_iam_policy_json,
#     redis.auth_secret_consumer_iam_policy_json, and secrets.consumer_iam_policy_json
#   - Egress explicitly listed to the Aurora SG, Redis SG (in addition to the
#     module's default VPC-CIDR egress)
#   - Realistic environment shape (STORAGE_BACKEND=pg, log level, etc.)
#   - Health check on /health (matches Strata's HTTP transport)
#
# Provider account is pinned the same as basic/, but the example is for
# read-only validation: no real cluster/secret ARNs are dereferenced.
###############################################################################

terraform {
  required_version = "~> 1.7"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region              = "us-east-1"
  allowed_account_ids = ["624990353897"]

  # Skip credential and region checks so `terraform validate` works without
  # AWS creds — the example exists to prove the module's wiring shape, not to
  # round-trip a real plan against live infrastructure.
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_region_validation      = true
}

###############################################################################
# Stub IAM policy documents standing in for the real
# `module.aurora.consumer_iam_policy_json`,
# `module.redis.auth_secret_consumer_iam_policy_json`, and
# `module.secrets.consumer_iam_policy_json` outputs.
#
# In the real envs/dev/main.tf, these come from upstream module outputs and
# require no inline definitions here. For `terraform validate` we need shape-
# valid JSON strings, so we synthesize them.
###############################################################################

data "aws_iam_policy_document" "stub_aurora" {
  statement {
    sid     = "AuroraSecretRead"
    effect  = "Allow"
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      "arn:aws:secretsmanager:us-east-1:624990353897:secret:rds!cluster-STUBSTUBSTUBSTUB-XXXXXX",
    ]
  }
  statement {
    sid       = "AuroraKmsDecrypt"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = ["arn:aws:kms:us-east-1:624990353897:key/STUB-aurora-cmk"]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.us-east-1.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "stub_redis" {
  statement {
    sid     = "RedisAuthSecretRead"
    effect  = "Allow"
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      "arn:aws:secretsmanager:us-east-1:624990353897:secret:strata-dev-redis-auth-XXXXXX",
    ]
  }
}

data "aws_iam_policy_document" "stub_app_secrets" {
  statement {
    sid     = "StrataAppSecretsRead"
    effect  = "Allow"
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      "arn:aws:secretsmanager:us-east-1:624990353897:secret:strata-dev/jwt-signing-key-XXXXXX",
      "arn:aws:secretsmanager:us-east-1:624990353897:secret:strata-dev/oauth-client-secret-XXXXXX",
    ]
  }
}

###############################################################################
# Module under demonstration
###############################################################################

module "strata_service" {
  source = "../.."

  env_name     = "dev"
  service_name = "strata"

  # Stubs — in envs/dev these come from module outputs.
  cluster_arn        = "arn:aws:ecs:us-east-1:624990353897:cluster/strata-dev"
  execution_role_arn = "arn:aws:iam::624990353897:role/strata-dev-task-exec"
  log_group_name     = "/ecs/strata-dev"

  vpc_id   = "vpc-0da4fadaa6e653c5b"
  vpc_cidr = "10.40.0.0/16"
  subnet_ids = [
    "subnet-0d73b510d4f133e39",
    "subnet-026485c08d8165cb1",
    "subnet-0f4d29d6534a7b9d0",
  ]

  # Strata MCP server: 0.5 vCPU / 1 GiB. Sized for a small dev workload; prod
  # bumps to 1024/2048 once measured.
  cpu    = 512
  memory = 1024

  containers = [
    {
      name      = "strata-mcp"
      image     = "624990353897.dkr.ecr.us-east-1.amazonaws.com/strata-mcp:latest"
      essential = true
      port_mappings = [
        {
          container_port = 3000
        }
      ]

      environment = [
        # Postgres-mode storage, per spec §"Database: Aurora PostgreSQL Serverless v2"
        { name = "STORAGE_BACKEND", value = "pg" },
        { name = "NODE_ENV", value = "production" },
        { name = "STRATA_LOG_LEVEL", value = "info" },
        { name = "STRATA_REQUIRE_AUTH_PROXY", value = "1" },
        # Endpoints — the actual host comes from the Aurora/Redis module outputs
        # in envs/dev/main.tf. Here they are placeholder shapes so the env list
        # is the same as production.
        { name = "DATABASE_HOST", value = "strata-dev-proxy.proxy-stub.us-east-1.rds.amazonaws.com" },
        { name = "DATABASE_PORT", value = "5432" },
        { name = "DATABASE_NAME", value = "strata" },
        { name = "REDIS_HOST", value = "strata-dev-cache-stub.serverless.use1.cache.amazonaws.com" },
        { name = "REDIS_PORT", value = "6379" },
      ]

      # Secrets are pulled at task-launch time by the ECS agent (using the
      # execution role), then injected as env vars into the container. The task
      # role does NOT need explicit policies for these — the agent handles it.
      secrets = [
        {
          name       = "DATABASE_CREDENTIALS"
          value_from = "arn:aws:secretsmanager:us-east-1:624990353897:secret:rds!cluster-STUBSTUBSTUBSTUB-XXXXXX"
        },
        {
          name       = "REDIS_AUTH_TOKEN"
          value_from = "arn:aws:secretsmanager:us-east-1:624990353897:secret:strata-dev-redis-auth-XXXXXX:authToken::"
        },
        {
          name       = "STRATA_TOKEN_SECRET"
          value_from = "arn:aws:secretsmanager:us-east-1:624990353897:secret:strata-dev/jwt-signing-key-XXXXXX"
        },
        {
          name       = "STRATA_AUTH_PROXY_TOKEN"
          value_from = "arn:aws:secretsmanager:us-east-1:624990353897:secret:strata-dev/oauth-client-secret-XXXXXX"
        },
      ]

      health_check = {
        command      = ["CMD-SHELL", "wget -q -O- http://localhost:3000/health || exit 1"]
        interval     = 30
        timeout      = 5
        retries      = 3
        start_period = 15
      }
    },
  ]

  container_port_for_ingress = 3000

  # API GW VPC-link integration (dev path). Stubs throughout — in envs/dev
  # these come from module.ingress.{api_id, vpc_link_id}.
  attach_to_apigw_vpc_link_id = "vpcl-0123456789abcdef0"
  apigw_api_id                = "abcdefghij"
  # Until Service Connect lands, the integration URI points at a private NLB
  # the consumer would also wire up. For dev we'd typically front directly via
  # API GW → ECS via a private integration; the stub URI here is a Service
  # Connect endpoint shape:
  apigw_integration_uri = "http://strata.strata-dev.local:3000"

  # Task role — the integration point for upstream module policies.
  # Static-labels-list pattern: pass the names list separately so for_each
  # has plan-time-known keys (Phase 5 validation finding).
  task_role_inline_policy_names = [
    "aurora-secret-and-cmk",
    "redis-auth-secret",
    "strata-app-secrets",
  ]
  task_role_inline_policies = {
    aurora-secret-and-cmk = data.aws_iam_policy_document.stub_aurora.json
    redis-auth-secret     = data.aws_iam_policy_document.stub_redis.json
    strata-app-secrets    = data.aws_iam_policy_document.stub_app_secrets.json
  }

  # No managed policies — Strata's task role is intentionally narrow. The
  # example-agent service is the one that takes ReadOnlyAccess; this service
  # only ever needs DB + cache + secrets.

  # Explicit egress to upstream peers (in addition to the module's default
  # VPC-CIDR egress). Stub SG IDs — in envs/dev these are
  # module.aurora.security_group_id and module.redis.security_group_id.
  # Static-labels-list pattern: pass the labels list separately.
  allowed_egress_security_group_labels = ["aurora", "redis"]
  allowed_egress_security_group_ids = {
    aurora = "sg-aaaaaaaaaaaaaaaaa"
    redis  = "sg-bbbbbbbbbbbbbbbbb"
  }

  # Capacity: keep the 80/20 default for dev (cost-optimized). Staging/prod
  # would override to bias more toward on-demand for stability.

  # Dev autoscaling bounds — bump ceiling later as load characterized.
  autoscaling_min      = 1
  autoscaling_max      = 4
  cpu_target_tracking  = 60
  request_count_target = 1000

  desired_count = 1

  extra_tags = {
    Owner   = "platform"
    Example = "strata-service"
  }
}

###############################################################################
# Outputs (proves the module exposes everything envs/dev/main.tf needs)
###############################################################################

output "service_name" {
  value = module.strata_service.service_name
}

output "service_arn" {
  value = module.strata_service.service_arn
}

output "task_definition_arn" {
  value = module.strata_service.task_definition_arn
}

output "task_role_arn" {
  value = module.strata_service.task_role_arn
}

output "security_group_id" {
  description = "Pass into module.aurora.allowed_security_group_ids and module.redis.allowed_security_group_ids."
  value       = module.strata_service.security_group_id
}

output "apigw_integration_id" {
  description = "Pass to aws_apigatewayv2_route.target as 'integrations/<id>'."
  value       = module.strata_service.apigw_integration_id
}
