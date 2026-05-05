###############################################################################
# Example: deploy the ecs-cluster module to the dev account (624990353897).
#
# Run from this directory:
#   aws sts get-caller-identity   # confirm you are mike-cli @ 624990353897
#   terraform init
#   terraform plan -out plan.tfplan
#   terraform apply plan.tfplan
#
# This example uses the dev backend created by AWS-0.1 (bootstrap). The state
# key is namespaced under examples/ so it does not collide with envs/dev/.
#
# ECS clusters are network-independent — they don't bind to a VPC. Services
# attached to the cluster (built by AWS-1.3 ecs-service) bind to subnets at
# the service layer. So this example takes no network module input.
###############################################################################

terraform {
  required_version = "~> 1.7"

  backend "s3" {
    bucket         = "terraform-state-624990353897-dev"
    key            = "examples/ecs-cluster-basic/terraform.tfstate"
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
  region = "us-east-1"

  # Sanity guard: this example is hard-coded for the dev account.
  allowed_account_ids = ["624990353897"]
}

module "ecs_cluster" {
  source = "../.."

  env_name = "dev"

  # Defaults are appropriate for dev: 80% Spot, 30d log retention, 7d KMS
  # deletion window, us-east-1. extra_tags merges into the module tag set.
  extra_tags = {
    Owner = "platform"
  }
}

output "cluster_id" {
  value = module.ecs_cluster.cluster_id
}

output "cluster_name" {
  value = module.ecs_cluster.cluster_name
}

output "cluster_arn" {
  value = module.ecs_cluster.cluster_arn
}

output "log_group_name" {
  value = module.ecs_cluster.log_group_name
}

output "log_group_arn" {
  value = module.ecs_cluster.log_group_arn
}

output "kms_key_arn" {
  value = module.ecs_cluster.kms_key_arn
}

output "kms_key_alias" {
  value = module.ecs_cluster.kms_key_alias
}

output "exec_role_arn" {
  value = module.ecs_cluster.exec_role_arn
}
