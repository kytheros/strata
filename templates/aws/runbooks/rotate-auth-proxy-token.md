# rotate-auth-proxy-token

**Severity:** N/A (planned operation)
**Owner team:** platform / observability
**Dashboard:** `strata-<env>-ops` (ECS row + JWT auth-error panel)

## What this runbook covers

Rotation of the `STRATA_AUTH_PROXY_TOKEN` shared sentinel that gates Strata's multi-tenant HTTP transport. The token is owned by `services/ingress-authorizer/main.tf` (`random_password.auth_proxy_token`, 64 chars) and is consumed by:

1. The API GW integration `aws_apigatewayv2_integration.strata_with_header` -- stamped into `request_parameters["overwrite:header.X-Strata-Verified"]` at apply time, read straight from Terraform state.
2. The Strata ECS task definition -- read from Secrets Manager (secret name `ingress/auth-proxy-token`) at task-launch time via the `secrets` block.

Both reads converge on the same `random_password` resource. Rotation re-rolls the resource and re-points both sides at the new value, but the two propagation paths are NOT atomic: Strata picks the new value up only when a task starts, while the API GW integration flips at apply time.

## When to rotate

- Suspected token leak (state-file exposure, IAM-role compromise, log scrub miss).
- Quarterly hygiene rotation in staging / prod.
- Any time an operator with `secretsmanager:GetSecretValue` on the secret left the team.

## Pre-flight (5 min)

1. Confirm the Strata service is healthy and currently running >=2 tasks. From the ops dashboard ECS row OR:
   ```
   aws ecs describe-services --cluster strata-<env> --services strata-<env> \
     --query "services[0].{desired:desiredCount,running:runningCount}"
   ```
   If `desiredCount < 2`, scale to 2 first to prevent a `/mcp` 401 outage during rotation:
   ```
   aws ecs update-service --cluster strata-<env> --service strata-<env> --desired-count 2
   ```
   Wait until `runningCount == 2` before proceeding.
2. Ensure no in-flight Terraform apply is running against this environment.

## Rotation procedure

1. Bump the marker in your tfvars file (or wherever `auth_proxy_token_rotation_marker` is set):
   ```hcl
   auth_proxy_token_rotation_marker = "v2"   # was "v1"
   ```
2. Apply via the canonical orchestrator:
   ```
   task dev:up
   ```
   Plan should show:
   - `random_password.auth_proxy_token` -- forced replacement (keepers changed).
   - `module.auth_proxy_secret.aws_secretsmanager_secret_version.this` -- new version.
   - `aws_apigatewayv2_integration.strata_with_header` -- in-place update of `request_parameters`.
3. After apply completes, the API GW integration is on the new token immediately. Force the Strata service to pick up the new Secrets Manager value by replacing tasks:
   ```
   aws ecs update-service --cluster strata-<env> --service strata-<env> \
     --force-new-deployment
   ```
   ECS will roll tasks one at a time (min healthy = 100% by default with desired=2).

## Verify (5 min)

1. Confirm the API GW integration carries the new value:
   ```
   aws apigatewayv2 get-integration --api-id <apigw_api_id> \
     --integration-id <strata_with_header_id> \
     --query "RequestParameters"
   ```
   The `overwrite:header.X-Strata-Verified` value should match the new token.
2. Confirm the Strata task definition references the same secret ARN (the ARN does NOT change on rotation; only the secret's value does):
   ```
   aws ecs describe-task-definition --task-definition strata-<env> \
     --query "taskDefinition.containerDefinitions[0].secrets"
   ```
3. Watch the JWT auth-error panel for ~5 minutes. A small bump during task replacement is expected and self-resolves once all tasks are on the new revision.

## Mitigation if /mcp starts 401-ing

- If errors persist >5 min after `--force-new-deployment` finishes: roll back by reverting the marker (e.g. `v2 -> v1`) and re-applying. The previous token is regenerated identically because `random_password` is deterministic on the same `keepers`.
- If errors occurred BEFORE step 3 (i.e. between apply and `--force-new-deployment`): you skipped the scale-to-2 pre-flight. The single task was still on the old token while the API GW had flipped. Scale up, retry.

## Escalation

If `/mcp` 401s persist after rollback, escalate to security-compliance (possible state corruption) and to the team that owns the example-agent client.
