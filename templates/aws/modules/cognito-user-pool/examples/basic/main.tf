###############################################################################
# Example: deploy the cognito-user-pool module to the dev account (624990353897).
#
# Demonstrates the user-pool-only path: no Google/GitHub federation wired,
# both consumer-supplied Lambda triggers left empty (the module's inert stubs
# are used). This is the right shape for a first dev apply; federation lands
# later once a Secrets Manager secret holding the Google OAuth client secret
# exists.
#
# To enable Google federation later:
#
#   1. Provision a Google Cloud OAuth Client (Web application) in GCP console.
#   2. Store the client secret in Secrets Manager:
#        aws secretsmanager create-secret \
#          --name strata/dev/google-oauth-client-secret \
#          --secret-string '<paste-secret-here>' \
#          --description "Google OAuth client secret for Strata example-agent dev"
#   3. Add the Google client ID + the secret ARN to the module call below:
#        google_client_id         = "1234.apps.googleusercontent.com"
#        google_client_secret_arn = "arn:aws:secretsmanager:us-east-1:624990353897:secret:strata/dev/google-oauth-client-secret-XXXXXX"
#   4. terraform apply.
#
# GitHub federation is more involved — see README §"GitHub federation". For
# v1 dev, leaving GitHub vars empty is the right call.
#
# Run from this directory:
#   aws sts get-caller-identity   # confirm you are mike-cli @ 624990353897
#   terraform init
#   terraform plan -out plan.tfplan
#   terraform apply plan.tfplan
###############################################################################

terraform {
  required_version = "~> 1.7"

  backend "s3" {
    bucket         = "terraform-state-624990353897-dev"
    key            = "examples/cognito-user-pool-basic/terraform.tfstate"
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

module "cognito_user_pool" {
  source = "../.."

  env_name   = "dev"
  aws_region = "us-east-1"

  # MFA optional, advanced security in AUDIT mode (dev defaults). Prod
  # tfvars would flip these to ON / ENFORCED.
  mfa_configuration      = "OPTIONAL"
  advanced_security_mode = "AUDIT"

  # Dev allows destroy/recreate; prod would set ACTIVE.
  deletion_protection = "INACTIVE"

  # Dev callback / logout URLs default to localhost — fine until the
  # example-agent service deploys and we know its public hostname.
  callback_urls = ["https://localhost:3000/auth/callback"]
  logout_urls   = ["https://localhost:3000"]

  # Backend client — the example-agent Next.js server holds the secret.
  generate_client_secret = true

  # Federation left empty for v1 dev apply. Module skips Google/GitHub IdPs
  # cleanly when these are unset.
  # google_client_id         = ""
  # google_client_secret_arn = ""
  # github_client_id         = ""
  # github_client_secret_arn = ""
  # github_native_oidc_endpoint = ""

  # PreSignUp / PostConfirmation overrides intentionally empty — module
  # ships inert stubs as the default. The example-agent service (AWS-3.2)
  # supplies the real handlers and re-applies this module with the ARNs.
  # pre_signup_lambda_arn        = ""
  # post_confirmation_lambda_arn = ""

  extra_tags = {
    Owner   = "platform"
    Example = "cognito-user-pool-basic"
  }
}

###############################################################################
# Outputs — surface the load-bearing values for downstream module consumption.
###############################################################################

output "user_pool_id" {
  value = module.cognito_user_pool.user_pool_id
}

output "user_pool_arn" {
  value = module.cognito_user_pool.user_pool_arn
}

output "user_pool_client_id" {
  value = module.cognito_user_pool.user_pool_client_id
}

output "hosted_ui_domain" {
  value = module.cognito_user_pool.hosted_ui_domain
}

output "hosted_ui_login_url" {
  value = module.cognito_user_pool.hosted_ui_login_url
}

output "jwks_uri" {
  value = module.cognito_user_pool.jwks_uri
}

output "issuer_url" {
  value = module.cognito_user_pool.issuer_url
}

output "pre_token_generation_lambda_arn" {
  value = module.cognito_user_pool.pre_token_generation_lambda_arn
}

output "pre_signup_lambda_arn_effective" {
  value = module.cognito_user_pool.pre_signup_lambda_arn_effective
}

output "post_confirmation_lambda_arn_effective" {
  value = module.cognito_user_pool.post_confirmation_lambda_arn_effective
}

output "groups" {
  value = module.cognito_user_pool.groups
}

output "google_federation_enabled" {
  value = module.cognito_user_pool.google_federation_enabled
}

output "github_federation_enabled" {
  value = module.cognito_user_pool.github_federation_enabled
}
