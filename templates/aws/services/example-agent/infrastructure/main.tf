###############################################################################
# example-agent service composition.
#
# Three things this composition owns directly:
#   1. The Cognito User Pool (via the cognito-user-pool module). Federation
#      IdPs flow through; PreSignUp/PostConfirmation Lambdas are wired to the
#      composition-owned implementations under lambdas/{pre-signup,post-
#      confirmation}/.
#   2. The SSM Parameter Store allowlist (KMS-encrypted SecureString) +
#      its CMK. Operators edit this parameter directly post-apply; no
#      redeploy needed for membership changes.
#   3. The ecs-service module call that runs the Next.js container, plus the
#      Secrets Manager wrappers around the Cognito client secret + the
#      Anthropic API key.
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

  # Derive STRATA_INTERNAL_URL for the container env. Caller may pass an
  # explicit URL (var.strata_internal_url); failing that, build it from the
  # Service Connect namespace + Strata's port. Both empty → the env var is
  # not exported; the strata-client errors at request time if it's needed.
  strata_internal_url_effective = (
    var.strata_internal_url != "" ? var.strata_internal_url :
    var.cluster_service_connect_namespace != "" ?
    "http://strata.${var.cluster_service_connect_namespace}.local:${var.strata_internal_port}" :
    ""
  )
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

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

  # AWS-3.2 wires real Lambda ARNs. The cognito-user-pool module replaces
  # its inert stubs at re-apply time when these are non-empty.
  pre_signup_lambda_arn        = aws_lambda_function.pre_signup.arn
  post_confirmation_lambda_arn = aws_lambda_function.post_confirmation.arn

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
# 3. PreSignUp + PostConfirmation Lambdas (AWS-3.2)
#
# These replace the cognito-user-pool module's inert stubs. Source lives
# under services/example-agent/lambdas/{pre-signup,post-confirmation}/.
# Each handler is small (Node 22, native fetch, no third-party HTTP libs)
# and its IAM is least-privilege — see inline policy docs below.
###############################################################################

# ---- Pre-signup ------------------------------------------------------------

data "archive_file" "pre_signup" {
  type        = "zip"
  source_dir  = "${path.module}/../lambdas/pre-signup"
  output_path = "${path.module}/.terraform-build/pre-signup.zip"
  excludes    = ["node_modules", ".terraform-build"]
}

data "aws_iam_policy_document" "pre_signup_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "pre_signup" {
  name               = "example-agent-${var.env_name}-pre-signup"
  assume_role_policy = data.aws_iam_policy_document.pre_signup_assume.json
  description        = "Execution role for the example-agent ${var.env_name} PreSignUp Lambda — reads the SSM allowlist and decrypts via the allowlist CMK."

  tags = local.default_tags
}

resource "aws_iam_role_policy_attachment" "pre_signup_basic" {
  role       = aws_iam_role.pre_signup.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "pre_signup_inline" {
  statement {
    sid       = "ReadAllowlistParameter"
    effect    = "Allow"
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.allowlist.arn]
  }

  statement {
    sid       = "DecryptAllowlistKms"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.allowlist.arn]
  }
}

resource "aws_iam_role_policy" "pre_signup_inline" {
  name   = "ssm-allowlist-read"
  role   = aws_iam_role.pre_signup.id
  policy = data.aws_iam_policy_document.pre_signup_inline.json
}

resource "aws_cloudwatch_log_group" "pre_signup" {
  # checkov:skip=CKV_AWS_158:AWS-owned key; per-log-group CMK upgrade is tracked under AWS-1.10 (observability) where the key lifecycle is owned.
  # checkov:skip=CKV_AWS_338:7-day retention intentional — Lambda trigger logs are low-volume and long-tail forensics live in CloudTrail.
  name              = "/aws/lambda/example-agent-${var.env_name}-pre-signup"
  retention_in_days = 7
  tags              = local.default_tags
}

