###############################################################################
# services/canary (AWS-4.1) — Strata MCP synthetic canary.
#
# Why EventBridge + Lambda over CloudWatch Synthetics:
#   - Cost. CloudWatch Synthetics canaries bill ~$0.0017/run; at 5-min cadence
#     that is ~$15/mo per canary, paid 24/7 even when the stack is destroyed.
#     EventBridge + Lambda at the same cadence is well under $0.50/mo at the
#     dev operating cadence (8 hr/wk) and ~$2/mo at 24/7. The dev stack already
#     destroys every evening; tying canary cost to apply state matches that
#     model.
#   - Visibility. Synthetics canaries store screenshots + HAR files in S3, which
#     is overkill for an MCP JSON-RPC probe. Lambda logs land in CloudWatch
#     directly and the metric filter on `CANARY_FAIL` is the canonical signal.
#   - Toggle. `count = var.canary_enabled` lets the stack come up clean when
#     the synthetic check is intentionally off (e.g. during initial bring-up
#     before the test user exists). Synthetics canaries don't have an equally
#     clean disable.
#
# What it exercises:
#   1. Cognito AdminInitiateAuth against the test app client → access token.
#   2. POST /mcp `tools/list` JSON-RPC against the API GW endpoint with the
#      Authorization: Bearer <token> header.
#   3. Validates: HTTP 200, JSON-RPC parse, `result.tools` non-empty, optional
#      `X-Strata-Verified-Echo` response header (warn only).
#
# Failure → Lambda exits non-zero → CloudWatch Logs records `CANARY_FAIL ...`
# → metric filter increments → alarm pages the existing observability SNS
# topic.
###############################################################################

locals {
  default_tags = merge(
    {
      Project     = "strata"
      Component   = "canary"
      Environment = var.env_name
      ManagedBy   = "terraform"
    },
    var.extra_tags,
  )

  enabled          = var.canary_enabled
  function_name    = "strata-${var.env_name}-mcp-canary"
  log_group_name   = "/aws/lambda/${local.function_name}"
  metric_namespace = "Strata/Canary"
}

###############################################################################
# 1. Test-user credentials secret.
#
# Provisioned even when the canary itself is disabled — operators may want to
# stage credentials before flipping the canary on. Created empty; operator
# seeds the JSON `{"username":"...", "password":"..."}` post-apply via
# `aws secretsmanager put-secret-value`. Strata's test-user Cognito app client
# (`var.cognito_user_pool_client_id`) must be configured for
# ADMIN_USER_PASSWORD_AUTH; the orchestrator bootstraps that out-of-band.
###############################################################################

module "credentials_secret" {
  source = "../../modules/secrets"

  env_name    = var.env_name
  aws_region  = var.aws_region
  secret_name = "canary/test-user-credentials"
  description = "Cognito test-user credentials (JSON: {username, password}) used by the Strata MCP synthetic canary. Created empty; operator seeds via `aws secretsmanager put-secret-value`. The test user must exist in the Cognito user pool and be a member of any group required for /mcp access."

  create_initial_version = false

  extra_tags = local.default_tags
}

###############################################################################
# 2. Lambda execution role + policies.
#
# Scope:
#   - cognito-idp:AdminInitiateAuth on the user pool ARN
#   - secretsmanager:GetSecretValue on the credentials secret ARN
#   - kms:Decrypt on the credentials secret CMK (via secretsmanager service)
#   - basic Lambda exec (logs:CreateLogStream + PutLogEvents on the log group)
###############################################################################

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

data "aws_iam_policy_document" "lambda_assume" {
  count = local.enabled ? 1 : 0

  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  count = local.enabled ? 1 : 0

  name               = "${local.function_name}-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume[0].json
  description        = "Execution role for the Strata ${var.env_name} MCP synthetic canary Lambda."

  tags = local.default_tags
}

