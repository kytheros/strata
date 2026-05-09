###############################################################################
# MODULE-VALIDATION HARNESS — not the canonical apply target.
#
# As of AWS-1.5.1, the canonical apply path is `envs/dev/main.tf`, which
# composes services/strata against the live network/cluster/aurora/redis/
# cognito/ingress modules with direct module-output wiring (no sentinels).
# This file remains for `terraform init -backend=false && terraform
# validate` checks against the services/strata composition surface in
# isolation.
#
# Phase 5 IAM review HIGH-2 fix: the Aurora master credential ARN and
# the Redis AUTH-token secret ARN are now sourced via `data` lookups
# against the deployed Phase 1 modules (by deterministic name) instead of
# being literal `XXXX` strings. Consequence:
#   - `terraform validate` still works (data sources are not resolved
#     during validate).
#   - `terraform plan / apply` from this directory now FAILS CLOSED
#     against an account where Phase 1 has not been applied; the lookups
#     surface a clear "no matching cluster / secret found" error instead
#     of silently producing IAM policies whose Resource fields are
#     literal `XXXXXXXXXXXX-XXXXXXXX` strings (the regression that broke
#     `strata-dev-dev-task` in the live dev account).
#   - When the lookups DO succeed (Phase 1 applied), the IAM policies the
#     harness produces are byte-identical to what the orchestrator would
#     emit — the harness becomes a true module-isolation test against
#     real ARNs rather than a divergent code path.
#
# Drift heal: existing IAM policies on `strata-dev-dev-task` in the live
# dev account that still carry literal-XXXX ARNs will be overwritten on
# the next orchestrator apply (terraform owns the inline policies by
# name; same-name policies get replaced atomically).
###############################################################################

###############################################################################
# Example: Strata-on-AWS service against the dev account (<ACCOUNT_ID>).
#
# Validation flow:
#   terraform init -backend=false
#   terraform validate
#
# Real-plan flow:
#   terraform init && terraform plan
# requires Phase 1 to be applied in the target account — the `data` lookups
# above will fail closed with a clear "no matching cluster / secret found"
# error otherwise. In production, replace the `locals` block below with
# `terraform_remote_state` lookups against your `envs/dev/backend.tf`:
#   data "terraform_remote_state" "network" {
#     backend = "s3"
#     config = {
#       bucket = "terraform-state-<ACCOUNT_ID>-dev"
#       key    = "examples/network-basic/terraform.tfstate"
#       region = "us-east-1"
#     }
#   }
# (and analogous blocks for ecs-cluster, aurora, redis, cognito, ingress).
###############################################################################

terraform {
  required_version = "~> 1.7"

  # Local-only example backend — no S3/DynamoDB lock. Real deploys live in
  # envs/dev/main.tf with the `s3` backend (see strata/templates/aws/envs/).
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "aws" {
  region              = "us-east-1"
  allowed_account_ids = ["<ACCOUNT_ID>"]
}

###############################################################################
# Live Phase 1 lookups + non-secret sentinels.
#
# Resources whose ARNs embed AWS-generated random suffixes (Aurora master
# credential secret, Redis AUTH-token secret, Aurora proxy endpoint, Redis
# endpoint) are sourced via `data` lookups against the deployed Phase 1
# modules. This was a literal-XXXX local on the original harness — Phase 5
# IAM review HIGH-2 traced live drift in `strata-dev-dev-task` to a stale
# `terraform apply` from this directory baking those XXXX strings into the
# IAM policies' Resource fields.
#
# Resources whose IDs are deterministic (cluster ARN, log group name) stay
# as locals so the harness can still `terraform validate` against an
# unapplied account.
###############################################################################

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# Aurora cluster — identifier is deterministic (`strata-${env}` per the
# aurora-postgres module). The cluster's master_user_secret[].secret_arn
# is the live AWS-managed credential ARN the Strata task role must read.
data "aws_rds_cluster" "aurora" {
  cluster_identifier = "strata-${local.env}"
}

# Redis AUTH-token secret — provisioned by the elasticache-redis module
# at the deterministic name `strata/${env}/cache/auth-token`.
data "aws_secretsmanager_secret" "redis_auth" {
  name = "strata/${local.env}/cache/auth-token"
}

# RDS Proxy endpoint — looked up by name so the harness gets the real
# proxy DNS (the previous literal embedded a XXXX cluster resource id).
data "aws_db_proxy" "aurora" {
  name = "strata-${local.env}-proxy"
}

# Redis Serverless cache — looked up by name for its real endpoint.
data "aws_elasticache_serverless_cache" "redis" {
  name = "strata-${local.env}-cache"
}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.name
  env        = "dev"

  # network module — sentinels (real apply path is the orchestrator).
  vpc_id   = "vpc-0da4fadaa6e653c5b"
  vpc_cidr = "10.40.0.0/16"
  private_subnet_ids = [
    "subnet-0d73b510d4f133e39",
    "subnet-026485c08d8165cb1",
    "subnet-0f4d29d6534a7b9d0",
  ]

  # ecs-cluster module — deterministic ARN shape.
  cluster_arn       = "arn:aws:ecs:${local.region}:${local.account_id}:cluster/strata-${local.env}"
  cluster_log_group = "/ecs/strata-${local.env}"

  # aurora-postgres module — live lookups for ARN-bearing values.
  aurora_proxy_endpoint    = data.aws_db_proxy.aurora.endpoint
  aurora_master_username   = "strata_admin"
  aurora_master_secret_arn = data.aws_rds_cluster.aurora.master_user_secret[0].secret_arn
  aurora_security_group_id = "sg-0aurorasentinel0000"

  # elasticache-redis module — live lookups for ARN-bearing values.
  redis_endpoint          = data.aws_elasticache_serverless_cache.redis.endpoint[0].address
  redis_auth_secret_arn   = data.aws_secretsmanager_secret.redis_auth.arn
  redis_security_group_id = "sg-0redissentinel00000"

  # cognito-user-pool module — sentinels (real ID is generated; harness
  # uses a structurally-valid placeholder so validate stays green).
  cognito_user_pool_id        = "${local.region}_XXXXXXXXX"
  cognito_user_pool_client_id = "Xxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  cognito_jwks_uri            = "https://cognito-idp.${local.region}.amazonaws.com/${local.cognito_user_pool_id}/.well-known/jwks.json"

  # ingress module — sentinels (only used for non-IAM env wiring).
  ingress_vpc_link_id           = "vpclink-XXXXXXXX"
  ingress_apigw_api_id          = "Xxxxxxxxxx"
  ingress_apigw_integration_uri = "http://strata.strata-${local.env}.local:3000"
  ingress_endpoint_dns          = "Xxxxxxxxxx.execute-api.${local.region}.amazonaws.com"
}

