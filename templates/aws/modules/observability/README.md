# observability

CloudWatch log groups + EMF metric filters + SNS paging topic + the default
strata alarm set + the SLO dashboard. One alarm = one runbook (per the
`observability-sre` agent's principle).

This module is unusual in the strata-aws library: it does **not** consume
upstream module outputs as data sources. It accepts every alarm target as a
string ARN/identifier variable and creates an alarm only when the variable is
non-empty. That keeps the module composable when only some upstream resources
exist (which is the Phase 1 reality on the dev account today: network is
applied, the rest are plan-only).

## What this module owns

- 1 SNS topic (`strata-<env>-alarms`) + its KMS CMK + alias
- N service log groups (caller-declared, default 0)
- N metric filters (caller-declared, default 0)
- Up to 8 alarm groups, depending on which target ARNs are supplied:
  | Alarm | Created when | Threshold |
  |---|---|---|
  | `alb_5xx_rate` | `alb_arn` + `alb_arn_suffix` set | >1% over 5m |
  | `alb_p99_latency` | `alb_arn` + `alb_arn_suffix` set | >800ms over 5m |
  | `ecs_task_shortfall_*` | `ecs_cluster_arn` + `ecs_service_names` set | running < desired |
  | `aurora_acu_max` | `aurora_cluster_arn` + `aurora_cluster_identifier` set | >`aurora_acu_alarm_threshold` |
  | `aurora_cpu_high` | (same) | >80% for 10m |
  | `redis_cpu_high` | `redis_cache_arn` + `redis_cache_name` set | >75% |
  | `redis_storage_high` | (same) | >80% of provisioned bytes |
  | `nat_bytes_out_anomaly_*` | `nat_gateway_ids` non-empty | 3σ anomaly band on `BytesOutToDestination` |
  | `cognito_auth_failure_rate` | `cognito_user_pool_id` set | throttles/successes >5% over 15m |
- 1 SLO dashboard (`strata-<env>-slo`) — degrades gracefully when targets are empty

The two named risks from the design spec are explicitly covered:
- Risk 1 (Cognito → Strata claims drift) → `cognito_auth_failure_rate`
- Risk 3 (NAT bytes-out blowing finops) → `nat_bytes_out_anomaly_*`

## Usage — minimum-viable observability (NAT anomaly only)

```hcl
module "observability" {
  source = "../modules/observability"

  env_name        = "dev"
  nat_gateway_ids = ["nat-026c4d2c535386417", "nat-08b85cf6a561d5728"]

  # No subscribers yet — alarms still create, they just have nowhere to fan out.
  alarm_subscribers = []
}
```

This produces: SNS topic + CMK + 1 NAT anomaly alarm per gateway + the SLO
dashboard (with placeholder widgets for ALB / Aurora / Redis / Cognito).

## Usage — full observability for a fully-deployed env

```hcl
module "observability" {
  source = "../modules/observability"

  env_name = "prod"

  alarm_subscribers = [
    { protocol = "email", endpoint = "oncall@kytheros.dev" },
    { protocol = "https", endpoint = "https://events.pagerduty.com/integration/.../enqueue" },
  ]

  service_log_groups = [
    { name = "/strata/prod/api", retention_days = 30, kms_key_arn = "" },
    { name = "/strata/prod/example-agent", retention_days = 30, kms_key_arn = "" },
  ]

  metric_filters = [
    {
      log_group    = "/strata/prod/api"
      name         = "mcp-tool-call-count"
      pattern      = "{ $.event = \"tool_call\" }"
      namespace    = "Strata/MCP"
      metric_name  = "ToolCallCount"
      metric_value = "1"
      dimensions   = { Tool = "$.tool" }
    },
    {
      log_group    = "/strata/prod/api"
      name         = "mcp-tool-call-duration"
      pattern      = "{ $.event = \"tool_call\" && $.duration_ms = * }"
      namespace    = "Strata/MCP"
      metric_name  = "ToolCallDurationMs"
      metric_value = "$.duration_ms"
      dimensions   = { Tool = "$.tool" }
    },
  ]

  alb_arn                   = module.ingress.alb_arn
  alb_arn_suffix            = module.ingress.alb_arn_suffix
  ecs_cluster_arn           = module.ecs_cluster.cluster_arn
  ecs_cluster_name          = module.ecs_cluster.cluster_name
  ecs_service_names         = ["strata", "example-agent"]
  aurora_cluster_arn        = module.aurora.cluster_arn
  aurora_cluster_identifier = module.aurora.cluster_identifier
  redis_cache_arn           = module.redis.cache_arn
  redis_cache_name          = module.redis.cache_name
  nat_gateway_ids           = module.network.nat_gateway_ids
  cognito_user_pool_id      = module.cognito.user_pool_id
}
```

## EMF metric filter pattern reference

The `pattern` argument uses CloudWatch Logs Filter Pattern Syntax:

- `{ $.event = "tool_call" }` — match JSON log entries where `event` equals `"tool_call"`
- `{ $.duration_ms > 500 }` — numeric comparisons
- `[ts, level=ERROR, ...rest]` — space-delimited log format with field names
- `"ERROR"` — quoted literal substring match

The `dimensions` map keys become CloudWatch dimension names; values are JSON
pointers into the matched event (e.g. `Tool = "$.tool"`). Dimension values
must be string-typed at the JSON pointer.

The `metric_value` can be:
- A constant — `"1"` for counters
- A JSON pointer — `"$.duration_ms"` for gauges (extracted as a number)

## Cost

| Component | Idle $/mo | Notes |
|---|---|---|
| KMS CMK | $1 | $1/key/mo flat |
| SNS topic | $0 | Pay-per-publish; alarms only publish on transitions |
| CloudWatch alarms | $0.10 × N | Standard alarms; anomaly detector alarms are $0.30/metric |
| Anomaly detector | $0.30/metric/mo | One per NAT gateway |
| Dashboard | $0 | First 3 dashboards free |
| Log groups | usage-based | Ingestion + storage; retention controls storage |

Minimum-viable example (NAT anomaly only, 2 gateways): ~$2/mo idle.

## Conventions

- Alarms are gated on `length(...) > 0` so plans succeed against placeholder
  variables before upstream resources exist.
- `treat_missing_data = "notBreaching"` everywhere — portfolio-demo workloads
  cycle, so "no data" is normal, not an alert condition.
- Every alarm description ends with `Runbook: <var.runbook_base_url>/<key>.md`.
  Alarm Terraform key matches the runbook filename slug. Phase 5 builds the
  runbook files at those paths.

## What this module deliberately does NOT do

- Does not page on raw uptime — SLO/error-budget burn rate is a Phase 5
  follow-up that consumes `alarm_arns` to compose burn-rate composite alarms.
- Does not own runbook content. Runbooks live at `runbooks/<alarm-key>.md`
  in the repo root and are linked from `alarm_description`.
- Does not build dashboards for every service. The SLO dashboard is the
  one shared customer-facing surface; per-service drill-down dashboards are
  authored on demand.

## Related modules

- `network` — owns NAT GWs, exports `nat_gateway_ids` consumed here
- `ecs-cluster` — owns the `/ecs/strata-<env>` log group; pass via `cluster_log_group_name` for EMF filter wiring
- `aurora-postgres`, `elasticache-redis`, `ingress`, `cognito-user-pool` — own the targets the alarms watch
