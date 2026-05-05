###############################################################################
# Example: Strata-on-AWS service against the dev account (624990353897).
#
# This example wires `services/strata` against sentinel outputs that match
# the shape of the AWS-1.x example basics. In production, replace the
# `locals` block below with `terraform_remote_state` lookups against your
# `envs/dev/backend.tf` once those are in place.
#
# Validation:
#   terraform init -backend=false
#   terraform validate
#
# DO NOT `terraform plan` from this directory unless every Phase 1 module's
# example basics are applied in the dev account — the data-source-free
# sentinels below will not match any live resources, and even if they did,
# Phase 1 is currently destroyed (network is down). This example proves
# composition-shape validity, not deploy-readiness.
#
# When you DO want a real plan, replace the local sentinels with:
#   data "terraform_remote_state" "network" {
#     backend = "s3"
#     config = {
#       bucket = "terraform-state-624990353897-dev"
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
  allowed_account_ids = ["624990353897"]
}

###############################################################################
# Sentinel outputs from the AWS-1.x example basics.
#
# These mirror the deterministic naming patterns each Phase 1 module uses
# (e.g., `strata-${env}` cluster name → ARN). They are NOT live resource IDs;
# they exist so this example can `terraform validate` cleanly without taking
# a runtime dependency on AWS APIs.
###############################################################################

locals {
  account_id = "624990353897"
  region     = "us-east-1"
  env        = "dev"

  # network module
  vpc_id   = "vpc-0699c5389404c9e47"
  vpc_cidr = "10.40.0.0/16"
  private_subnet_ids = [
    "subnet-054d3b36eb91aa163",
    "subnet-01ac5f3b23d41fb10",
    "subnet-0844bdf32b17593a4",
  ]

  # ecs-cluster module
  cluster_arn       = "arn:aws:ecs:${local.region}:${local.account_id}:cluster/strata-${local.env}"
  cluster_log_group = "/ecs/strata-${local.env}"

  # aurora-postgres module
  aurora_proxy_endpoint    = "strata-${local.env}-proxy.proxy-cluster-XXXXXXXXXXXX.${local.region}.rds.amazonaws.com"
  aurora_master_username   = "strata_admin"
  aurora_master_secret_arn = "arn:aws:secretsmanager:${local.region}:${local.account_id}:secret:rds!cluster-XXXXXXXXXXXX-XXXXXXXX"
  aurora_security_group_id = "sg-0aurorasentinel0000"

  # elasticache-redis module
  redis_endpoint          = "strata-${local.env}-cache-XXXXXX.serverless.${local.region}.cache.amazonaws.com"
  redis_auth_secret_arn   = "arn:aws:secretsmanager:${local.region}:${local.account_id}:secret:strata/${local.env}/cache/auth-token-XXXXXX"
  redis_security_group_id = "sg-0redissentinel00000"

  # cognito-user-pool module
  cognito_user_pool_id        = "${local.region}_XXXXXXXXX"
  cognito_user_pool_client_id = "Xxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  cognito_jwks_uri            = "https://cognito-idp.${local.region}.amazonaws.com/${local.cognito_user_pool_id}/.well-known/jwks.json"

  # ingress module — dev defaults apigw per design §"Dev tier"
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
