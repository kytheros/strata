# `aws/modules/ecs-service` — Fargate task + service + autoscaling + LB/APIGW attach

**Tool choice: Terraform (OpenTofu compatible).** Reason: matches the rest of the AWS deploy template; the workhorse module is consumed by every Strata-on-AWS service (Strata in Phase 2, example-agent in Phase 3, future services). One `terraform plan` covers a service end-to-end.

## What this creates

The reusable building block for any ECS Fargate service in this stack. Designed so consumers configure shape (CPU/memory, containers, env), wiring (cluster, network, ingress), and integrations (Aurora/Redis policies via `task_role_inline_policies`), and get a complete service back — task definition, IAM, security group, optional LB/APIGW attachment, autoscaling — without writing any of those resources directly.

| Resource | Count | Notes |
|---|---|---|
| ECS task definition | 1 | Family `<service>-<env>`. `awsvpc` networking, FARGATE-only, runtime platform variable. Container definitions rendered from `var.containers`. Revision bumps on any task-shape change. |
| ECS service | 1 | Capacity provider strategy default 80% Spot / 20% on-demand. Deployment circuit breaker on with rollback (non-negotiable). ECS Exec on by default. `propagate_tags = TASK_DEFINITION`. `desired_count` ignored after first apply (autoscaler owns it). |
| IAM task role | 1 | Trust: `ecs-tasks.amazonaws.com`. Inline policies via `var.task_role_inline_policies` (the integration point for Aurora/Redis/secrets `consumer_iam_policy_json`). Managed policies via `var.task_role_managed_policy_arns`. |
| Security group | 1 | Ingress: from caller-supplied SGs on the container port. Egress: all TCP to VPC CIDR; 443 to allowed CIDRs (default 0.0.0.0/0). Plus per-peer egress rules when `allowed_egress_security_group_ids` is supplied. |
| ALB target group + listener rule | 0 or 1 each | Created only when `var.attach_to_alb_listener_arn != ""`. Target type `ip` (Fargate requirement). Health check on `var.health_check_path`. `create_before_destroy` on the TG so health-check changes don't cause downtime. |
| API GW HTTP_PROXY integration | 0 or 1 | Created only when `var.attach_to_apigw_vpc_link_id != ""`. v1 stub: caller supplies `apigw_integration_uri` (private NLB or Service Connect endpoint). Routes are caller-attached. |
| App Auto Scaling target + policies | 1 + 1-2 | CPU target tracking always; ALBRequestCountPerTarget target tracking only when LB-attached. |

All resources tagged with `Project=strata`, `Component=ecs-service`, `ManagedBy=terraform`, `Environment={env_name}`, `Service={service_name}`.

## LB-attachment branching

The module has three mutually-non-exclusive ingress modes:

1. **ALB attachment** (`var.attach_to_alb_listener_arn != ""`): emit a target group + listener rule, attach the LB block to the service, and add an `ALBRequestCountPerTarget` autoscaling policy on top of the always-on CPU policy.
2. **API GW attachment** (`var.attach_to_apigw_vpc_link_id != ""`): emit an `HTTP_PROXY` integration the caller's `aws_apigatewayv2_route` resources reference. No target group; the caller supplies the backend URI directly (typically a private NLB or Service Connect endpoint).
3. **Internal-only** (both empty): no LB/APIGW resources. The service is reachable only via Service Connect (when enabled) or via direct SG-to-SG ingress from `var.ingress_security_group_ids`.

ALB and API GW are non-exclusive at the variable level (you *can* set both), but in practice services pick one — the dev environment uses API GW, staging/prod use ALB, per spec §"Dev tier: API GW HTTP API; staging/prod: ALB."

## Wiring the execution role

ECS distinguishes two roles:

- **Execution role** — assumed by the ECS *agent* (not your container) to pull images from ECR, write the initial log stream, and resolve `secrets` references at task-launch time. Typically a thin role with `AmazonECSTaskExecutionRolePolicy` plus narrow secret reads.
- **Task role** — assumed by your *running container* via the task metadata service. This is where Aurora/Redis/S3/etc. permissions live. **The module owns this role**; the caller injects permissions via `var.task_role_inline_policies` and `var.task_role_managed_policy_arns`.

