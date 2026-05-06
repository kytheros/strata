# canary_mcp_tools_list

**Severity:** SEV-2
**Owner team:** platform / observability
**Dashboard:** `strata-<env>-ops` (NLB + ECS rows)

## What this alarm means

The synthetic MCP canary failed at least `failure_threshold` times over the last `failure_evaluation_periods x 5` minutes (default: 1 failure per period, 2 of 3 must breach). The canary is an EventBridge-scheduled Lambda (`strata-<env>-mcp-canary`) that exercises the full external-MCP path every 5 minutes:

1. AdminInitiateAuth against the Cognito test-user app client -> access token
2. POST `/mcp` with `tools/list` JSON-RPC and `Authorization: Bearer <token>`
3. Asserts HTTP 200, JSON-RPC parse, non-empty `result.tools`

Any failure logs `CANARY_FAIL stage=<name>` to `/aws/lambda/strata-<env>-mcp-canary`. The metric filter on that prefix increments `Strata/Canary::CanaryFailureCount`, which the alarm watches. Failure means real external MCP clients almost certainly cannot reach Strata.

## First triage steps (5 min)

1. Tail the Lambda log group: `aws logs tail /aws/lambda/strata-<env>-mcp-canary --since 30m --follow`. The `stage=` field tells you exactly where the path broke.
2. Cross-reference the ops dashboard NLB row -- if `HealthyHostCount` is zero, the issue is downstream of the canary (Strata service is down or NLB target group health checks are failing).
3. Check the ingress-authorizer composition outputs and the `strata-<env>-ops` API GW row for a coincident 5XX spike.

## Common causes (by `stage=` field)

- `stage=mint_token` -- Credentials secret empty or invalid. The secret is created empty by Terraform; an operator must seed it via `aws secretsmanager put-secret-value --secret-id <canary_credentials_secret_arn> --secret-string '{"username":"...","password":"..."}'`. Also check that the test user exists in the Cognito user pool and the app client allows ADMIN_USER_PASSWORD_AUTH.
- `stage=tools_list_request` -- Network failure or timeout. Likely API GW or NLB outage; correlate with NLB `UnHealthyHostCount` and the JWT authorizer error rate alarm.
- `stage=status_code` -- Got a non-200 response. Body snippet (first 500 bytes) is in the log line. 401 = JWT/proxy header mismatch; 502/503 = Strata service down.
- `stage=parse_body` -- Strata returned non-JSON. Almost always a 5xx HTML error page from API GW or NLB.
- `stage=tools_array_empty` -- Strata responded but returned no tools. Indicates a Strata-side regression -- check the strata service log group for startup errors.

## Escalation

If unresolved after 30 minutes and the cause is downstream (NLB / ECS / Strata), escalate to the strata service owner. If the cause is canary-internal (credentials, IAM), platform on-call resolves directly.
