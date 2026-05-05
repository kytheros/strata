###############################################################################
# example-agent service composition.
#
# Three things this composition owns directly:
#   1. The Cognito User Pool (via the cognito-user-pool module). Federation
#      IdPs flow through; PreSignUp/PostConfirmation Lambdas remain inert
#      stubs in AWS-3.1 — AWS-3.2 swaps the real ARNs in.
#   2. The SSM Parameter Store allowlist (KMS-encrypted SecureString) +
#      its CMK. Operators edit this parameter directly post-apply; no
#      redeploy needed for membership changes.
#   3. The ecs-service module call that runs the Next.js container.
#
# This module deliberately does NOT define the network, the cluster, the
# ingress, or the secrets-rotation Lambdas — those come from Phase 1
# modules and are passed in as variables.
###############################################################################

locals {
  default_tags = merge(
    {
      Project     = "strata"
      Component   = "example-agent"
      ManagedBy   = "terraform"
      Environment = var.env_name
      Service     = "example-agent-${var.env_name}"
    },
    var.extra_tags,
  )

  service_name = "example-agent-${var.env_name}"
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

###############################################################################
# 1. Cognito User Pool — federation + Lambda triggers
###############################################################################

module "cognito_user_pool" {
  source = "../../../modules/cognito-user-pool"

  env_name   = var.env_name
  aws_region = var.aws_region

  # The Hosted UI must redirect back to the app's /api/auth/callback
  # route. callback_urls lets Cognito accept that redirect.
  callback_urls = var.callback_urls
  logout_urls   = var.logout_urls

  # Backend client — the example-agent server holds the secret and
  # performs the OAuth code exchange server-side.
  generate_client_secret = true

  # Federation: caller supplies Google IdP credentials. Both must be
  # set or neither — the cognito-user-pool module skips the IdP cleanly
  # when one is empty.
  google_client_id         = var.google_client_id
  google_client_secret_arn = var.google_client_secret_arn

  # PreSignUp + PostConfirmation: AWS-3.1 leaves these empty so the
  # cognito-user-pool module's inert stubs handle the trigger graph.
  # AWS-3.2 replaces with real Lambda ARNs.
  pre_signup_lambda_arn        = var.pre_signup_lambda_arn
  post_confirmation_lambda_arn = var.post_confirmation_lambda_arn

  extra_tags = local.default_tags
}

###############################################################################
# 2. SSM Parameter Store allowlist + CMK
#
# Why a CMK and not the AWS-managed alias/aws/ssm key:
#   - Per-service CMK gives a single point to rotate, audit, or revoke.
#   - The PreSignUp Lambda's IAM policy can be scoped to this exact key,
#     so a compromised Lambda can't decrypt other services' secrets.
#   - $1/mo cost for the CMK is negligible at portfolio-demo scale.
###############################################################################

resource "aws_kms_key" "allowlist" {
  description             = "CMK for the example-agent ${var.env_name} email allowlist (SSM SecureString)."
  deletion_window_in_days = 7
  enable_key_rotation     = true

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "EnableRootAccountAccess"
        Effect    = "Allow"
        Principal = { AWS = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        Sid    = "AllowSsmServiceUse"
        Effect = "Allow"
        Principal = {
          Service = "ssm.${data.aws_partition.current.dns_suffix}"
        }
        Action = [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:ReEncrypt*",
          "kms:GenerateDataKey*",
          "kms:DescribeKey",
        ]
        Resource = "*"
      },
    ]
  })

  tags = local.default_tags
}

resource "aws_kms_alias" "allowlist" {
  name          = "alias/example-agent-${var.env_name}-allowlist"
  target_key_id = aws_kms_key.allowlist.key_id
}

resource "aws_ssm_parameter" "allowlist" {
  name        = "/example-agent/${var.env_name}/allowed-emails"
  description = "JSON-encoded array of email addresses allowed to sign up for the example-agent in ${var.env_name}. Edited post-apply by operators; AWS-3.2 PreSignUp Lambda reads this on every signup attempt."
  type        = "SecureString"
  key_id      = aws_kms_key.allowlist.arn
  value       = jsonencode(var.initial_allowlist)
  tier        = "Standard"

  tags = local.default_tags

  # Allowlist mutates out-of-band — operators edit it via the AWS Console
  # or CLI as people get added. Don't fight that with `terraform apply`.
  lifecycle {
    ignore_changes = [value]
  }
}

###############################################################################
# 3. ECS Service — runs the Next.js standalone container
#
# The ecs-service module wires the task definition, service, autoscaling,
# task IAM role, security group, and (when var.ingress_backend = alb)
# the ALB target group + listener rule. AWS-3.3 will replace the inline
# task_role policy with the ReadOnlyAccess + deny-IAM/Secrets/KMS pair.
###############################################################################

