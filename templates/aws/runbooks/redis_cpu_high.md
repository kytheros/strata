# redis_cpu_high

**Severity:** SEV-2
**Owner team:** platform / observability
**Dashboard:** `strata-<env>-ops` -> "Redis" row

## What this alarm means

ElastiCache `EngineCPUUtilization` sustained above 75% for 10 minutes (2 evaluation periods x 5 min, both must breach). Redis is single-threaded for command processing — sustained engine CPU above ~75% means commands are queueing and tail latencies spike, even if the instance has spare wall-clock CPU.

## First triage steps (5 min)

1. Open the ops dashboard "Redis" row. Compare `EngineCPUUtilization` vs `CurrConnections` vs `CmdPerSec` — if commands per second are up proportionally, it is real traffic; if not, suspect a hot key or expensive command.
2. Connect with the AUTH token and run `redis-cli --bigkeys` against a snapshot endpoint to find oversized keys (do NOT run on prod hot path — use a replica if possible).
3. Pull the slow log:
   ```
   redis-cli -h <endpoint> --tls -a "$REDIS_AUTH_TOKEN" SLOWLOG GET 20
   ```
4. Check recent deploys of Strata or example-agent — any new code path doing per-request `KEYS *` or unbounded `LRANGE`?

## Common causes

- **Hot key.** A single key is being read by every request. Visible in INFO commandstats. Mitigation: cache locally in the application, or shard the key.
- **Expensive command in the hot path.** `KEYS *`, large `SUNIONSTORE`, oversized `MGET`. Slow log names it. Mitigation: rewrite the call site.
- **Connection storm.** Clients are not pooling and are hammering reconnects. Correlate with `NewConnections`. Mitigation: enable client-side pooling.
- **Pub/sub fan-out.** A noisy publisher is driving fan-out cost on a large subscriber set. Mitigation: redesign the channel topology or move to streams.

## Escalation

If unresolved after 30 minutes AND `redis_storage_high` is also firing, escalate to the strata service owner — combined CPU + memory pressure usually means a redesign rather than a knob turn.
