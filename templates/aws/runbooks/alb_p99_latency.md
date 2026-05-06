# alb_p99_latency

**Severity:** SEV-2
**Owner team:** platform / observability
**Dashboard:** `strata-<env>-slo` -> "Latency" row

## What this alarm means

ALB p99 `TargetResponseTime` exceeded 800 ms over 5-minute periods (3 evaluation periods, 2 must breach). This is a design-SLO breach. p99 covers the slow tail of real client requests; sustained breach means at least 1 percent of users are seeing >800 ms responses, almost always driven by a downstream wait (database, LLM provider, contention) rather than CPU on the task.

## First triage steps (5 min)

1. Open the SLO dashboard "Latency" widget. Compare p50 / p90 / p99 — if only p99 is up, suspect a long-tail dependency (Aurora slow query, LLM API). If all percentiles are up, suspect saturation (CPU, conn pool).
2. Check Aurora pg_stat_statements for slow queries (last hour):
   ```
   psql "$DATABASE_URL" -c "SELECT mean_exec_time, calls, query FROM pg_stat_statements ORDER BY mean_exec_time DESC LIMIT 10;"
   ```
3. Cross-reference `aurora_cpu_high`, `redis_cpu_high`, and any active LLM-provider status pages (Anthropic, OpenAI, Google).
4. Check NLB / target group healthy host count — if hosts are flapping, latency rises while traffic is rerouted.

## Common causes

- **Slow query regression.** A new code path issued an unindexed scan; pg_stat_statements names the culprit. Mitigation: add the index or revert the offending change.
- **LLM provider degradation.** External upstream is the bottleneck. Mitigation: enable provider failover if configured, or accept the breach until upstream recovers.
- **Connection-pool exhaustion.** Strata's pg adapter is starving on Aurora connections. Correlate with Aurora `DatabaseConnections` metric. Mitigation: raise pool size in Strata env vars, or scale out Aurora ACU.
- **Cold start storm.** Recent deploy + autoscale-out — first requests on new tasks are slow. Self-resolves; ignore if deploy is the obvious cause.

## Escalation

If unresolved after 30 minutes and the cause is not a known upstream outage, escalate to the strata service owner. If the cause is Aurora-side (saturated ACU, query-plan regression), loop in finops-analyst before scaling ACU max.
