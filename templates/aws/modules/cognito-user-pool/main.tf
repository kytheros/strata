###############################################################################
# strata cognito-user-pool — User Pool + App Client + 5 Groups + 3 Lambda
#                            triggers + optional Google/GitHub federation.
#
# What this module does:
#
#   1. Creates a Cognito User Pool with email-as-username, email verification,
#      MFA optional, advanced security AUDIT (override per env), 12-char
#      password policy, and two custom attributes (tenant_id, role) populated
#      by the PreTokenGeneration Lambda.
#   2. Creates a Hosted UI domain. Default prefix: `strata-{env}-{account_id}`
#      to dodge global-namespace collisions on the cognito-idp/auth domain.
#   3. Creates a single App Client with `code` OAuth flow (no implicit),
#      `email openid profile` scopes, configurable callback/logout URLs,
#      1h ID/access token, 30d refresh token, optional client secret.
#   4. Creates 5 Cognito Groups: owner/admin/member/viewer (Strata RBAC) +
#      `approved` (example-agent access gate).
#   5. Wires 3 Lambda triggers:
#        - PreTokenGeneration: real handler shipped by this module — projects
#          custom:tenant_id, custom:role, and group membership into token
#          claims so backends authorize on a single claim read.
#        - PreSignUp: inert auto-confirm stub by default; consumer overrides
#          via var.pre_signup_lambda_arn (the example-agent replaces it with
#          an allowlist enforcer).
#        - PostConfirmation: inert no-op stub by default; consumer overrides
#          via var.post_confirmation_lambda_arn.
#   6. Optionally creates a Google IdP (when var.google_client_id +
#      var.google_client_secret_arn are both set). The Google client secret
#      is read from Secrets Manager — never accepted as a Terraform variable.
#   7. Optionally creates a GitHub IdP via OIDC, but ONLY when
#      var.github_native_oidc_endpoint is set (a pre-built OIDC bridge URL).
#      GitHub's native OAuth is not OIDC-compliant; see README §"GitHub
#      federation" for the rationale and the path-(b) compromise.
#
# Single-account scaffold variant: this module deploys cleanly into the dev
# account today (624990353897). Federation is opt-in via variables, so a
# greenfield apply succeeds without a Google/GitHub OAuth client.
###############################################################################

