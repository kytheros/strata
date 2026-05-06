# jwt_auth_error_rate

**Severity:** SEV-2
**Owner team:** platform / observability
**Dashboard:** `strata-<env>-ops` -> "Authentication funnel" row

## What this alarm means

The API Gateway JWT authorizer is rejecting more than `jwt_auth_error_rate_threshold` percent of requests over a 15-minute window (3 evaluation periods x 5 min, 2 must breach). The metric is computed from CloudWatch Logs metric filters on the API GW access log group: `JwtAuthErrorCount / JwtAuthRequestCount * 100`.

A non-zero rate is normal (token expiry, dev clients with stale creds). A sustained spike means one of: client-side misconfig pushing bad tokens at scale, brute-force probing the `/mcp` endpoint, or a server-side change that invalidated outstanding tokens (e.g. Cognito user-pool client rotation, app-client ID drift).

## First triage steps (5 min)

1. Open the ops dashboard widget "JWT authorizer errors (last 1h)" -- the Logs Insights table groups recent rejections by `routeKey`, `status`, `authError`, and `ip`.
2. If a single source IP dominates: likely brute force. Skip to "Common causes -> Brute force".
3. If errors are spread across many IPs: likely a server-side rotation event or a client misconfig push. Check recent deploys of the example-agent / Strata service and any Cognito user-pool changes in CloudTrail.
4. Confirm the metric filter is still attached: `aws logs describe-metric-filters --log-group-name <apigw_log_group_name>`. If the filter is missing the alarm has gone stale -- re-apply Terraform.

## Common causes

- **Cognito app-client rotation.** A new app-client ID was issued and clients are still presenting tokens minted by the old one. The JWT authorizer's `audience` allowlist will reject these. Cross-check `aws cognito-idp describe-user-pool-client` history.
- **Token expiry storm.** A bulk client (canary, agent fleet) restarted mid-token-lifetime and all instances re-auth at once; tokens expire in lockstep an hour later. Spread the cohort.
- **Brute force.** Single IP, high `JwtAuthErrorCount`, status 401 dominates. Add a WAF rate-rule scoped to `/mcp` and the offending IP.
- **Strata-side rejection masquerading as JWT error.** Rare -- API GW `authError` is `null` and Strata returned 401. Check the Strata service log group for `STRATA_REQUIRE_AUTH_PROXY` mismatches.

## Escalation

If unresolved after 30 minutes, escalate to security-compliance (possible credential-stuffing event) and to the team that owns the example-agent (possible client-side regression).