The cluster module's `exec_role_arn` output is the *operator* role (for `aws ecs execute-command`), not the task execution role. Pass an explicit execution-role ARN here — most envs create a single shared one alongside the cluster.

## Aurora + Redis integration pattern

Both `aurora-postgres` and `elasticache-redis` emit a `consumer_iam_policy_json` output. Pass these directly into `task_role_inline_policies`:

```hcl
module "ecs_service" {
  source = "../../modules/ecs-service"
  # ...

  # Static-labels-list pattern: the *_names list is what `for_each`
  # iterates (plan-time-known); the map is looked up by name inside the
  # resource body. Required because Terraform marks a map as "known after
  # apply" when any value is unknown — even if the keys are static.
  task_role_inline_policy_names = ["aurora-secret-access", "redis-auth-secret-access"]
  task_role_inline_policies = {
    aurora-secret-access     = module.aurora.consumer_iam_policy_json
    redis-auth-secret-access = module.redis.auth_secret_consumer_iam_policy_json
  }

  # Same pattern for egress SGs.
  allowed_egress_security_group_labels = ["aurora", "redis"]
  allowed_egress_security_group_ids = {
    aurora = module.aurora.security_group_id
    redis  = module.redis.security_group_id
  }
}
```

Then *inside* Aurora and Redis, scope ingress back to this service:

```hcl
module "aurora" {
  # ...
  allowed_security_group_ids = [module.ecs_service.security_group_id]
}
```

Both sides of the SG handshake are explicit — Strata's review pattern.

## API GW VPC-link integration

Per spec, v1 ships a stub for API-GW-fronted services: the consumer supplies a backend URI (private NLB or Service Connect endpoint) and the module creates an `HTTP_PROXY` integration. Routes are attached by the caller:

```hcl
resource "aws_apigatewayv2_route" "mcp" {
  api_id    = module.ingress.api_id
  route_key = "ANY /mcp/{proxy+}"
  target    = "integrations/${module.ecs_service.apigw_integration_id}"
}
```

The integration uses `connection_type = VPC_LINK` and pins to the supplied VPC Link ID; the URI is consumed verbatim. Future iteration: the module could provision its own private NLB or auto-derive a Service Connect endpoint, but that's deferred until a real consumer needs it.

## Service Connect

Off by default. Enable when multiple services need to talk inside the VPC without going through ingress. Set both `var.service_connect_namespace_arn` (a Cloud Map namespace ARN) and `var.service_connect_config`:

```hcl
service_connect_namespace_arn = module.cloudmap.namespace_arn
service_connect_config = {
  services = [{
    port_name = "http"  # must match a name in container portMappings
    client_alias = [{
      port     = 80
      dns_name = "strata"  # peers reach this service at http://strata
    }]
  }]
}
```

## Inputs

See `variables.tf` for the full list. Highlights:

| Variable | Required? | Default | Notes |
|---|---|---|---|
| `env_name` | yes | — | One of `dev`, `staging`, `prod`. |
| `service_name` | yes | — | Lowercase kebab-case, 3–32 chars. |
| `cluster_arn` | yes | — | From `ecs-cluster` output. |
| `execution_role_arn` | yes | — | Caller-managed; see "Wiring the execution role" above. |
| `log_group_name` | yes | — | Typically the cluster's log group. |
| `vpc_id` | yes | — | From `network` output. |
| `vpc_cidr` | yes | — | From `network` output; used for default egress. |
| `subnet_ids` | yes | — | Private subnets, ≥2 for AZ redundancy. |
| `containers` | yes | — | List of container definitions; see variable doc. |
| `cpu` / `memory` | no | 256 / 512 | Must form a valid Fargate combo. |
| `desired_count` | no | 1 | Bump to ≥2 for prod. |
| `capacity_provider_strategy` | no | 80/20 Spot/on-demand | Replace wholesale to add an on-demand `base`. |
| `autoscaling_min` / `autoscaling_max` | no | 1 / 3 | App Auto Scaling bounds. |
| `cpu_target_tracking` | no | 60 | Target CPU% for the always-on policy. |
| `request_count_target` | no | 1000 | Target req/min/target; only used when LB-attached. |
| `attach_to_alb_listener_arn` | no | `""` | Set to enable ALB integration. |
| `attach_to_apigw_vpc_link_id` | no | `""` | Set to enable API GW integration. |
| `task_role_inline_policies` | no | `[]` | The Aurora/Redis/secrets integration point. |
| `task_role_managed_policy_arns` | no | `[]` | For example-agent's `ReadOnlyAccess` baseline. |
| `service_connect_namespace_arn` | no | `""` | Opt-in; see above. |