locals {
  default_tags = {
    Project     = "strata"
    Component   = "cognito-user-pool"
    ManagedBy   = "terraform"
    Environment = var.env_name
  }

  tags = merge(local.default_tags, var.extra_tags)

  pool_name        = "strata-${var.env_name}"
  app_client_name  = "${var.env_name}-app-client"
  computed_domain  = "strata-${var.env_name}-${data.aws_caller_identity.current.account_id}"
  hosted_ui_domain = var.domain_prefix_override == "" ? local.computed_domain : var.domain_prefix_override

  # Federation gating. Both pieces (id + secret ARN) must be present before
  # we attempt to create the IdP — partial config is a footgun.
  google_enabled = var.google_client_id != "" && var.google_client_secret_arn != ""

  # GitHub federation only when an OIDC bridge endpoint is supplied. See
  # README §"GitHub federation" for why.
  github_enabled = var.github_native_oidc_endpoint != "" && var.github_client_id != "" && var.github_client_secret_arn != ""

  # Trigger ARNs — fall back to the module-shipped inert stubs when the
  # consumer doesn't override.
  # Static-toggle pattern: var.<...>_lambda_provided is the plan-time signal
  # the caller sets when wiring an external Lambda whose ARN is unknown
  # until apply. Falls back to inspecting the ARN string for hard-coded
  # callers. See Phase 5 validation findings.
  pre_signup_external        = var.pre_signup_lambda_provided || var.pre_signup_lambda_arn != ""
  post_confirmation_external = var.post_confirmation_lambda_provided || var.post_confirmation_lambda_arn != ""

  pre_signup_arn        = local.pre_signup_external ? var.pre_signup_lambda_arn : aws_lambda_function.pre_signup_stub.arn
  post_confirmation_arn = local.post_confirmation_external ? var.post_confirmation_lambda_arn : aws_lambda_function.post_confirmation_stub.arn

  # Identity providers attached to the App Client. COGNITO is always present;
  # Google/GitHub only when their gating vars are set.
  identity_providers = compact([
    "COGNITO",
    local.google_enabled ? "Google" : "",
    local.github_enabled ? "GitHub" : "",
  ])
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

###############################################################################
# 1. Lambda packaging — three handler stubs (pre-token-generation is real,
#    the other two are inert by default).
###############################################################################

data "archive_file" "pre_token_generation" {
  type        = "zip"
  source_dir  = "${path.module}/lambdas/pre-token-generation"
  output_path = "${path.module}/lambdas/pre-token-generation.zip"
}

data "archive_file" "pre_signup_stub" {
  type        = "zip"
  source_dir  = "${path.module}/lambdas/pre-signup"
  output_path = "${path.module}/lambdas/pre-signup.zip"
}

data "archive_file" "post_confirmation_stub" {
  type        = "zip"
  source_dir  = "${path.module}/lambdas/post-confirmation"
  output_path = "${path.module}/lambdas/post-confirmation.zip"
}

###############################################################################
# 2. Lambda exec roles. Each trigger gets its own role so blast radius scopes
#    cleanly to its log group. CloudWatch Logs is the only IAM grant any of
#    these need (the PreTokenGeneration handler is pure event manipulation;
#    PreSignUp/PostConfirmation stubs are pass-throughs).
###############################################################################

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# --- pre-token-generation role + log group + policy ---

resource "aws_cloudwatch_log_group" "pre_token_generation" {
  # checkov:skip=CKV_AWS_158:Log group uses the AWS-owned CloudWatch Logs key. KMS-CMK is added in AWS-1.10 (observability) where the key lifecycle is owned.
  # checkov:skip=CKV_AWS_338:7-day retention is intentional for Lambda trigger logs — Cognito invocation rate is low and long-tail forensics live in CloudTrail.
  name              = "/aws/lambda/strata-${var.env_name}-pre-token-generation"
  retention_in_days = 7

  tags = local.tags
}

resource "aws_iam_role" "pre_token_generation" {
  name               = "strata-${var.env_name}-pre-token-generation-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  description        = "Exec role for the Cognito PreTokenGeneration Lambda. Scoped to its own log group."

  tags = local.tags
}

data "aws_iam_policy_document" "pre_token_generation" {
  statement {
    sid    = "WriteOwnLogs"
    effect = "Allow"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]

    resources = ["${aws_cloudwatch_log_group.pre_token_generation.arn}:*"]
  }

  # X-Ray tracing (mode = Active on the function). PutTraceSegments and
  # PutTelemetryRecords don't support resource-level conditions in IAM —
  # AWS-published limitation; * is the tightest scope available here.
  statement {
    sid    = "WriteXRayTraces"
    effect = "Allow"

    actions = [
      "xray:PutTraceSegments",
      "xray:PutTelemetryRecords",
    ]

    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "pre_token_generation" {
  name   = "logs"
  role   = aws_iam_role.pre_token_generation.id
  policy = data.aws_iam_policy_document.pre_token_generation.json
}

# --- pre-signup stub role + log group + policy ---

resource "aws_cloudwatch_log_group" "pre_signup_stub" {
  # checkov:skip=CKV_AWS_158:AWS-owned key; CMK upgrade tracked under AWS-1.10.
  # checkov:skip=CKV_AWS_338:7-day retention intentional — stub Lambda emits no business logs.
  name              = "/aws/lambda/strata-${var.env_name}-pre-signup-stub"
  retention_in_days = 7

  tags = local.tags
}

resource "aws_iam_role" "pre_signup_stub" {
  name               = "strata-${var.env_name}-pre-signup-stub-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  description        = "Exec role for the inert PreSignUp stub Lambda."

  tags = local.tags
}

data "aws_iam_policy_document" "pre_signup_stub" {
  statement {
    sid       = "WriteOwnLogs"
    effect    = "Allow"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.pre_signup_stub.arn}:*"]
  }

  statement {
    sid       = "WriteXRayTraces"
    effect    = "Allow"
    actions   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "pre_signup_stub" {
  name   = "logs"
  role   = aws_iam_role.pre_signup_stub.id
  policy = data.aws_iam_policy_document.pre_signup_stub.json
}

# --- post-confirmation stub role + log group + policy ---

resource "aws_cloudwatch_log_group" "post_confirmation_stub" {
  # checkov:skip=CKV_AWS_158:AWS-owned key; CMK upgrade tracked under AWS-1.10.
  # checkov:skip=CKV_AWS_338:7-day retention intentional — stub Lambda emits no business logs.
  name              = "/aws/lambda/strata-${var.env_name}-post-confirmation-stub"
  retention_in_days = 7

  tags = local.tags
}

resource "aws_iam_role" "post_confirmation_stub" {
  name               = "strata-${var.env_name}-post-confirmation-stub-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  description        = "Exec role for the inert PostConfirmation stub Lambda."

  tags = local.tags
}

data "aws_iam_policy_document" "post_confirmation_stub" {
  statement {
    sid       = "WriteOwnLogs"
    effect    = "Allow"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.post_confirmation_stub.arn}:*"]
  }

  statement {
    sid       = "WriteXRayTraces"
    effect    = "Allow"
    actions   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "post_confirmation_stub" {
  name   = "logs"
  role   = aws_iam_role.post_confirmation_stub.id
  policy = data.aws_iam_policy_document.post_confirmation_stub.json
}

###############################################################################
# 3. Lambda functions
###############################################################################

resource "aws_lambda_function" "pre_token_generation" {
  # checkov:skip=CKV_AWS_115:Reserved concurrency intentionally unset — Cognito-trigger Lambdas should scale with auth volume, not a fixed pool.
  # checkov:skip=CKV_AWS_116:DLQ unnecessary for synchronous Cognito triggers — failure surfaces directly to the caller as an auth error.
  # checkov:skip=CKV_AWS_117:Function does not need VPC attachment — Cognito events arrive via the AWS service backplane and the handler is pure event manipulation.
  # checkov:skip=CKV_AWS_173:No env vars are set on this function (no secret material to encrypt).
  # checkov:skip=CKV_AWS_272:Lambda code-signing config is account-level work tracked under AWS-5.x (security polish phase).
  function_name = "strata-${var.env_name}-pre-token-generation"
  description   = "Projects custom:tenant_id, custom:role, and cognito:groups into Cognito access/id token claims (v2 trigger event)."
  role          = aws_iam_role.pre_token_generation.arn
  handler       = "index.handler"
  runtime       = "nodejs22.x"
  architectures = ["x86_64"]
  timeout       = 30
  memory_size   = 256

  filename         = data.archive_file.pre_token_generation.output_path
  source_code_hash = data.archive_file.pre_token_generation.output_base64sha256

  tracing_config {
    mode = "Active"
  }

  tags = local.tags

  depends_on = [
    aws_cloudwatch_log_group.pre_token_generation,
    aws_iam_role_policy.pre_token_generation,
  ]
}

resource "aws_lambda_function" "pre_signup_stub" {
  # checkov:skip=CKV_AWS_115:See pre_token_generation.
  # checkov:skip=CKV_AWS_116:See pre_token_generation.
  # checkov:skip=CKV_AWS_117:See pre_token_generation.
  # checkov:skip=CKV_AWS_173:No env vars.
  # checkov:skip=CKV_AWS_272:See pre_token_generation.
  function_name = "strata-${var.env_name}-pre-signup-stub"
  description   = "Inert PreSignUp stub. Auto-confirms signups. Replaced by the example-agent allowlist enforcer once that service deploys."
  role          = aws_iam_role.pre_signup_stub.arn
  handler       = "index.handler"
  runtime       = "nodejs22.x"
  architectures = ["x86_64"]
  timeout       = 30
  memory_size   = 256

  filename         = data.archive_file.pre_signup_stub.output_path
  source_code_hash = data.archive_file.pre_signup_stub.output_base64sha256

  tracing_config {
    mode = "Active"
  }

  tags = local.tags

  depends_on = [
    aws_cloudwatch_log_group.pre_signup_stub,
    aws_iam_role_policy.pre_signup_stub,
  ]
}

resource "aws_lambda_function" "post_confirmation_stub" {
  # checkov:skip=CKV_AWS_115:See pre_token_generation.
  # checkov:skip=CKV_AWS_116:See pre_token_generation.
  # checkov:skip=CKV_AWS_117:See pre_token_generation.
  # checkov:skip=CKV_AWS_173:No env vars.
  # checkov:skip=CKV_AWS_272:See pre_token_generation.
  function_name = "strata-${var.env_name}-post-confirmation-stub"
  description   = "Inert PostConfirmation stub. Replaced by the example-agent group-assigner once that service deploys."
  role          = aws_iam_role.post_confirmation_stub.arn
  handler       = "index.handler"
  runtime       = "nodejs22.x"
  architectures = ["x86_64"]
  timeout       = 30
  memory_size   = 256

  filename         = data.archive_file.post_confirmation_stub.output_path
  source_code_hash = data.archive_file.post_confirmation_stub.output_base64sha256

  tracing_config {
    mode = "Active"
  }

  tags = local.tags

  depends_on = [
    aws_cloudwatch_log_group.post_confirmation_stub,
    aws_iam_role_policy.post_confirmation_stub,
  ]
}

###############################################################################
# 4. Cognito User Pool
#
# Email-only. Email-as-username, case-insensitive. Custom attributes
# (tenant_id, role) are populated by PreTokenGeneration — NOT user-editable
# (the App Client write_attributes does not include them).
###############################################################################

resource "aws_cognito_user_pool" "this" {
  # checkov:skip=CKV_AWS_363:User pool is auth-only; SES integration is added in Phase 3 once the example-agent service is wired. AWS default email sending is acceptable for dev volume.
  name = local.pool_name

  # Email-as-username, case-insensitive.
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  username_configuration {
    case_sensitive = false
  }

  password_policy {
    minimum_length                   = var.password_minimum_length
    require_uppercase                = true
    require_lowercase                = true
    require_numbers                  = true
    require_symbols                  = true
    temporary_password_validity_days = 1
    # password_history_size requires the Plus tier; not setting it explicitly
    # so the user pool stays on the Essentials tier by default. See README
    # §"Cost / Cognito Plus tier" for the trade-off.
  }

  mfa_configuration = var.mfa_configuration

  # When MFA is anything other than OFF, software_token_mfa_configuration
  # gates whether TOTP apps are allowed. We always permit TOTP — SMS MFA is
  # avoided per Strata's no-PII-by-default posture.
  dynamic "software_token_mfa_configuration" {
    for_each = var.mfa_configuration == "OFF" ? [] : [1]
    content {
      enabled = true
    }
  }

  # Advanced security mode. AUDIT in dev, ENFORCED in prod (override via
  # var.advanced_security_mode). When AUDIT/ENFORCED, this enables the Plus
  # tier billing line — see README.
  user_pool_add_ons {
    advanced_security_mode = var.advanced_security_mode
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  # Email schema attribute is required by Cognito. The tenant_id and role
  # custom attributes are populated by PreTokenGeneration — they are NOT
  # user-editable (App Client write_attributes excludes them below).
  schema {
    name                     = "email"
    attribute_data_type      = "String"
    mutable                  = true
    required                 = true
    developer_only_attribute = false

    string_attribute_constraints {
      min_length = 1
      max_length = 256
    }
  }

  schema {
    name                     = "tenant_id"
    attribute_data_type      = "String"
    mutable                  = true
    required                 = false
    developer_only_attribute = false

    string_attribute_constraints {
      min_length = 0
      max_length = 36
    }
  }

  schema {
    name                     = "role"
    attribute_data_type      = "String"
    mutable                  = true
    required                 = false
    developer_only_attribute = false

    string_attribute_constraints {
      min_length = 0
      max_length = 32
    }
  }

  verification_message_template {
    default_email_option = "CONFIRM_WITH_CODE"
    email_subject        = "Your Strata verification code"
    email_message        = "Your Strata ({env}) verification code is {####}"
  }

  lambda_config {
    pre_token_generation_config {
      lambda_arn     = aws_lambda_function.pre_token_generation.arn
      lambda_version = "V2_0"
    }
    pre_sign_up       = local.pre_signup_arn
    post_confirmation = local.post_confirmation_arn
  }

  deletion_protection = var.deletion_protection

  tags = merge(local.tags, {
    Name = local.pool_name
  })

  # The PreTokenGeneration v2 lambda_version + custom attribute schema are
  # immutable by Cognito — Terraform cannot in-place edit them. Force-replace
  # protection is provided by var.deletion_protection in prod.
  lifecycle {
    create_before_destroy = false
  }
}

###############################################################################
# 5. Lambda permissions for Cognito to invoke each trigger
###############################################################################

resource "aws_lambda_permission" "pre_token_generation_invoke" {
  statement_id  = "AllowCognitoPreTokenGen-${var.env_name}"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.pre_token_generation.function_name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = aws_cognito_user_pool.this.arn
}

resource "aws_lambda_permission" "pre_signup_stub_invoke" {
  count = local.pre_signup_external ? 0 : 1

  statement_id  = "AllowCognitoPreSignUpStub-${var.env_name}"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.pre_signup_stub.function_name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = aws_cognito_user_pool.this.arn
}

resource "aws_lambda_permission" "post_confirmation_stub_invoke" {
  count = local.post_confirmation_external ? 0 : 1

  statement_id  = "AllowCognitoPostConfirmStub-${var.env_name}"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.post_confirmation_stub.function_name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = aws_cognito_user_pool.this.arn
}

###############################################################################
# 6. Federation IdPs (conditional)
#
# Google: client_secret pulled from Secrets Manager — never accepted as a TF
# variable. The data source reads the AWSCURRENT version at plan time.
#
# GitHub: skipped unless var.github_native_oidc_endpoint is set. GitHub's
# native OAuth2 isn't OIDC-compliant; running it through an OIDC bridge URL
# (Lambda@Edge or similar) lets us keep this module purely declarative
# without hand-rolling an OIDC discovery layer here.
###############################################################################

data "aws_secretsmanager_secret_version" "google_client_secret" {
  count     = local.google_enabled ? 1 : 0
  secret_id = var.google_client_secret_arn
}

resource "aws_cognito_identity_provider" "google" {
  count = local.google_enabled ? 1 : 0

  user_pool_id  = aws_cognito_user_pool.this.id
  provider_name = "Google"
  provider_type = "Google"

  provider_details = {
    authorize_scopes = "openid email profile"
    client_id        = var.google_client_id
    client_secret    = data.aws_secretsmanager_secret_version.google_client_secret[0].secret_string
  }

  attribute_mapping = {
    email          = "email"
    email_verified = "email_verified"
    name           = "name"
    picture        = "picture"
    username       = "sub"
  }
}

data "aws_secretsmanager_secret_version" "github_client_secret" {
  count     = local.github_enabled ? 1 : 0
  secret_id = var.github_client_secret_arn
}

resource "aws_cognito_identity_provider" "github" {
  count = local.github_enabled ? 1 : 0

  user_pool_id  = aws_cognito_user_pool.this.id
  provider_name = "GitHub"
  provider_type = "OIDC"

  provider_details = {
    authorize_scopes          = "openid email profile"
    client_id                 = var.github_client_id
    client_secret             = data.aws_secretsmanager_secret_version.github_client_secret[0].secret_string
    attributes_request_method = "GET"
    oidc_issuer               = var.github_native_oidc_endpoint
  }

  attribute_mapping = {
    email          = "email"
    email_verified = "email_verified"
    name           = "name"
    username       = "sub"
  }
}

###############################################################################
# 7. Hosted UI domain
#
# Cognito Hosted UI domain prefixes share a single global namespace per region
# — collisions are real. Default is `strata-{env}-{account_id}`. Operators
# wanting a custom domain (ACM cert flow) override via var.domain_prefix_override
# and wire `aws_cognito_user_pool_domain.custom_domain` themselves at the
# service layer.
###############################################################################

resource "aws_cognito_user_pool_domain" "this" {
  domain       = local.hosted_ui_domain
  user_pool_id = aws_cognito_user_pool.this.id
}

###############################################################################
# 8. App Client — backend (confidential by default)
###############################################################################

resource "aws_cognito_user_pool_client" "this" {
  name         = local.app_client_name
  user_pool_id = aws_cognito_user_pool.this.id

  generate_secret = var.generate_client_secret

  # OAuth2 surface — code flow only. No implicit (deprecated, leaks tokens via
  # URL fragment) and no client_credentials (no machine-to-machine surface in v1).
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_scopes                 = ["email", "openid", "profile"]

  callback_urls = var.callback_urls
  logout_urls   = var.logout_urls

  supported_identity_providers = local.identity_providers

  # Token TTLs: 1h ID/access, 30d refresh. Matches the existing Supabase path.
  id_token_validity      = 1
  access_token_validity  = 1
  refresh_token_validity = 30

  token_validity_units {
    id_token      = "hours"
    access_token  = "hours"
    refresh_token = "days"
  }

  # Read attributes: standard email + custom tenant_id/role so backends that
  # call AdminGetUser see them. Write attributes: empty for the customs —
  # they are PreTokenGeneration-injected only, never user-editable.
  read_attributes = [
    "email",
    "email_verified",
    "name",
    "picture",
    "custom:tenant_id",
    "custom:role",
  ]

  write_attributes = [
    "email",
    "name",
  ]

  # Authentication flows. ALLOW_USER_SRP_AUTH for password sign-in (when not
  # federated) and ALLOW_REFRESH_TOKEN_AUTH for refresh. ALLOW_USER_PASSWORD_AUTH
  # is intentionally omitted — it's the legacy plain-password flow and SRP
  # supersedes it. ALLOW_CUSTOM_AUTH is also omitted (no custom auth Lambda).
  explicit_auth_flows = [
    "ALLOW_USER_SRP_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  # Security best practice — Cognito returns the same generic error for
  # "user does not exist" as for "wrong password", preventing user-enumeration.
  prevent_user_existence_errors = "ENABLED"

  enable_token_revocation = true

  depends_on = [
    aws_cognito_identity_provider.google,
    aws_cognito_identity_provider.github,
  ]
}

###############################################################################
# 8b. App Client — test user (machine-only, ADMIN_USER_PASSWORD_AUTH)
#
# Optional. Provisions a second app client used by synthetic canaries to
# authenticate a known test user via `AdminInitiateAuth(ADMIN_USER_PASSWORD_AUTH)`.
# Disabled by default. Configured to be unusable from a browser:
#   - No OAuth flows
#   - No callback / logout URLs
#   - No client secret (Admin* APIs do not require it)
#   - explicit_auth_flows: ADMIN_USER_PASSWORD_AUTH + REFRESH_TOKEN_AUTH only
#
# The caller IAM role must hold `cognito-idp:AdminInitiateAuth` against the
# user pool ARN — see services/canary for the policy attachment pattern.
###############################################################################

resource "aws_cognito_user_pool_client" "test_user" {
  count = var.enable_test_user_client ? 1 : 0

  name         = "${local.app_client_name}-test-user"
  user_pool_id = aws_cognito_user_pool.this.id

  generate_secret = false

  allowed_oauth_flows_user_pool_client = false

  read_attributes  = ["email", "email_verified"]
  write_attributes = []

  explicit_auth_flows = [
    "ALLOW_ADMIN_USER_PASSWORD_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true

  id_token_validity      = 1
  access_token_validity  = 1
  refresh_token_validity = 30

  token_validity_units {
    id_token      = "hours"
    access_token  = "hours"
    refresh_token = "days"
  }
}

###############################################################################
# 9. Cognito Groups (5 total)
#
# owner/admin/member/viewer  → Strata 4-role RBAC (precedence 0–3)
# approved                   → example-agent access gate (precedence 10)
###############################################################################

resource "aws_cognito_user_group" "owner" {
  name         = "owner"
  user_pool_id = aws_cognito_user_pool.this.id
  description  = "Strata RBAC: full owner. Tenant administration, billing, member management."
  precedence   = 0
}

resource "aws_cognito_user_group" "admin" {
  name         = "admin"
  user_pool_id = aws_cognito_user_pool.this.id
  description  = "Strata RBAC: tenant admin. All tenant operations except billing/ownership transfer."
  precedence   = 1
}

resource "aws_cognito_user_group" "member" {
  name         = "member"
  user_pool_id = aws_cognito_user_pool.this.id
  description  = "Strata RBAC: tenant member. Read/write knowledge, run agent loops, no admin surface."
  precedence   = 2
}

resource "aws_cognito_user_group" "viewer" {
  name         = "viewer"
  user_pool_id = aws_cognito_user_pool.this.id
  description  = "Strata RBAC: read-only. Search and view knowledge, no write surface."
  precedence   = 3
}

resource "aws_cognito_user_group" "approved" {
  name         = "approved"
  user_pool_id = aws_cognito_user_pool.this.id
  description  = "Example-agent access gate. PostConfirmation Lambda assigns this group to allowlisted federated users; backend middleware requires this claim before serving any request."
  precedence   = 10
}
