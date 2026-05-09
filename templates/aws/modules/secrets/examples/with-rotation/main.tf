###############################################################################
# Example: secret + stub rotation Lambda in the dev account (<ACCOUNT_ID>).
#
# Demonstrates the rotation wiring contract end-to-end:
#   1. A Python 3.12 Lambda is provisioned (the stub returns success without
#      actually rotating anything — this is a wiring contract test, not a
#      working rotator).
#   2. The secrets module attaches the Lambda as the rotator, grants it
#      KMS Decrypt + GenerateDataKey on the per-secret CMK, and writes a
#      resource-based policy on the secret granting the four
#      `secretsmanager:*` actions the rotation contract requires.
#   3. The aws_lambda_permission allowing Secrets Manager to invoke the
#      Lambda is created inside the module.
#
# Run from this directory:
#   aws sts get-caller-identity    # confirm <ACCOUNT_ID>
#   terraform init
#   terraform validate
#
# Apply is intentionally not part of the standard verification step for this
# example (it ties up rotation-schedule slots in the dev account). To test
# end-to-end:
#   terraform plan -out plan.tfplan
#   terraform apply plan.tfplan
#   aws secretsmanager rotate-secret --secret-id "$(terraform output -raw secret_name)"
#   aws logs tail "/aws/lambda/$(terraform output -raw rotator_function_name)" --since 5m
###############################################################################

terraform {
  required_version = "~> 1.7"

  backend "s3" {
    bucket         = "terraform-state-<ACCOUNT_ID>-dev"
    key            = "examples/secrets-with-rotation/terraform.tfstate"
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
# Stub rotator Lambda — Python 3.12. Returns success unconditionally.
#
# This is a CONTRACT TEST. It proves the module's rotation wiring is correct;
# it does not rotate any actual credential. A real rotator implements the
# four-step state machine documented at:
#   https://docs.aws.amazon.com/secretsmanager/latest/userguide/rotating-secrets-lambda-function-overview.html
###############################################################################

data "archive_file" "rotator_zip" {
  type        = "zip"
  output_path = "${path.module}/rotator.zip"

  source {
    filename = "index.py"
    content  = <<-EOT
      """Stub Secrets Manager rotation handler.

      Returns success for any rotation step. Logs the inbound event so we can
      observe the wiring without performing a real rotation.

      A production rotator implements the four-step state machine
      (createSecret, setSecret, testSecret, finishSecret) per the AWS-published
      contract. This stub exists solely to prove the wiring works.
      """

      import json
      import logging

      logger = logging.getLogger()
      logger.setLevel(logging.INFO)


      def lambda_handler(event, context):  # noqa: ARG001
          """Log the rotation event and exit successfully."""
          logger.info("rotation event: %s", json.dumps(event))
          return {"statusCode": 200, "body": "stub rotator — wiring test only"}
    EOT
  }
}

data "aws_iam_policy_document" "rotator_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "rotator" {
  name               = "strata-dev-secrets-stub-rotator-role"
  assume_role_policy = data.aws_iam_policy_document.rotator_assume.json
  description        = "Exec role for the stub rotation Lambda used by examples/with-rotation. Not for production use."

  tags = {
    Project     = "strata"
    Component   = "secrets"
    ManagedBy   = "terraform"
    Environment = "dev"
    Example     = "secrets-with-rotation"
  }
}

# Basic execution permissions (CloudWatch Logs). The actual rotation
# permissions on the secret + KMS are granted BY the secrets module via
# resource-based policies — we don't need to attach them here.
resource "aws_iam_role_policy_attachment" "rotator_basic_exec" {
  role       = aws_iam_role.rotator.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_lambda_function" "rotator" {
  # checkov:skip=CKV_AWS_115:Stub rotator — concurrency limit not material for a contract test.
  # checkov:skip=CKV_AWS_116:Stub rotator — DLQ not material for a no-op handler.
  # checkov:skip=CKV_AWS_117:Stub rotator runs in the AWS-managed Lambda VPC; a private VPC adds nothing for a no-op handler.
  # checkov:skip=CKV_AWS_173:Stub rotator has no env vars to encrypt.
  # checkov:skip=CKV_AWS_272:Stub rotator — code-signing not material for a contract test in dev.
  function_name = "strata-dev-secrets-stub-rotator"
  description   = "Stub Secrets Manager rotation Lambda for the secrets module's with-rotation example. Returns success unconditionally; not a working rotator."
  role          = aws_iam_role.rotator.arn
  handler       = "index.lambda_handler"
  runtime       = "python3.12"
  timeout       = 30

  filename         = data.archive_file.rotator_zip.output_path
  source_code_hash = data.archive_file.rotator_zip.output_base64sha256

  tracing_config {
    mode = "Active"
  }

  tags = {
    Project     = "strata"
    Component   = "secrets"
    ManagedBy   = "terraform"
    Environment = "dev"
    Example     = "secrets-with-rotation"
  }
}

# CloudWatch log group for the rotator. Pre-creating it (rather than letting
# the Lambda service auto-create) lets us control retention.
resource "aws_cloudwatch_log_group" "rotator" {
  # checkov:skip=CKV_AWS_158:Stub rotator log group — using AWS-owned key is acceptable for a wiring-test example. Production rotators in services/* land their log groups in the observability module's CMK pattern.
  # checkov:skip=CKV_AWS_338:Stub rotator example log group — 7-day retention is intentional for a wiring contract test. Production rotators land their logs in the observability module which sets long-tail retention per the workspace policy.
  name              = "/aws/lambda/${aws_lambda_function.rotator.function_name}"
  retention_in_days = 7

  tags = {
    Project     = "strata"
    Component   = "secrets"
    ManagedBy   = "terraform"
    Environment = "dev"
    Example     = "secrets-with-rotation"
  }
}

###############################################################################
# Secret with rotation wired up
###############################################################################

module "rotated_secret" {
  source = "../.."

  env_name    = "dev"
  secret_name = "example-rotated-credential"
  description = "Stub credential rotated by the with-rotation example. The rotator is a no-op — this exists to validate the wiring contract."

  rotation_lambda_arn = aws_lambda_function.rotator.arn
  rotation_days       = 30

  # No initial value — a real rotator writes the first version on its first
  # invocation. The `aurora-postgres` module follows this same pattern.
  create_initial_version = false

  extra_tags = {
    Owner   = "platform"
    Example = "secrets-with-rotation"
  }
}

###############################################################################
# Outputs
###############################################################################

output "secret_arn" {
  value = module.rotated_secret.secret_arn
}

output "secret_name" {
  value = module.rotated_secret.secret_name
}

output "kms_key_arn" {
  value = module.rotated_secret.kms_key_arn
}

output "rotator_function_name" {
  value = aws_lambda_function.rotator.function_name
}

output "rotator_function_arn" {
  value = aws_lambda_function.rotator.arn
}

output "rotation_enabled" {
  value = module.rotated_secret.rotation_enabled
}