# Stub task role policy. AWS-3.3 replaces this with the SDK ReadOnlyAccess
# baseline + the deny statement covering iam/secretsmanager/kms reads.
data "aws_iam_policy_document" "task_role_stub" {
  statement {
    sid       = "AllowSsmGetAllowlist"
    effect    = "Allow"
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.allowlist.arn]
  }

  statement {
    sid    = "AllowKmsDecryptForAllowlist"
    effect = "Allow"
    actions = [
      "kms:Decrypt",
    ]
    resources = [aws_kms_key.allowlist.arn]
  }
}

module "ecs_service" {
  source = "../../../modules/ecs-service"

  env_name     = var.env_name
  service_name = local.service_name
  aws_region   = var.aws_region

  cluster_arn        = var.cluster_arn
  execution_role_arn = var.execution_role_arn
  log_group_name     = var.log_group_name

  vpc_id     = var.vpc_id
  vpc_cidr   = var.vpc_cidr
  subnet_ids = var.subnet_ids

  cpu    = var.cpu
  memory = var.memory

  desired_count = var.desired_count

  containers = [
    {
      name  = "example-agent"
      image = var.container_image
      port_mappings = [
        {
          container_port = var.container_port
        },
      ]
      environment = [
        { name = "AWS_REGION", value = var.aws_region },
        { name = "COGNITO_USER_POOL_ID", value = module.cognito_user_pool.user_pool_id },
        { name = "COGNITO_CLIENT_ID", value = module.cognito_user_pool.user_pool_client_id },
        { name = "COGNITO_HOSTED_UI_DOMAIN", value = module.cognito_user_pool.hosted_ui_domain },
        { name = "COGNITO_REQUIRED_GROUP", value = "approved" },
        { name = "APP_URL", value = var.app_url },
        { name = "STRATA_INTERNAL_URL", value = var.strata_internal_url },
        { name = "ALLOWLIST_SSM_PATH", value = aws_ssm_parameter.allowlist.name },
      ]
      secrets = concat(
        [
          # Cognito client secret is sensitive — pull from the cognito
          # module's output via Secrets Manager? No — Cognito doesn't
          # surface client_secret as a Secrets Manager entry. We
          # surface it via env in the *task definition Terraform plan
          # only* (state is encrypted; secret never reaches a tfvars
          # file). For the AWS-3.1 stub we wire it as an environment
          # variable populated from the cognito module output. AWS-3.3
          # may move it into Secrets Manager if a rotation strategy
          # demands it.
        ],
        var.strata_auth_proxy_token_secret_arn != "" ? [
          { name = "STRATA_AUTH_PROXY_TOKEN", value_from = var.strata_auth_proxy_token_secret_arn },
        ] : [],
        var.anthropic_api_key_secret_arn != "" ? [
          { name = "ANTHROPIC_API_KEY", value_from = var.anthropic_api_key_secret_arn },
        ] : [],
      )
      health_check = {
        # The Next.js standalone server returns 200 on / once it boots.
        # /api/auth/login is also fine but / is canonical.
        command      = ["CMD-SHELL", "wget -qO- http://localhost:${var.container_port}/ >/dev/null 2>&1 || exit 1"]
        interval     = 30
        timeout      = 5
        retries      = 3
        start_period = 30
      }
    },
  ]

  container_port_for_ingress = var.container_port

  # Ingress attachment — pass-through. ecs-service handles both backends.
  attach_to_alb_listener_arn  = var.ingress_backend == "alb" ? var.attach_to_alb_listener_arn : ""
  alb_listener_priority       = var.alb_listener_priority
  attach_to_apigw_vpc_link_id = var.ingress_backend == "apigw" ? var.attach_to_apigw_vpc_link_id : ""
  apigw_api_id                = var.ingress_backend == "apigw" ? var.apigw_api_id : ""
  apigw_integration_uri       = var.ingress_backend == "apigw" ? var.apigw_integration_uri : ""

  # Stub task role — AWS-3.3 replaces with ReadOnlyAccess + deny.
  task_role_inline_policies = [
    {
      name        = "ssm-allowlist-read"
      policy_json = data.aws_iam_policy_document.task_role_stub.json
    },
  ]

  # AWS-3.3 will add: arn:aws:iam::aws:policy/ReadOnlyAccess.
  task_role_managed_policy_arns = []

  # Cognito client secret is needed by the Next.js server for the OAuth
  # code exchange. The cognito-user-pool module marks the output
  # `sensitive` and we deliberately do NOT add it to environment[] here
  # — leaving it as a placeholder for AWS-3.2 to wire via Secrets
  # Manager + the secrets[] block. This keeps the secret out of any
  # describe-task-definition output that might leak via CloudTrail.
  #
  # AWS-3.2 contract: create a Secrets Manager entry named
  # `example-agent/{env}/cognito-client-secret`, populate it from
  # module.cognito_user_pool.user_pool_client_secret, then add it to
  # the secrets[] list above as
  #   { name = "COGNITO_CLIENT_SECRET", value_from = "<arn>" }.

  extra_tags = local.default_tags
}
