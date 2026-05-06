# redis_storage_high

**Severity:** SEV-2
**Owner team:** platform / observability + finops-analyst
**Dashboard:** `strata-<env>-ops` -> "Redis" row

## What this alarm means

`BytesUsedForCache` exceeded 80% of the provisioned `redis_max_data_storage_bytes` ceiling (10 minutes, 2 evaluation periods, both must breach). Above this point Redis starts evicting entries per the configured maxmemory-policy; eviction shaves cache hit rate and pushes the lost lookups onto Aurora.

## First triage steps (5 min)

1. Open the ops dashboard "Redis" row. Check `Evictions` — if non-zero, the ceiling is already biting and clients are seeing cache misses.
2. Inspect memory composition:
   ```
   redis-cli -h <endpoint> --tls -a "$REDIS_AUTH_TOKEN" INFO memory
   redis-cli -h <endpoint> --tls -a "$REDIS_AUTH_TOKEN" --bigkeys
   ```
3. Pull the configured eviction policy and TTL coverage:
   ```
   redis-cli -h <endpoint> --tls -a "$REDIS_AUTH_TOKEN" CONFIG GET maxmemory-policy
   redis-cli -h <endpoint> --tls -a "$REDIS_AUTH_TOKEN" INFO keyspace
   ```
   `expires` should be a meaningful fraction of `keys` — if 0, no entries have TTL and eviction has nothing principled to remove.

## Common causes

- **Missing TTLs.** A new code path is writing cache entries with `SET` instead of `SETEX`. Mitigation: add TTLs at the call site.
- **Oversized values.** A single key (or class of keys) is multi-MB. `--bigkeys` names it. Mitigation: compress, split, or move to S3.
- **Legitimate growth.** Working set grew. Mitigation: raise `redis_max_data_storage_bytes` via tfvars; coordinate the cost delta with finops-analyst.
- **Pub/sub backlog.** Slow consumers cause channel buffers to balloon. Mitigation: add backpressure or move to Streams.

## Escalation

If `Evictions > 0` for >30 minutes, escalate to the strata service owner — Aurora load is rising as cache misses spike. Coordinate with finops-analyst before raising the storage ceiling.