resource "aws_lambda_function" "pre_signup" {
  # checkov:skip=CKV_AWS_115:Reserved concurrency intentionally unset — Cognito triggers should not throttle signup.
  # checkov:skip=CKV_AWS_116:Cognito triggers are synchronous; failures surface as auth errors directly, not through a DLQ.
  # checkov:skip=CKV_AWS_117:Function only calls SSM + KMS over the AWS service backplane; VPC attachment would add NAT cost without security benefit.
  # checkov:skip=CKV_AWS_173:Env vars contain only the SSM parameter NAME (a non-secret identifier); KMS-encrypting adds operational cost without confidentiality benefit.
  # checkov:skip=CKV_AWS_272:Lambda code-signing is account-level work tracked under AWS-5.x (security polish phase).
  function_name    = "example-agent-${var.env_name}-pre-signup"
  description      = "Cognito PreSignUp trigger for the example-agent — enforces SSM-backed email allowlist."
  role             = aws_iam_role.pre_signup.arn
  runtime          = "nodejs22.x"
  architectures    = ["x86_64"]
  handler          = "index.handler"
  filename         = data.archive_file.pre_signup.output_path
  source_code_hash = data.archive_file.pre_signup.output_base64sha256
  memory_size      = 256
  timeout          = 30

  tracing_config {
    mode = "Active"
  }

  environment {
    variables = {
      ALLOWLIST_SSM_PARAM_NAME = aws_ssm_parameter.allowlist.name
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.pre_signup,
    aws_iam_role_policy.pre_signup_inline,
    aws_iam_role_policy_attachment.pre_signup_basic,
  ]

  tags = local.default_tags
}

# Cognito permission to invoke the trigger. The cognito-user-pool module
# does not create this permission when consumers pass an external ARN —
# the consumer (this composition) owns it.
resource "aws_lambda_permission" "pre_signup_cognito_invoke" {
  statement_id  = "AllowCognitoPreSignUp-${var.env_name}"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.pre_signup.function_name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = module.cognito_user_pool.user_pool_arn
}

# ---- Post-confirmation -----------------------------------------------------

data "archive_file" "post_confirmation" {
  type        = "zip"
  source_dir  = "${path.module}/../lambdas/post-confirmation"
  output_path = "${path.module}/.terraform-build/post-confirmation.zip"
  excludes    = ["node_modules", ".terraform-build"]
}

data "aws_iam_policy_document" "post_confirmation_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "post_confirmation" {
  name               = "example-agent-${var.env_name}-post-confirmation"
  assume_role_policy = data.aws_iam_policy_document.post_confirmation_assume.json
  description        = "Execution role for the example-agent ${var.env_name} PostConfirmation Lambda — adds confirmed users to the `approved` Cognito group."

  tags = local.default_tags
}

