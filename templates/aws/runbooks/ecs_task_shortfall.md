# ecs_task_shortfall

**Severity:** SEV-1
**Owner team:** platform / observability
**Dashboard:** `strata-<env>-ops` -> "ECS services" row

## What this alarm means

`RunningTaskCount` is below `DesiredTaskCount` for the named service for 5+ minutes (3 evaluation periods, 2 must breach). Indicates a task-launch failure: crash loop, image pull failure, capacity provider exhaustion, or AZ outage. If `Running == 0` while `Desired > 0`, the service is fully down; if `Running == Desired - 1`, capacity is degraded but traffic is still served.

## First triage steps (5 min)

1. Open the ops dashboard "ECS services" row. Note which service (`strata-<env>` or `example-agent-<env>`) is degraded — the alarm name carries the service in its suffix.
2. Pull the service event log — this is the canonical signal for ECS launch failures:
   ```
   aws ecs describe-services --cluster strata-<env> --services <service-name> \
     --query "services[0].events[0:10]"
   ```
   Look for: "unable to place task", "image pull failed", "essential container exited".
3. If image pull: check ECR / GHCR availability and the task execution role's `ecr:GetAuthorizationToken` rights.
4. If essential container exited: tail the container's log group:
   ```
   aws logs tail /aws/ecs/<service-name> --since 30m
   ```

## Common causes

- **Crash loop on a bad image.** A new task definition references an image that crashes on boot. Mitigation: roll back to the previous task def revision via `aws ecs update-service --task-definition <previous>`.
- **Capacity provider exhausted.** Fargate Spot interruption + on-demand fallback failing. Check the events log for "Capacity is unavailable". Mitigation: temporarily raise the on-demand weight on the cluster's capacity providers.
- **Image pull 403 / 401.** ECR registry auth expired (rare on managed roles) or GHCR rate-limited. Mitigation: re-apply the task execution role policy; verify the image tag still exists.
- **Health check failing.** Task starts but the container health check times out. Tail the container log; common cause is DB unreachable on first connect. Cross-reference Aurora alarms.

## Escalation

If `Running == 0` for >10 minutes, escalate immediately to the strata service owner AND open an SEV-1 incident. If only one task is missing and traffic is served, SEV-2 is fine; resolve within 30 minutes.
