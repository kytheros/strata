# alb_5xx_rate

**Severity:** SEV-2
**Owner team:** platform / observability
**Dashboard:** `strata-<env>-slo` -> "ALB request mix" row

## What this alarm means

ALB target 5xx error rate exceeded 1% of total requests over a 5-minute window (3 evaluation periods x 5 min, 2 must breach). Computed from `AWS/ApplicationELB::HTTPCode_Target_5XX_Count / RequestCount * 100`. The metric is "target 5xx" — errors returned by the registered targets (Strata or example-agent), not by the ALB itself. Indicates upstream service errors are reaching real clients.

## First triage steps (5 min)

1. Open the SLO dashboard "ALB request mix" widget. Confirm the 5xx burst is concentrated on one target group (Strata vs example-agent) — that names the owning service.
2. Tail the relevant service log group:
   ```
   aws logs tail /aws/ecs/strata-<env> --since 15m --filter-pattern "ERROR"
   aws logs tail /aws/ecs/example-agent-<env> --since 15m --filter-pattern "ERROR"
   ```
3. Cross-reference the ECS task-shortfall alarm (`strata-<env>-ecs-task-shortfall-*`) — if tasks are crash-looping, fix that first; the 5xx alarm will clear when tasks stabilize.
4. Check recent deploys:
   ```
   aws ecs describe-services --cluster strata-<env> --services strata-<env> example-agent-<env> \
     --query "services[*].{name:serviceName,deployments:deployments[*].{status:status,createdAt:createdAt}}"
   ```

## Common causes

- **Bad deploy.** A new task definition revision is failing on a code path that returns 5xx. Mitigation: roll back via `aws ecs update-service --task-definition <previous-revision>`.
- **Downstream dependency outage.** Aurora unreachable (correlate with `aurora_cpu_high` / connection-saturation), Redis unreachable (correlate with `redis_cpu_high`), or external LLM API down.
- **OOM / task replacement storm.** Tasks are getting killed faster than they spin back up; `RunningTaskCount` dips correlate with the 5xx burst.

## Escalation

If unresolved after 30 minutes and the cause is not a deploy or a known downstream outage, escalate to the strata service owner.
