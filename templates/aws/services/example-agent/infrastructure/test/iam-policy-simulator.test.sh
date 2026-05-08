#!/usr/bin/env bash
# iam-policy-simulator.test.sh
#
# CI gate: assert the example-agent task role's deny statements actually
# deny — and that the legitimate ReadOnlyAccess surface is preserved.
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
# Pass criteria:
#   - DENIED:   iam:ListUsers     against any ARN
#   - DENIED:   secretsmanager:GetSecretValue against arn:aws:secretsmanager:::secret:not-ours
#   - DENIED:   kms:DescribeKey   against any ARN
#   - ALLOWED:  ecs:ListServices  (covered by ReadOnlyAccess)
#   - ALLOWED:  rds:DescribeDBClusters
#
# Any deviation prints a diagnostic and exits 1.

set -euo pipefail

ROLE_NAME="${ROLE_NAME:-example-agent-dev-task}"
ACCOUNT_ID="${ACCOUNT_ID:-624990353897}"
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
REGION="${AWS_REGION:-us-east-1}"

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

# Allowed: ReadOnlyAccess surface
simulate "ecs:ListServices" "*" allowed "ecs-list-services-allowed"
simulate "rds:DescribeDBClusters" "*" allowed "rds-describe-allowed"
simulate "ec2:DescribeVpcs" "*" allowed "ec2-describe-vpcs-allowed"
simulate "cloudwatch:DescribeAlarms" "*" allowed "cw-describe-alarms-allowed"

if [[ $fail -ne 0 ]]; then
  echo "iam-policy-simulator: FAILED" >&2
  exit 1
fi
echo "iam-policy-simulator: PASS"
