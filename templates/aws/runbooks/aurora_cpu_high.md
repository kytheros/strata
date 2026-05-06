# aurora_cpu_high

**Severity:** SEV-2
**Owner team:** platform / observability
**Dashboard:** `strata-<env>-ops` -> "Aurora" row

## What this alarm means

Aurora cluster `CPUUtilization` sustained above 80% for 10 minutes (2 evaluation periods x 5 min, both must breach). Aurora Serverless v2 will scale up ACU in response, but if the workload is CPU-bound on a single query, more ACU helps only marginally. Sustained breach drives p99 latency up across all consumers.

## First triage steps (5 min)

1. Open the ops dashboard "Aurora" row. Compare CPU vs ACU vs connections trend — if all three rise together, traffic is up; if only CPU is up, suspect a hot query.
2. Identify the top CPU consumers right now:
   ```
   psql "$DATABASE_URL" -c "SELECT pid, query, state, EXTRACT(EPOCH FROM (NOW()-query_start)) AS age_sec FROM pg_stat_activity WHERE state='active' ORDER BY query_start LIMIT 20;"
   ```
3. Pull the slow-query leaderboard:
   ```
   psql "$DATABASE_URL" -c "SELECT mean_exec_time, calls, query FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 10;"
   ```
4. Cross-reference `aurora_acu_max` (capacity ceiling) and `alb_p99_latency` (downstream symptom).

## Common causes

- **Slow query regression.** Recently shipped code introduced an unindexed scan or a Cartesian join. pg_stat_statements names it. Mitigation: add the index, fix the query plan, or revert.
- **Statistics drift.** ANALYZE has not run on a hot table. Mitigation: `ANALYZE <table>;`.
- **Vacuum / autovacuum on a large table.** Self-resolves; correlate with `pg_stat_progress_vacuum`.
- **Reporting query in tx pool.** A long analytical query is sharing the OLTP cluster. Mitigation: route reporting to a read replica.

## Escalation

If unresolved after 30 minutes AND `alb_p99_latency` is also firing, escalate to the strata service owner — the latency SLO is breached and is user-visible.