# CloudWatch Logs basic exec — log group is module-owned (created below) so
# we don't accept the auto-created log group's default 30-day retention; we
# pin it explicitly.
resource "aws_cloudwatch_log_group" "lambda" {
  count = local.enabled ? 1 : 0

  # checkov:skip=CKV_AWS_158:Module uses the AWS-managed CloudWatch Logs key. KMS-CMK upgrade follows the cluster log-group pattern; not a canary-specific concern.
  # checkov:skip=CKV_AWS_338:14-day retention is intentional. The canary emits ~288 lines/day; 14 days of history is enough for incident triage and keeps cost minimal.
  name              = local.log_group_name
  retention_in_days = var.log_retention_days

  tags = local.default_tags
}

data "aws_iam_policy_document" "lambda_inline" {
  count = local.enabled ? 1 : 0

  # Logs: the basic Lambda exec scope, narrowed to this function's log group.
  statement {
    sid    = "WriteOwnLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      "${aws_cloudwatch_log_group.lambda[0].arn}:*",
    ]
  }

  # Cognito: AdminInitiateAuth against the test app client only.
  statement {
    sid       = "MintTestUserToken"
    effect    = "Allow"
    actions   = ["cognito-idp:AdminInitiateAuth"]
    resources = [var.cognito_user_pool_arn]
  }

  # Credentials secret: read AWSCURRENT, plus Decrypt the per-secret CMK
  # via the Secrets Manager backplane.
  statement {
    sid       = "ReadCanaryCredentials"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [module.credentials_secret.secret_arn]
  }

  statement {
    sid       = "DecryptCanaryCredentialsCmk"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [module.credentials_secret.kms_key_arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${var.aws_region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "lambda_inline" {
  count = local.enabled ? 1 : 0

  name   = "canary-inline"
  role   = aws_iam_role.lambda[0].id
  policy = data.aws_iam_policy_document.lambda_inline[0].json
}

###############################################################################
# 3. Lambda function.
#
# Inline ZIP packaged from lambda/index.mjs. No external deps — uses the
# v3 AWS SDK shipped in the Node 22 Lambda runtime and native fetch.
###############################################################################

data "archive_file" "lambda" {
  count = local.enabled ? 1 : 0

  type        = "zip"
  source_file = "${path.module}/lambda/index.mjs"
  output_path = "${path.module}/.terraform-build/canary-lambda.zip"
}

resource "aws_lambda_function" "canary" {
  count = local.enabled ? 1 : 0

  # checkov:skip=CKV_AWS_50:X-Ray active tracing is not enabled for this canary. The function is a single outbound call chain with structured logs that already capture stage-level timing; X-Ray would add cost without surfacing new signal.
  # checkov:skip=CKV_AWS_115:Concurrent execution limits not set. The EventBridge schedule guarantees one invocation per period; concurrency cap is unnecessary.
  # checkov:skip=CKV_AWS_116:Dead-letter queue not configured. The canary's failure surface is the CloudWatch metric filter + alarm; a DLQ would just store the same failure twice.
  # checkov:skip=CKV_AWS_117:VPC attachment not required. The canary calls public Cognito + public API GW endpoints; running it inside the VPC adds NAT egress for both calls without security benefit.
  # checkov:skip=CKV_AWS_173:Environment variables are non-sensitive (region, pool ID, endpoint URL, secret ARN). The credentials themselves come from Secrets Manager at runtime, not from env.
  # checkov:skip=CKV_AWS_272:Code signing not configured. The Lambda source lives in this Terraform module and is built deterministically by archive_file; out-of-band code-signing infra is overkill for a portfolio-tier canary.

  function_name = local.function_name
  description   = "Strata ${var.env_name} MCP synthetic canary. Calls Cognito AdminInitiateAuth + POST /mcp tools/list every ${var.schedule_expression}; CloudWatch Logs metric filter increments on CANARY_FAIL prefix."
  role          = aws_iam_role.lambda[0].arn

  filename         = data.archive_file.lambda[0].output_path
  source_code_hash = data.archive_file.lambda[0].output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]

  memory_size = 256
  timeout     = 30

  environment {
    variables = {
      COGNITO_USER_POOL_ID          = var.cognito_user_pool_id
      COGNITO_CLIENT_ID             = var.cognito_user_pool_client_id
      CANARY_CREDENTIALS_SECRET_ARN = module.credentials_secret.secret_arn
      MCP_ENDPOINT                  = var.mcp_endpoint_url
      REQUEST_TIMEOUT_MS            = tostring(var.request_timeout_ms)
    }
  }

  depends_on = [aws_cloudwatch_log_group.lambda]

  tags = local.default_tags
}

###############################################################################
# 4. EventBridge schedule rule + Lambda target.
#
# rate(5 minutes) hits the API GW endpoint every 5 min while the stack is up.
# When the stack is destroyed (`task dev:down`), this rule and Lambda are
# both deleted — no orphaned canary load against an absent stack.
###############################################################################

resource "aws_cloudwatch_event_rule" "schedule" {
  count = local.enabled ? 1 : 0

  name                = "${local.function_name}-schedule"
  description         = "Periodic invocation of the Strata MCP synthetic canary."
  schedule_expression = var.schedule_expression
  state               = "ENABLED"

  tags = local.default_tags
}

resource "aws_cloudwatch_event_target" "schedule" {
  count = local.enabled ? 1 : 0

  rule      = aws_cloudwatch_event_rule.schedule[0].name
  target_id = "lambda"
  arn       = aws_lambda_function.canary[0].arn
}

resource "aws_lambda_permission" "events_invoke" {
  count = local.enabled ? 1 : 0

  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.canary[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.schedule[0].arn
}

###############################################################################
# 5. Metric filter on CANARY_FAIL log lines + alarm.
#
# The Lambda emits `CANARY_FAIL stage=...` on every failure mode (token mint,
# request timeout, status code, body parse, empty tools array). The metric
# filter pattern matches the literal token at the start of any line; the
# alarm fires on >= var.failure_threshold matches over var.failure_evaluation_periods
# 5-minute periods.
###############################################################################

resource "aws_cloudwatch_log_metric_filter" "failure" {
  count = local.enabled ? 1 : 0

  name           = "${local.function_name}-failure-count"
  log_group_name = aws_cloudwatch_log_group.lambda[0].name
  pattern        = "CANARY_FAIL"

  # NOTE: dimensions and default_value are mutually exclusive on a metric
  # filter (AWS validation: "Invalid metric transformation: dimensions
  # and default value are mutually exclusive properties"). We keep
  # dimensions (the Environment label is what the alarm filters on) and
  # drop default_value. Standard "no match" behavior emits no datapoint;
  # the failure alarm tolerates that via treat_missing_data. Phase 5
  # third-cycle apply finding 2026-05-06.
  metric_transformation {
    name      = "CanaryFailureCount"
    namespace = local.metric_namespace
    value     = "1"
    dimensions = {
      Environment = var.env_name
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "failure" {
  count = local.enabled ? 1 : 0

  alarm_name          = "${local.function_name}-failures"
  alarm_description   = "Strata MCP synthetic canary failed >= ${var.failure_threshold} times over ${var.failure_evaluation_periods * 5} minutes. The canary exercises Cognito mint + POST /mcp tools/list end-to-end; failure means external MCP clients cannot reach Strata. Check the Lambda log group ${local.log_group_name} for stage=... details. Runbook: ${var.runbook_base_url}/canary_mcp_tools_list.md"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = var.failure_evaluation_periods
  datapoints_to_alarm = var.failure_datapoints_to_alarm
  threshold           = var.failure_threshold
  treat_missing_data  = "notBreaching"

  metric_name = "CanaryFailureCount"
  namespace   = local.metric_namespace
  period      = 300
  statistic   = "Sum"

  dimensions = {
    Environment = var.env_name
  }

  alarm_actions = [var.alarm_topic_arn]
  ok_actions    = [var.alarm_topic_arn]

  tags = merge(local.default_tags, {
    Name = "${local.function_name}-failures"
  })
}