###############################################################################
# Caller-owned task execution role.
#
# Real envs/dev/main.tf creates a single shared task-execution role alongside
# the ECS cluster and grants it `AmazonECSTaskExecutionRolePolicy` plus
# secretsmanager:GetSecretValue on every service's secret ARNs. For the
# example we own a service-scoped one to keep the wiring visible.
###############################################################################

data "aws_iam_policy_document" "exec_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "exec_secrets_read" {
  statement {
    sid    = "ReadServiceSecrets"
    effect = "Allow"
    actions = [
      "secretsmanager:GetSecretValue",
    ]
    resources = [
      module.strata_service.database_url_secret_arn,
      module.strata_service.auth_proxy_secret_arn,
      local.redis_auth_secret_arn,
      local.aurora_master_secret_arn,
    ]
  }
}

resource "aws_iam_role" "task_exec" {
  name               = "strata-${local.env}-svc-exec"
  assume_role_policy = data.aws_iam_policy_document.exec_assume.json
  description        = "Task-execution role for the strata service example. Pulls the image, writes log streams, resolves secrets at task launch."

  tags = {
    Project   = "strata"
    Component = "strata-service-example"
    ManagedBy = "terraform"
  }
}

resource "aws_iam_role_policy_attachment" "task_exec_managed" {
  role       = aws_iam_role.task_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "task_exec_secrets" {
  name   = "service-secrets-read"
  role   = aws_iam_role.task_exec.id
  policy = data.aws_iam_policy_document.exec_secrets_read.json
}

###############################################################################
# Aurora consumer policy — synthesized inline here from the master-secret ARN
# so this example can validate without a remote_state pull. In production this
# comes verbatim from `module.aurora_postgres.consumer_iam_policy_json`.
###############################################################################

data "aws_iam_policy_document" "aurora_consumer_sentinel" {
  statement {
    sid       = "ReadAuroraMasterSecret"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    resources = [local.aurora_master_secret_arn]
  }
}

data "aws_iam_policy_document" "redis_consumer_sentinel" {
  statement {
    sid       = "ReadRedisAuthToken"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    resources = [local.redis_auth_secret_arn]
  }
}

###############################################################################
# Service composition under test.
###############################################################################

module "strata_service" {
  source = "../.."

  env_name   = local.env
  aws_region = local.region

  vpc_id             = local.vpc_id
  vpc_cidr           = local.vpc_cidr
  private_subnet_ids = local.private_subnet_ids

  cluster_arn                = local.cluster_arn
  cluster_execution_role_arn = aws_iam_role.task_exec.arn
  cluster_log_group_name     = local.cluster_log_group

  aurora_proxy_endpoint           = local.aurora_proxy_endpoint
  aurora_database_name            = "strata"
  aurora_master_username          = local.aurora_master_username
  aurora_master_secret_arn        = local.aurora_master_secret_arn
  aurora_consumer_iam_policy_json = data.aws_iam_policy_document.aurora_consumer_sentinel.json
  aurora_security_group_id        = local.aurora_security_group_id

  redis_endpoint                 = local.redis_endpoint
  redis_port                     = 6379
  redis_auth_secret_arn          = local.redis_auth_secret_arn
  redis_consumer_iam_policy_json = data.aws_iam_policy_document.redis_consumer_sentinel.json
  redis_security_group_id        = local.redis_security_group_id

  cognito_user_pool_id        = local.cognito_user_pool_id
  cognito_user_pool_client_id = local.cognito_user_pool_client_id
  cognito_jwks_uri            = local.cognito_jwks_uri

  ingress_backend               = "apigw"
  ingress_vpc_link_id           = local.ingress_vpc_link_id
  ingress_apigw_api_id          = local.ingress_apigw_api_id
  ingress_apigw_integration_uri = local.ingress_apigw_integration_uri
  ingress_endpoint_dns          = local.ingress_endpoint_dns

  container_image = "ghcr.io/kytheros/strata-mcp:latest"
  cpu             = 512
  memory          = 1024
  desired_count   = 1
  log_level       = "info"

  extra_tags = {
    Owner   = "platform"
    Example = "dev"
  }
}

output "service_name" {
  value = module.strata_service.service_name
}

output "service_arn" {
  value = module.strata_service.service_arn
}

output "health_check_url" {
  value = module.strata_service.health_check_url
}

output "task_role_arn" {
  value = module.strata_service.task_role_arn
}

output "security_group_id" {
  value = module.strata_service.security_group_id
}

output "database_url_secret_arn" {
  value = module.strata_service.database_url_secret_arn
}

output "auth_proxy_secret_arn" {
  value = module.strata_service.auth_proxy_secret_arn
}
