###############################################################################
# Example: deploy the network module to the dev account (624990353897).
#
# Run from this directory:
#   aws sts get-caller-identity   # confirm you are mike-cli @ 624990353897
#   terraform init
#   terraform plan -out plan.tfplan
#   terraform apply plan.tfplan
#
# This example uses the dev backend created by AWS-0.1 (bootstrap). The state
# key is namespaced under examples/ so it doesn't collide with envs/dev/.
###############################################################################

terraform {
  required_version = "~> 1.7"

  backend "s3" {
    bucket         = "terraform-state-624990353897-dev"
    key            = "examples/network-basic/terraform.tfstate"
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

module "network" {
  source = "../.."

  env_name = "dev"
  vpc_cidr = "10.40.0.0/16"

  # Defaults for region, AZs, and flow-log retention are appropriate for dev.
  # extra_tags merges into the module's default tag set.
  extra_tags = {
    Owner = "platform"
  }
}

output "vpc_id" {
  value = module.network.vpc_id
}

output "vpc_cidr" {
  value = module.network.vpc_cidr
}

output "public_subnet_ids" {
  value = module.network.public_subnet_ids
}

output "private_subnet_ids" {
  value = module.network.private_subnet_ids
}

output "isolated_subnet_ids" {
  value = module.network.isolated_subnet_ids
}

output "nat_gateway_ids" {
  value = module.network.nat_gateway_ids
}

output "nat_eip_public_ips" {
  value = module.network.nat_eip_public_ips
}

output "flow_log_group_arn" {
  value = module.network.flow_log_group_arn
}

output "vpce_security_group_id" {
  value = module.network.vpce_security_group_id
}

output "gateway_endpoint_ids" {
  value = module.network.gateway_endpoint_ids
}

output "interface_endpoint_ids" {
  value = module.network.interface_endpoint_ids
}