## Outputs

`service_name`, `service_arn`, `task_definition_arn`, `task_definition_revision`, `task_definition_family`, `task_role_arn`, `task_role_name`, `security_group_id`, `target_group_arn`, `target_group_name`, `apigw_integration_id`, `autoscaling_target_resource_id`.

The `security_group_id` and `task_role_arn` outputs are the primary integration points — Aurora/Redis consume the SG; cross-account trust policies and S3 bucket policies consume the role ARN.

## How to run (dev account, today)

```bash
# 1. Confirm identity (must be <your-cli-user> @ <ACCOUNT_ID>)
aws sts get-caller-identity

# 2. From modules/ecs-service/examples/basic/
terraform init
terraform plan -out plan.tfplan
# Review carefully — task definition, IAM role, SG, autoscaling target — before applying.
terraform apply plan.tfplan
```

The `examples/basic/` shape is a single nginx:alpine task with no LB attachment — the simplest possible plan path. The `examples/strata-service/` shape demonstrates the realistic Strata-service wiring (API GW VPC-link + Aurora/Redis policy injection); it `validate`s but doesn't `plan` against real ARNs (stubs throughout — see the example's README inline).

## Cost summary

| Component | Monthly (idle, 1 task @ cpu=256/memory=512) |
|---|---|
| Fargate Spot task | ~$5/mo (24×7 at ~$0.0072/hr for 0.25 vCPU + 0.5 GB on Spot) |
| Fargate on-demand task | ~$9/mo (same shape on on-demand at ~$0.0125/hr) |
| ALB target group | $0 (charged at the ALB layer, not the TG) |
| Listener rule | $0 (no per-rule charge) |
| Autoscaling | $0 (App Auto Scaling is free; CloudWatch metric storage is included in Container Insights at the cluster layer) |
| **Two services on Spot (Strata + example-agent)** | **~$10/mo** |

Promote toward on-demand (lower `weight` on FARGATE_SPOT, raise `weight` on FARGATE) for any service where Spot interruption is operationally painful — the cost-vs-stability trade-off lands per-service.

## Reviewers required before apply

- **`security-compliance`** — task role's inline + managed policies (especially when `ReadOnlyAccess` is attached, as in the example-agent), task SG ingress/egress shape, ALB listener-rule path conditions for hostile-input surface.
- **`finops-analyst`** — `capacity_provider_strategy` (Spot vs on-demand mix) and `autoscaling_max` for the runaway-scale upper bound.
- **`observability-sre`** (after first apply) — wire per-service alarms (5xx, target-group health, CPU saturation) keyed off `target_group_arn` and `service_arn` outputs; pair with the service-level dashboard built in AWS-1.10.

## Verification (post-apply)

```bash
# Service is RUNNING with desired tasks
aws ecs describe-services --cluster strata-dev --services <service-name> \
  --query 'services[0].{name:serviceName,status:status,desired:desiredCount,running:runningCount,pending:pendingCount}'

# Task role exists and has expected inline policies
aws iam list-role-policies --role-name <service>-dev-task

# Target group health (only when LB-attached)
aws elbv2 describe-target-health --target-group-arn <tg-arn> \
  --query 'TargetHealthDescriptions[*].{id:Target.Id,state:TargetHealth.State}'

# Autoscaling target registered
aws application-autoscaling describe-scalable-targets \
  --service-namespace ecs \
  --resource-ids "service/strata-dev/<service-name>"
```

## Related tickets

- **This:** AWS-1.3 (`specs/2026-04-25-strata-deploy-aws-plan.md`).
- **Blocked-by:** AWS-1.1 (`network`), AWS-1.2 (`ecs-cluster`).
- **Co-sequenced:** AWS-1.10 (`observability`) — built in parallel; alarms are keyed off this module's `target_group_arn` and `service_arn` outputs.
- **Unblocks:** AWS-2.1 (Strata service module), AWS-3.x (example-agent service module), and any future ECS-based service.