resource "aws_iam_role_policy_attachment" "post_confirmation_basic" {
  role       = aws_iam_role.post_confirmation.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "post_confirmation_inline" {
  # Scope: any user pool in this account+region. We deliberately do NOT
  # reference module.cognito_user_pool.user_pool_arn here — that would
  # create a Terraform-graph cycle (cognito_user_pool needs the Lambda ARN
  # to wire the trigger; the Lambda's IAM policy would then need the pool
  # ARN to scope the action). The cognito_user_pool's resource policy
  # (`aws_lambda_permission.post_confirmation_cognito_invoke`) is what
  # actually constrains who may invoke the Lambda; the action itself is
  # scoped by the Cognito API to the user pool the trigger originates
  # from. The wildcard here is per-region, per-account — not cross-tenant.
  # See https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-iam-roles.html#admin-amgmt-permissions
  statement {
    sid     = "AddUserToApprovedGroup"
    effect  = "Allow"
    actions = ["cognito-idp:AdminAddUserToGroup"]
    resources = [
      "arn:${data.aws_partition.current.partition}:cognito-idp:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:userpool/*",
    ]
  }
}

resource "aws_iam_role_policy" "post_confirmation_inline" {
  name   = "cognito-add-user-to-group"
  role   = aws_iam_role.post_confirmation.id
  policy = data.aws_iam_policy_document.post_confirmation_inline.json
}

resource "aws_cloudwatch_log_group" "post_confirmation" {
  # checkov:skip=CKV_AWS_158:AWS-owned key; per-log-group CMK upgrade is tracked under AWS-1.10.
  # checkov:skip=CKV_AWS_338:7-day retention intentional — Lambda trigger logs are low-volume and long-tail forensics live in CloudTrail.
  name              = "/aws/lambda/example-agent-${var.env_name}-post-confirmation"
  retention_in_days = 7
  tags              = local.default_tags
}

resource "aws_lambda_function" "post_confirmation" {
  # checkov:skip=CKV_AWS_115:Reserved concurrency intentionally unset — Cognito triggers should not throttle signup.
  # checkov:skip=CKV_AWS_116:Cognito triggers are synchronous; failures surface as auth errors, not through a DLQ.
  # checkov:skip=CKV_AWS_117:Function only calls the Cognito control plane; VPC attachment would add NAT cost without security benefit.
  # checkov:skip=CKV_AWS_173:Env vars contain only the group name (non-secret); KMS-encrypting adds operational cost without confidentiality benefit.
  # checkov:skip=CKV_AWS_272:Lambda code-signing is account-level work tracked under AWS-5.x.
  function_name    = "example-agent-${var.env_name}-post-confirmation"
  description      = "Cognito PostConfirmation trigger for the example-agent — adds confirmed users to the `approved` group."
  role             = aws_iam_role.post_confirmation.arn
  runtime          = "nodejs22.x"
  architectures    = ["x86_64"]
  handler          = "index.handler"
  filename         = data.archive_file.post_confirmation.output_path
  source_code_hash = data.archive_file.post_confirmation.output_base64sha256
  memory_size      = 256
  timeout          = 30

  tracing_config {
    mode = "Active"
  }

  environment {
    variables = {
      APPROVED_GROUP_NAME = "approved"
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.post_confirmation,
    aws_iam_role_policy.post_confirmation_inline,
    aws_iam_role_policy_attachment.post_confirmation_basic,
  ]

  tags = local.default_tags
}

resource "aws_lambda_permission" "post_confirmation_cognito_invoke" {
  statement_id  = "AllowCognitoPostConfirm-${var.env_name}"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.post_confirmation.function_name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = module.cognito_user_pool.user_pool_arn
}

###############################################################################
# 4. Secrets Manager — Cognito client secret + Anthropic API key
#
# The Next.js server holds two confidential values: the Cognito App Client
# secret (used for the OAuth code exchange) and the Anthropic API key
# (used by AWS-3.3's tool-use loop). We wrap both via the secrets module
# so the task definition's secrets[] block resolves them at task launch —
# values never reach a tfvars file or a describe-task-definition response.
#
# - cognito-client-secret: seeded from the Cognito module output. Initial
#   value is the live Cognito-issued secret; lifecycle.ignore_changes (in
#   the secrets module) keeps subsequent applies from churning it.
# - anthropic-api-key: created empty (create_initial_version = false).
#   The operator runs `aws secretsmanager put-secret-value` post-apply
#   to seed the actual key. AWS-3.3 verifies it before invoking the loop.
###############################################################################

module "cognito_client_secret" {
  source = "../../../modules/secrets"

  env_name    = var.env_name
  aws_region  = var.aws_region
  secret_name = "example-agent/cognito-client-secret"
  description = "Cognito App Client secret for the example-agent ${var.env_name} backend OAuth code exchange. Sourced from the cognito-user-pool module output at first apply; rotation handled out-of-band by recreating the App Client."

  create_initial_version = true
  initial_value          = module.cognito_user_pool.user_pool_client_secret

  extra_tags = local.default_tags
}

module "anthropic_api_key" {
  source = "../../../modules/secrets"

  env_name    = var.env_name
  aws_region  = var.aws_region
  secret_name = "example-agent/anthropic-api-key"
  description = "Anthropic API key consumed by the example-agent's AWS-3.3 tool-use loop. Created empty; operator seeds the value via `aws secretsmanager put-secret-value` post-apply."

  create_initial_version = false

  extra_tags = local.default_tags
}

###############################################################################
# 5. ECS Service — runs the Next.js standalone container
#
# The ecs-service module wires the task definition, service, autoscaling,
# task IAM role, security group, and (when var.ingress_backend = alb)
# the ALB target group + listener rule. AWS-3.3 will replace the inline
# task_role policy with the ReadOnlyAccess + deny-IAM/Secrets/KMS pair.
###############################################################################

# Task role consumes (a) the SSM allowlist read (still useful for tooling
# inside the agent), (b) the Cognito client secret + Anthropic API key via
# the secrets module's consumer policies, and (c) — passed through —
# the Strata auth-proxy token if the caller wired one.
data "aws_iam_policy_document" "task_role_stub" {
  statement {
    sid       = "AllowSsmGetAllowlist"
    effect    = "Allow"
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.allowlist.arn]
  }

  statement {
    sid       = "AllowKmsDecryptForAllowlist"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
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
      environment = concat(
        [
          { name = "AWS_REGION", value = var.aws_region },
          { name = "COGNITO_USER_POOL_ID", value = module.cognito_user_pool.user_pool_id },
          { name = "COGNITO_CLIENT_ID", value = module.cognito_user_pool.user_pool_client_id },
          { name = "COGNITO_HOSTED_UI_DOMAIN", value = module.cognito_user_pool.hosted_ui_domain },
          { name = "COGNITO_REQUIRED_GROUP", value = "approved" },
          { name = "APP_URL", value = var.app_url },
          { name = "ALLOWLIST_SSM_PATH", value = aws_ssm_parameter.allowlist.name },
        ],
        local.strata_internal_url_effective != "" ? [
          { name = "STRATA_INTERNAL_URL", value = local.strata_internal_url_effective },
        ] : [],
      )
      secrets = concat(
        [
          {
            name       = "COGNITO_CLIENT_SECRET"
            value_from = module.cognito_client_secret.secret_arn
          },
          {
            name       = "ANTHROPIC_API_KEY"
            value_from = module.anthropic_api_key.secret_arn
          },
        ],
        var.strata_auth_proxy_token_secret_arn != "" ? [
          {
            name       = "STRATA_AUTH_PROXY_TOKEN"
            value_from = var.strata_auth_proxy_token_secret_arn
          },
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
    {
      name        = "secret-cognito-client"
      policy_json = module.cognito_client_secret.consumer_iam_policy_json
    },
    {
      name        = "secret-anthropic-api-key"
      policy_json = module.anthropic_api_key.consumer_iam_policy_json
    },
  ]

  # AWS-3.3 will add: arn:aws:iam::aws:policy/ReadOnlyAccess.
  task_role_managed_policy_arns = []

  extra_tags = local.default_tags
}
