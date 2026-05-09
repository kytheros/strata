###############################################################################
# MODULE-VALIDATION HARNESS — not the canonical apply target.
#
# As of AWS-1.5.1, the canonical apply path is `envs/dev/main.tf`, which
# composes services/example-agent against the live network/cluster/cognito/
# ingress modules with direct module-output wiring (no sentinels). This
# file remains for `terraform validate` against the example-agent
# composition surface in isolation. The sentinel ARNs below intentionally
# do not resolve to live resources — `terraform plan` will fail. Use
# `task dev:up` (envs/dev/) for a real apply.
###############################################################################

###############################################################################
# Example: deploy the example-agent service composition to the dev account.
#
# This example uses sentinel ARNs for the cluster, log group, network, and
# ingress wiring. `terraform validate` passes; `terraform plan` would fail at
# apply time because the sentinel ARNs aren't real resources.
#
# Run from this directory:
#   aws sts get-caller-identity   # confirm you are <your-cli-user> @ <ACCOUNT_ID>
#   terraform init
#   terraform validate            # validation stops here
###############################################################################

terraform {
  required_version = "~> 1.7"

  backend "s3" {
    bucket         = "terraform-state-<ACCOUNT_ID>-dev"
    key            = "examples/example-agent-dev/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "terraform-state-locks"
    encrypt        = true
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }
}

provider "aws" {
  region              = "us-east-1"
  allowed_account_ids = ["<ACCOUNT_ID>"]
}

###############################################################################
# Sentinel references — swap for real lookups once Phase 1 modules are applied.
###############################################################################

locals {
  cluster_arn    = "arn:aws:ecs:us-east-1:<ACCOUNT_ID>:cluster/strata-dev"
  log_group_name = "/ecs/strata-dev"
  vpc_id         = "vpc-0da4fadaa6e653c5b"
  vpc_cidr       = "10.40.0.0/16"
  private_subnet_ids = [
    "subnet-0d73b510d4f133e39",
    "subnet-026485c08d8165cb1",
    "subnet-0f4d29d6534a7b9d0",
  ]

  # API GW VPC link sentinel — `ingress` module's apigw example will
  # produce a real ID once applied.
  apigw_vpc_link_id = "abcdef"
  apigw_api_id      = "1234567890"
}

# Thin task execution role — same pattern as ecs-service/examples/basic/.
# A real envs/dev/main.tf would share one role across all services.
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
  name               = "example-agent-dev-exec"
  assume_role_policy = data.aws_iam_policy_document.exec_assume.json
  description        = "ECS task execution role for the example-agent dev service."

  tags = {
    Project   = "strata"
    Component = "example-agent"
    ManagedBy = "terraform"
  }
}

resource "aws_iam_role_policy_attachment" "task_exec" {
  role       = aws_iam_role.task_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

###############################################################################
# Service composition under test
###############################################################################

module "example_agent" {
  source = "../.."

  env_name   = "dev"
  aws_region = "us-east-1"

  # Federation deferred to a real apply — caller creates the Google
  # OAuth app in GCP console, drops the secret in Secrets Manager, then
  # populates these. AWS-3.1 plan-only validation works without them.
  google_client_id         = ""
  google_client_secret_arn = ""

  # AWS-3.2: Lambdas are now owned by the composition itself; no override
  # needed. The composition packages them from services/example-agent/lambdas/
  # and threads the ARNs into the cognito-user-pool module.

  initial_allowlist = ["you@example.com"]

  # Localhost until the real public hostname lands in a tfvars override.
  app_url       = "https://localhost:3000"
  callback_urls = ["https://localhost:3000/api/auth/callback"]
  logout_urls   = ["https://localhost:3000"]

  # Sentinel container image. Swap for the ECR-pushed image once the
  # build pipeline runs.
  container_image = "public.ecr.aws/example/example-agent:placeholder"

  cluster_arn        = local.cluster_arn
  execution_role_arn = aws_iam_role.task_exec.arn
  log_group_name     = local.log_group_name

  vpc_id     = local.vpc_id
  vpc_cidr   = local.vpc_cidr
  subnet_ids = local.private_subnet_ids

  ingress_backend             = "apigw"
  attach_to_apigw_vpc_link_id = local.apigw_vpc_link_id
  apigw_api_id                = local.apigw_api_id
  apigw_integration_uri       = "http://example-agent.svc.local:3000"

  cpu            = 512
  memory         = 1024
  desired_count  = 1
  container_port = 3000

  extra_tags = {
    Owner   = "platform"
    Example = "example-agent-dev"
  }
}

###############################################################################
# Outputs
###############################################################################

output "service_arn" {
  value = module.example_agent.service_arn
}

output "service_name" {
  value = module.example_agent.service_name
}

output "app_url" {
  value = module.example_agent.app_url
}

output "user_pool_id" {
  value = module.example_agent.user_pool_id
}

output "cognito_hosted_ui_url" {
  value = module.example_agent.cognito_hosted_ui_url
}

output "allowlist_ssm_path" {
  value = module.example_agent.allowlist_ssm_path
}

output "allowlist_kms_key_arn" {
  value = module.example_agent.allowlist_kms_key_arn
}

output "approved_group_arn" {
  value = module.example_agent.approved_group_arn
}

output "google_federation_enabled" {
  value = module.example_agent.google_federation_enabled
}
