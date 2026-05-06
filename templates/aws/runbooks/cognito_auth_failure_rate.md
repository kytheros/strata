# cognito_auth_failure_rate

**Severity:** SEV-2
**Owner team:** platform / observability + security-compliance
**Dashboard:** `strata-<env>-ops` -> "Authentication funnel" row

## What this alarm means

Cognito `SignInThrottles / SignInSuccesses * 100` exceeded 5% over 15 minutes (3 evaluation periods, 2 must breach). Targets design Risk #1 — Cognito-to-Strata claims-shape drift causing repeated auth retries by the client. Distinct from `jwt_auth_error_rate`, which fires at the API GW JWT authorizer (post-token-issue) layer; this fires at the token-issue layer.

## First triage steps (5 min)

1. Open the ops dashboard "Authentication funnel" row. Note the throttle-vs-success ratio over the last hour and whether the spike correlates with a specific user agent or IP.
2. Pull recent Cognito user-pool changes from CloudTrail (claims-shape drift, app-client rotation):
   ```
   aws cloudtrail lookup-events \
     --lookup-attributes AttributeKey=ResourceName,AttributeValue=<user_pool_id> \
     --start-time "$(date -u -d '2 hours ago' +%Y-%m-%dT%H:%M:%SZ)"
   ```
3. Confirm the Cognito service quota for sign-ins has not been hit:
   ```
   aws service-quotas get-service-quota --service-code cognito-idp --quota-code L-9C0CD0F7
   ```
4. Cross-reference `jwt_auth_error_rate` — if both fire together, suspect a server-side rotation; if only this one, suspect a client-side credential storm.

## Common causes

- **Brute force / credential stuffing.** Single IP or narrow CIDR, high `SignInThrottles`. Mitigation: add a WAF rate rule; raise Cognito advanced-security risk threshold.
- **Client retry storm.** A bulk client (canary, agent fleet) re-auths in lockstep on token expiry. Mitigation: jitter the retry, spread the cohort.
- **Claims-shape drift.** A new app-client config dropped a claim Strata expects (e.g. `cognito:groups`). Clients re-auth to refresh; throttle hits. Cross-check the app-client describe output and recent CloudFormation/Terraform applies.
- **Quota ceiling.** Sign-in volume exceeded the regional quota. Mitigation: request a quota increase; in the meantime route via cached refresh tokens where possible.

## Escalation

Brute-force pattern (single source IP, sustained >30 min) = SEV-1 security incident; page security-compliance immediately. Claims-shape drift = coordinate with whoever owns the example-agent / Cognito IaC.
