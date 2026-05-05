###############################################################################
# Example: minimal nginx:alpine ECS service against the dev cluster.
#
# Run from this directory:
#   aws sts get-caller-identity   # confirm you are mike-cli @ 624990353897
#   terraform init
#   terraform plan -out plan.tfplan
#   # DO NOT apply during AWS-1.3 verification — the goal is plan-only validation.
#
# What this provisions:
#   - 1 task definition (nginx:alpine, port 80, awslogs to the cluster log group)
#   - 1 ECS service on Fargate (Spot-weighted), 1 task, no LB attachment
#   - 1 task IAM role (trust ecs-tasks; no inline policies — nginx needs nothing)
#   - 1 task security group (egress to VPC + 443 to anywhere)
#   - 1 thin task execution role (image pull + log writes) — created inline here
#     since the cluster module's exec_role is the *operator* exec role
#   - App Auto Scaling target with the always-on CPU policy
#
# What this does NOT provision: an ALB, an API GW, Service Connect.
# Plan path covers the simplest possible service shape, useful for verifying
# IAM + SG wiring before moving to the realistic strata-service example.
#
# Live dev account references (from AWS-1.1 / AWS-1.2 applies):
#   account     : 624990353897
#   vpc         : vpc-0699c5389404c9e47
#   private SGs : subnet-054d3b36eb91aa163, subnet-01ac5f3b23d41fb10, subnet-0844bdf32b17593a4
#   cluster     : strata-dev (looked up via data source below)
#   log group   : /ecs/strata-dev (same)
###############################################################################

terraform {
  required_version = "~> 1.7"

  backend "s3" {
    bucket         = "terraform-state-624990353897-dev"
    key            = "examples/ecs-service-basic/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "terraform-state-locks"
    encrypt        = true
  }

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
}

###############################################################################
# Hardcoded references to the AWS-1.2 cluster shape.
#
# AWS-1.2 has been authored and plan-validated but is not yet applied in dev,
# so `data "aws_ecs_cluster"` lookups would fail. The cluster name and log
# group name are deterministic from the AWS-1.2 module's locals
# (`strata-${env}` / `/ecs/strata-${env}`) and the cluster ARN is
# deterministic from the AWS account + region. We hardcode them here so this
# example can plan without taking a runtime data dependency on a live cluster.
#
# When AWS-1.2 is applied, swap the locals below for `data "aws_ecs_cluster"`
# / `data "aws_cloudwatch_log_group"` lookups (or, ideally, `terraform_remote_state`
# against the cluster's example backend).
###############################################################################

locals {
  cluster_arn       = "arn:aws:ecs:us-east-1:624990353897:cluster/strata-dev"
  cluster_log_group = "/ecs/strata-dev"
}

###############################################################################
# Task execution role — pulls the image and writes the initial log stream.
#
# Distinct from the cluster's `exec_role_arn` (which is the operator role for
# `aws ecs execute-command`). For a real envs/dev/main.tf this would be a
# shared role created alongside the cluster; for this example we own it.
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

resource "aws_iam_role" "task_exec" {
  name               = "strata-dev-ecs-svc-basic-exec"
  assume_role_policy = data.aws_iam_policy_document.exec_assume.json
  description        = "ECS task execution role for the ecs-service basic example (nginx:alpine)."

  tags = {
    Project   = "strata"
    Component = "ecs-service-example"
    ManagedBy = "terraform"
  }
}

resource "aws_iam_role_policy_attachment" "task_exec" {
  role       = aws_iam_role.task_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

###############################################################################
# Service module under test
###############################################################################

module "ecs_service" {
  source = "../.."

  env_name     = "dev"
  service_name = "ecs-svc-basic"

  cluster_arn        = local.cluster_arn
  execution_role_arn = aws_iam_role.task_exec.arn
  log_group_name     = local.cluster_log_group

  vpc_id   = "vpc-0699c5389404c9e47"
  vpc_cidr = "10.40.0.0/16"
  subnet_ids = [
    "subnet-054d3b36eb91aa163",
    "subnet-01ac5f3b23d41fb10",
    "subnet-0844bdf32b17593a4",
  ]

  cpu    = 256
  memory = 512

  containers = [
    {
      name  = "nginx"
      image = "public.ecr.aws/nginx/nginx:alpine"
      port_mappings = [
        {
          container_port = 80
        }
      ]
      environment = [
        {
          name  = "EXAMPLE"
          value = "ecs-service-basic"
        },
      ]
    },
  ]

  container_port_for_ingress = 80

  # No LB attachment — the simplest plan path.
  # No ingress_security_group_ids — service is unreachable on :80 from anything.
  # Egress is still permitted (VPC CIDR + 443 to 0.0.0.0/0) so the agent and
  # log driver can reach AWS APIs through the VPC endpoints.

  # Default capacity strategy (80% Spot / 20% on-demand) is appropriate for
  # the example.

  extra_tags = {
    Owner   = "platform"
    Example = "basic"
  }
}

###############################################################################
# Outputs
###############################################################################

output "service_name" {
  value = module.ecs_service.service_name
}

output "service_arn" {
  value = module.ecs_service.service_arn
}

output "task_definition_arn" {
  value = module.ecs_service.task_definition_arn
}

output "task_role_arn" {
  value = module.ecs_service.task_role_arn
}

output "security_group_id" {
  value = module.ecs_service.security_group_id
}
