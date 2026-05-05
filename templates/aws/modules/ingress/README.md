# `aws/modules/ingress` — ALB or API GW HTTP API (one-flag swap)

**Tool choice: Terraform (OpenTofu compatible).** Reason: matches the rest of the AWS deploy template. The module wires both backends through a single resource graph so `terraform plan` against either backend is a single artifact.

## What this creates

A single front-door for one environment in one region, picked at module-input time:

| Backend | Resources created | Idle cost (us-east-1) |
|---|---|---|
| `apigw` | HTTP API Gateway, VPC Link (private subnets), `$default` stage, optional Cognito JWT authorizer, optional CloudWatch log group | **~$0/mo** + $1.00/M requests + $0.005/GB data |
| `alb` | Application Load Balancer (public subnets), HTTPS:443 listener, HTTP:80→301 redirect, ALB security group, optional Cognito-protected listener rules | **~$16/mo** + LCU charges (~$5.85/LCU) |

Per design `§"Dev tier"`: dev defaults `apigw` (every dollar of idle counts on a portfolio repo); staging/prod default `alb` (better for SSE / WebSockets / target-based ECS deploys, and the LCU model fits production traffic shapes).

`var.backend` has **no default**. Per-env `tfvars` set it explicitly; the module errors at validate time if either inputs-set is incomplete for the chosen backend.

## One-flag swap

The module exposes a unified output shape across both backends. Outputs that don't apply to the active backend are emitted as `null`:

| Output | `apigw` | `alb` |
|---|---|---|
| `backend` | `"apigw"` | `"alb"` |
| `endpoint_dns` | `https://abc.execute-api.us-east-1.amazonaws.com` | `strata-dev-alb-xxx.us-east-1.elb.amazonaws.com` |
| `endpoint_zone_id` | `null` | `Z35SXDOTRQ7X7K` (us-east-1 ALB hosted zone) |
| `security_group_id` | VPC-Link SG ID | ALB SG ID |
| `listener_arn` | `null` | HTTPS listener ARN |
| `target_group_arn` | `null` | `null` (consumer creates its own) |
| `api_id` | HTTP API ID | `null` |
| `vpc_link_id` | VPC Link ID | `null` |
| `authorizer_id` | JWT authorizer ID (when Cognito wired) | `null` |
| `stage_name` | `$default` | `null` |

Consumer modules wire `module.ingress.endpoint_dns`, `module.ingress.security_group_id`, etc. — they don't branch on `var.backend`. This is the entire point of the module.

## Inputs

| Variable | Type | Default | Notes |
|---|---|---|---|
| `env_name` | string | — | `dev` \| `staging` \| `prod`. Validated. |
| `aws_region` | string | `us-east-1` | Used to construct the Cognito issuer URL (apigw). |
| `backend` | string | — | `apigw` \| `alb`. Validated. **Required.** |
| `vpc_id` | string | — | VPC the ingress lives in. |
| `vpc_cidr` | string | — | Used for SG egress (alb) and VPC-Link SG ingress (apigw). |
| `public_subnet_ids` | list(string) | `[]` | Required for `alb`. |
| `private_subnet_ids` | list(string) | `[]` | Required for `apigw` VPC Link. |
| `internal` | bool | `false` | ALB scheme. Set true for internal-only ALB. |
| `acm_certificate_arn` | string | `""` | Required for `alb`. Cert is provisioned externally. |
| `deletion_protection` | bool | `false` | ALB only. Flip to true in staging/prod tfvars. |
| `access_logs_bucket` | string | `""` | ALB only. Empty disables. |
| `access_logs_prefix` | string | `""` | ALB only. |
| `restrict_to_cloudfront_prefix_list` | bool | `false` | ALB only. When true, scope 443 ingress to AWS-managed CloudFront prefix list. |
| `alb_idle_timeout_seconds` | number | `60` | Bump to 300+ for SSE workloads. |
| `ssl_policy` | string | `ELBSecurityPolicy-TLS13-1-2-2021-06` | Strongest broadly-supported policy. |
| `cognito_user_pool_id` | string | `""` | apigw — gates JWT authorizer creation. |
| `cognito_user_pool_client_id` | string | `""` | Audience (apigw) / client_id (alb). |
| `cognito_user_pool_arn` | string | `""` | alb only. |
| `cognito_user_pool_domain` | string | `""` | alb only — hosted-UI prefix. |
| `cognito_protected_paths` | list(string) | `[]` | alb only — listener-rule path patterns to gate behind authenticate_cognito. |
| `cors_config` | object | permissive | apigw CORS. |
| `vpc_link_security_group_ids` | list(string) | `[]` | apigw — empty = module-created SG (VPC-CIDR ingress). |
| `enable_logging` | bool | `true` | apigw execution-log group. |
| `log_retention_days` | number | `30` | apigw log retention. |
| `extra_tags` | map(string) | `{}` | Merged into default tags. |

## Outputs

See "One-flag swap" above for the full table and null-valued outputs.

Notable specifics:

- `target_group_arn` is **always null** in v1. Consumer service modules (e.g. `ecs-service`) create their own `aws_lb_target_group` and `aws_lb_listener_rule` against `listener_arn`, then register Fargate tasks. This keeps the ingress module from owning service-specific health-check or target-group config.
- `authorizer_id` is non-null only when both `var.cognito_user_pool_id` and `var.cognito_user_pool_client_id` are set on the apigw backend. Consumers wire it on a per-route basis via `aws_apigatewayv2_route.authorizer_id`.
- `cognito_wired` is a convenience boolean — true when the module actually created Cognito-related resources (apigw authorizer or at least one alb listener rule). Useful for diagnostic output.

## Backend-specific behavior

### `backend = "apigw"`

