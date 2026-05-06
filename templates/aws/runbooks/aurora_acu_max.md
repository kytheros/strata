# aurora_acu_max

**Severity:** SEV-2
**Owner team:** platform / observability + finops-analyst
**Dashboard:** `strata-<env>-ops` -> "Aurora" row

## What this alarm means

Aurora Serverless v2 `ServerlessDatabaseCapacity` exceeded the configured threshold (default `aurora_acu_alarm_threshold`, set 2 ACU below the cluster max) for 15 minutes (3 evaluation periods x 5 min, 2 must breach). The cluster is approaching its hard ceiling; sustained breach means queries will start queueing or failing once max is reached.

## First triage steps (5 min)

1. Open the ops dashboard "Aurora" row. Note `ServerlessDatabaseCapacity`, `CPUUtilization`, `DatabaseConnections` — the trio diagnoses the driver of the scale-up.
2. Pull current and recent ACU max:
   ```
   aws rds describe-db-clusters --db-cluster-identifier <aurora_cluster_identifier> \
     --query "DBClusters[0].ServerlessV2ScalingConfiguration"
   ```
3. Check pg_stat_statements for queries that suddenly spiked in volume or mean time:
   ```
   psql "$DATABASE_URL" -c "SELECT calls, mean_exec_time, query FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 10;"
   ```

## Common causes

- **Legitimate traffic growth.** Aurora is doing what it's supposed to. Mitigation: raise `aurora_acu_alarm_threshold` AND `serverless_v2_max_capacity` together via tfvars; coordinate with finops-analyst on the cost delta first.
- **Query-plan regression.** A new code path is doing full-table scans. pg_stat_statements names it. Mitigation: add the index; revert the change if it's the obvious driver.
- **Connection storm.** A misconfigured client is opening connections without pooling. Cross-reference `DatabaseConnections`. Mitigation: cap clients via `pgbouncer` or fix the client-side pool config.
- **Vacuum / autovacuum overhead.** Long-running maintenance task. Self-resolves; ignore unless sustained >1 hour.

## Escalation

If sustained >30 minutes AND `aurora_cpu_high` is also firing, escalate to finops-analyst (cost) and security-compliance (correlated with possible enumeration / abuse). The hard ceiling is enforced by AWS — if you hit it, queries fail, and the service is partially down.
