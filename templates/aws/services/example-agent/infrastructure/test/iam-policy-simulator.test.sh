#!/usr/bin/env bash
# iam-policy-simulator.test.sh
#
# CI gate: assert the example-agent task role's deny statements actually
# deny — and that the legitimate read surface is preserved (now via the
# customer-managed `task_read_scoped` policy, not AWS-managed
# ReadOnlyAccess).
#
# This is a regression check, not a unit test. It simulates the policy
# graph against a deployed role and exits non-zero on any mismatch. To
# wire into CI (AWS-4.1):
#
#   - on PR: assume the cicd-deploy OIDC role, run this against the dev
#     account's `example-agent-dev-task` role.
#   - on tag: same, run against staging + prod task roles.
#
# Local invocation:
#
#   ROLE_NAME=example-agent-dev-task \
#   AWS_PROFILE=default \
#   bash infrastructure/test/iam-policy-simulator.test.sh
#
# Pre-conditions:
#   - the example-agent service is applied (the role exists)
#   - aws CLI v2 is installed
#   - the calling principal has iam:SimulatePrincipalPolicy
#
# Pass criteria (post-AWS-3.3 hardening):
#   - DENIED:   iam:ListUsers                       against any ARN
#   - DENIED:   secretsmanager:GetSecretValue       against unrelated ARN
#   - DENIED:   kms:DescribeKey                     against any ARN
#   - DENIED:   s3:GetBucketEncryption              against unrelated bucket
#                 (was ALLOWED under ReadOnlyAccess)
#   - DENIED:   rds:DescribeDBClusters              against unrelated cluster
#                 (was ALLOWED under ReadOnlyAccess)
#   - DENIED:   ecs:DescribeServices                against unrelated cluster
#                 (was ALLOWED under ReadOnlyAccess)
#   - ALLOWED:  ecs:ListServices                    against strata-{env} cluster
#   - ALLOWED:  rds:DescribeDBClusters              against strata-{env}* cluster
#   - ALLOWED:  ec2:DescribeVpcs                    (no ARN-level scoping
#                                                    — irreducible broad surface)
#   - ALLOWED:  cloudwatch:DescribeAlarms           against strata-{env}-* alarm
#   - ALLOWED:  s3:GetBucketEncryption              against strata-* bucket
#
# Any deviation prints a diagnostic and exits 1.

set -euo pipefail

ROLE_NAME="${ROLE_NAME:-example-agent-dev-task}"
ACCOUNT_ID="${ACCOUNT_ID:-624990353897}"
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
REGION="${AWS_REGION:-us-east-1}"
# Naming pin for ALLOW assertions — must match `strata-${env_name}` in
# main.tf (default cluster/log/aurora prefix). Override via env when
# running against staging or prod.
STRATA_PREFIX="${STRATA_PREFIX:-strata-dev}"

fail=0

simulate() {
  local action="$1"
  local resource="$2"
  local expected="$3"  # allowed | denied
  local label="$4"

  local decision
  decision=$(aws iam simulate-principal-policy \
    --policy-source-arn "$ROLE_ARN" \
    --action-names "$action" \
    --resource-arns "$resource" \
    --region "$REGION" \
    --query 'EvaluationResults[0].EvalDecision' \
    --output text)

  if [[ "$expected" == "denied" && "$decision" != "explicitDeny" && "$decision" != "implicitDeny" ]]; then
    echo "FAIL [$label]: $action on $resource expected DENIED, got $decision" >&2
    fail=1
  elif [[ "$expected" == "allowed" && "$decision" != "allowed" ]]; then
    echo "FAIL [$label]: $action on $resource expected ALLOWED, got $decision" >&2
    fail=1
  else
    echo "PASS [$label]: $action -> $decision"
  fi
}

echo "Simulating policy decisions on $ROLE_ARN"

# Denied: IAM reads
simulate "iam:ListUsers"        "*" denied  "iam-list-users-denied"
simulate "iam:GetRole"          "arn:aws:iam::${ACCOUNT_ID}:role/some-other-role" denied "iam-get-role-denied"
simulate "iam:SimulatePrincipalPolicy" "*" denied "iam-simulate-denied"

# Denied: Secrets Manager reads against arbitrary ARN
simulate "secretsmanager:GetSecretValue" \
  "arn:aws:secretsmanager:us-east-1:${ACCOUNT_ID}:secret:not-ours-AbCdEf" \
  denied "secretsmanager-get-arbitrary-denied"
simulate "secretsmanager:ListSecrets" "*" denied "secretsmanager-list-denied"

# Denied: KMS reads
simulate "kms:DescribeKey" "arn:aws:kms:us-east-1:${ACCOUNT_ID}:key/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" denied "kms-describe-denied"
simulate "kms:GetKeyPolicy" "arn:aws:kms:us-east-1:${ACCOUNT_ID}:key/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" denied "kms-get-policy-denied"
simulate "kms:ListAliases" "*" denied "kms-list-aliases-denied"

# Denied: recon-style queries against unrelated resources (post-hardening).
# These probes were ALLOWED under the prior ReadOnlyAccess attachment;
# they must now resolve DENY because the resource ARN doesn't match
# the strata-${env}* naming pin in `task_read_scoped`.
simulate "s3:GetBucketEncryption" \
  "arn:aws:s3:::unrelated-prod-bucket" \
  denied "s3-get-encryption-unrelated-denied"
simulate "rds:DescribeDBClusters" \
  "arn:aws:rds:${REGION}:${ACCOUNT_ID}:cluster:not-strata-prod" \
  denied "rds-describe-unrelated-denied"
simulate "ecs:DescribeServices" \
  "arn:aws:ecs:${REGION}:${ACCOUNT_ID}:service/not-strata-cluster/foo" \
  denied "ecs-describe-unrelated-denied"
simulate "logs:FilterLogEvents" \
  "arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:/aws/lambda/not-strata-fn" \
  denied "logs-filter-unrelated-denied"

# Allowed: scoped read surface (task_read_scoped policy).
simulate "ecs:ListServices" \
  "arn:aws:ecs:${REGION}:${ACCOUNT_ID}:cluster/${STRATA_PREFIX}" \
  allowed "ecs-list-services-strata-allowed"
simulate "rds:DescribeDBClusters" \
  "arn:aws:rds:${REGION}:${ACCOUNT_ID}:cluster:${STRATA_PREFIX}-aurora" \
  allowed "rds-describe-strata-allowed"
simulate "ec2:DescribeVpcs" "*" allowed "ec2-describe-vpcs-allowed"
simulate "cloudwatch:DescribeAlarms" \
  "arn:aws:cloudwatch:${REGION}:${ACCOUNT_ID}:alarm:${STRATA_PREFIX}-anthropic-spend" \
  allowed "cw-describe-alarms-strata-allowed"
simulate "s3:GetBucketEncryption" \
  "arn:aws:s3:::strata-${STRATA_PREFIX#strata-}-artifacts" \
  allowed "s3-get-encryption-strata-allowed"
simulate "logs:FilterLogEvents" \
  "arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:/ecs/${STRATA_PREFIX}" \
  allowed "logs-filter-strata-allowed"
simulate "ce:GetCostAndUsage" "*" allowed "ce-get-cost-allowed"
simulate "sts:GetCallerIdentity" "*" allowed "sts-whoami-allowed"

if [[ $fail -ne 0 ]]; then
  echo "iam-policy-simulator: FAILED" >&2
  exit 1
fi
echo "iam-policy-simulator: PASS"
