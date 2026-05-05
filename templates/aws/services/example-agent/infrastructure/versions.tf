terraform {
  required_version = "~> 1.7"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    # archive provider packages the Lambda source directories into the .zip
    # files that aws_lambda_function consumes. Pinned to ~> 2.4.
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }
}