- Creates `aws_apigatewayv2_api` with `protocol_type = "HTTP"`.
- VPC Link in private subnets — caller's routes can use `connection_type = "VPC_LINK"` to reach internal targets (Cloud Map services, internal NLBs, ALB-internal target groups).
- The `$default` stage has `auto_deploy = true` so route changes propagate without a manual deployment hop.
- Default execution-log group at `/aws/apigateway/strata-{env}` with 30-day retention. Disable via `enable_logging = false`.
- CORS defaults to fully permissive — fine for dev, but **prod tfvars should constrain `allow_origins`** to the actual frontend origin(s).
- Cognito JWT authorizer is created when `cognito_user_pool_id` + `cognito_user_pool_client_id` are set. Routes are attached separately by the consumer module.

### `backend = "alb"`

- Creates an `aws_lb` of type `application` in `var.public_subnet_ids`.
- Module-owned ALB security group with three ingress rules and one egress rule:
  - **443 ingress.** Either `0.0.0.0/0` (default) or scoped to the CloudFront managed prefix list (`var.restrict_to_cloudfront_prefix_list = true`).
  - **80 ingress** from `0.0.0.0/0` — exists solely so the redirect listener can return a 301 to HTTPS. No application traffic is served on :80.
  - **Egress** to `var.vpc_cidr` on TCP 1024–65535 (Fargate task ENIs).
- HTTPS listener with `default_action = fixed-response 404 "Strata"`. Service modules attach their own listener rules (priority 1–99 to take precedence over the module-created Cognito-protected rules at 100+).
- HTTP listener that 301-redirects everything to `https://#{host}:443/#{path}?#{query}`.
- `drop_invalid_header_fields = true`, `enable_http2 = true`, `idle_timeout = var.alb_idle_timeout_seconds`.
- Optional access logs to `var.access_logs_bucket` (the bucket must already grant the AWS-managed ALB-log-delivery principal — see "ALB access logs" below).

## ALB access logs

When `var.access_logs_bucket` is set, the ALB writes access-log files to that S3 bucket. AWS requires the bucket policy to grant write access to the regional ALB log-delivery principal. The `s3-bucket` module (AWS-1.6) has a flag for this — set `alb_log_delivery = true` when creating the bucket, then pass the bucket name into `var.access_logs_bucket` here.

## Cognito wiring

This module accepts Cognito inputs but does **not** create the user pool — that's `cognito-user-pool` (AWS-1.8). The wiring shape:

- **`apigw`**: a JWT authorizer resource is created. The consumer module creates routes (`aws_apigatewayv2_route`) and references `module.ingress.authorizer_id` per route as needed. Routes that omit `authorizer_id` are unauthenticated.
- **`alb`**: a listener rule with `authenticate_cognito` action is created for each path in `var.cognito_protected_paths`. Because the module doesn't own a target group, the second action is a `fixed-response 200` placeholder — consumer service modules add a higher-priority listener rule with their actual target-group action, and the `authenticate_cognito` rule fires first by virtue of priority.

The two paths surface very different operator ergonomics. `apigw` JWT authorizers do strict-validation token verification at the edge; `alb` `authenticate_cognito` runs the full OAuth code flow with browser redirects. Pick the one that matches your client's auth model:

- **Browser-side React app, hosted-UI redirect**: ALB `authenticate_cognito`.
- **MCP client / SDK / API caller with bearer token**: API GW JWT authorizer.

## CloudFront-fronted ALB

When the ALB sits behind CloudFront (per design `§"CloudFront fronts the ALB"`), set `restrict_to_cloudfront_prefix_list = true`. This replaces the open `443/0.0.0.0/0` ingress rule with one scoped to the AWS-managed prefix list `com.amazonaws.global.cloudfront.origin-facing` — only CloudFront edge POPs can reach the ALB directly.

The prefix-list ID is region-specific and changeable, so we resolve it via name (`data "aws_ec2_managed_prefix_list" "cloudfront"`) instead of hardcoding.

## Cost flags

| Posture | Idle $/mo | Per-traffic |
|---|---|---|
| `apigw` (dev) | ~$0 | $1.00/M req + $0.05/GB data |
| `alb` (staging/prod) | ~$16.20 | LCUs (~$5.84 each, summed across 4 dimensions) |

A portfolio dev environment that idles 22h/day at zero traffic costs **$0/mo** on `apigw` and **~$16/mo** on `alb`. That's the whole motivation for the swap.

## Multi-account expansion

The module is account-agnostic. Per-env tfvars set:

- `dev` (account `624990353897`): `backend = "apigw"`, `internal = false`, `deletion_protection = false`.
- `staging`: `backend = "alb"`, `internal = false`, `deletion_protection = true`, `access_logs_bucket = "strata-logs-{account}"`.
- `prod`: `backend = "alb"`, `internal = false`, `deletion_protection = true`, `restrict_to_cloudfront_prefix_list = true`, `access_logs_bucket = "strata-logs-{account}"`, `cognito_protected_paths = ["/admin/*"]`.

## Examples

- `examples/apigw/` — dev backend (`apigw`), no Cognito, applies cleanly into account `624990353897` against the existing `network` module's private subnets.
- `examples/alb/` — production-shape backend (`alb`) with a sentinel ACM cert ARN. `terraform validate` passes; `terraform plan` requires the sentinel be replaced with a real cert.

## Verification

```powershell
cd E:\strata\strata\templates\aws\modules\ingress
terraform fmt -check -recursive
terraform init -backend=false
terraform validate
tflint
checkov -d .

cd examples\apigw
terraform init
terraform plan -out plan.tfplan      # do NOT apply

cd ..\alb
terraform init
terraform validate                   # plan needs a real ACM cert
```
