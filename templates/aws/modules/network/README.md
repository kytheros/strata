# `aws/modules/network` — VPC, subnets, NAT, endpoints, flow logs

**Tool choice: Terraform (OpenTofu compatible).** Reason: matches the rest of the AWS deploy template, so a single `terraform plan` covers the whole stack. Module is account-agnostic and consumed by `examples/basic/` for dev today; staging and prod wire up identically when those accounts are provisioned (see "Multi-account expansion" below).

## What this creates

A fully-formed network fabric for one environment in one region:

| Resource | Count | Notes |
|---|---|---|
| VPC | 1 | `var.vpc_cidr` (default `10.40.0.0/16`); DNS hostnames + DNS support both on; default tenancy. |
| Internet Gateway | 1 | Attached to the VPC. |
| Public subnets | 3 | `/24` per AZ (~250 IPs). `map_public_ip_on_launch = false` (security default — ALBs work without it). |
| Private subnets | 3 | `/20` per AZ (~4090 IPs). ECS Fargate tasks land here. |
| Isolated subnets | 3 | `/22` per AZ (~1020 IPs). Aurora + Redis subnet groups consume these — no internet route. |
| NAT Gateways | 2 | In AZ-a and AZ-b public subnets. AZ-c routes via NAT-a — see below. |
| Elastic IPs (NAT) | 2 | One per NAT GW. |
| Public route table | 1 | `0.0.0.0/0 → IGW`, all 3 public subnets associated. |
| Private route tables | 3 | One per AZ. AZ-a → NAT-a, AZ-b → NAT-b, AZ-c → NAT-a. |
| Isolated route table | 1 | No default route. Gateway endpoints (S3, DynamoDB) provide AWS-service reachability. |
| VPC Flow Log | 1 | Traffic type `ALL`, destination CloudWatch Logs at `/aws/vpc/{env}/flow-logs`, 30d retention. |
| Flow-log IAM role | 1 | Trust policy: `vpc-flow-logs.amazonaws.com` only. Permissions: write to the single flow-log group. |
| Gateway VPC endpoints | 2 | S3 and DynamoDB (free). Attached to all private + isolated route tables. |
| Interface VPC endpoints | 9 | ECR API/DKR, Secrets Manager, KMS, STS, CloudWatch Logs, SSM, Cognito-idp, Bedrock Runtime. ENI per AZ in private subnets, `private_dns_enabled = true`. |
| VPCE security group | 1 | `vpce-{env}-sg`, ingress 443 from VPC CIDR only. |

All resources tagged with `Project=strata`, `Component=network`, `ManagedBy=terraform`, `Environment={env_name}`. Subnets additionally tagged with `Tier` (`public|private|isolated`) and `AZ` for downstream module consumers (ALB target-subnet selection, ECS service placement).

## Subnet CIDR map (for `vpc_cidr = 10.40.0.0/16`)

Computed deterministically with `cidrsubnet()` — no hardcoded subnet CIDRs in source.

| Tier | AZ | CIDR | Usable IPs |
|---|---|---|---|
| public | us-east-1a | `10.40.0.0/24` | ~250 |
| public | us-east-1b | `10.40.1.0/24` | ~250 |
| public | us-east-1c | `10.40.2.0/24` | ~250 |
| private | us-east-1a | `10.40.16.0/20` | ~4090 |
| private | us-east-1b | `10.40.32.0/20` | ~4090 |
| private | us-east-1c | `10.40.48.0/20` | ~4090 |
| isolated | us-east-1a | `10.40.64.0/22` | ~1020 |
| isolated | us-east-1b | `10.40.68.0/22` | ~1020 |
| isolated | us-east-1c | `10.40.72.0/22` | ~1020 |

The block `10.40.4.0/22 .. 10.40.15.0/24` (between public and private) and the block above `10.40.76.0/22` are **deliberately left unallocated** as headroom for future tiers (e.g. a dedicated ML worker subnet) without re-carving the existing layout.

For staging (`10.41.0.0/16`) and prod (`10.42.0.0/16`) the same offsets apply — only the second octet changes.

## Inputs

See `variables.tf` for the full list.

| Variable | Required? | Default | Notes |
|---|---|---|---|
| `env_name` | yes | — | One of `dev`, `staging`, `prod`. Drives naming + tags. |
| `vpc_cidr` | no | `10.40.0.0/16` | Per design: dev `10.40.0.0/16`, staging `10.41.0.0/16`, prod `10.42.0.0/16`. |
| `aws_region` | no | `us-east-1` | Subnets are scoped to this region; endpoint service names interpolate it. |
| `availability_zones` | no | `["us-east-1a","us-east-1b","us-east-1c"]` | Order is meaningful: index 0 hosts NAT-a (AZ-c falls back here), index 1 hosts NAT-b. |
| `flow_log_retention_days` | no | `30` | Must be a CloudWatch-supported value (1, 3, 5, 7, 14, 30, 60, 90, …). |
| `extra_tags` | no | `{}` | Merged into the default tag set. |

## Outputs

`vpc_id`, `vpc_cidr`, `public_subnet_ids`, `private_subnet_ids`, `isolated_subnet_ids`, `public_route_table_id`, `private_route_table_ids`, `isolated_route_table_id`, `internet_gateway_id`, `nat_gateway_ids`, `nat_eip_public_ips`, `flow_log_group_name`, `flow_log_group_arn`, `flow_log_role_arn`, `vpce_security_group_id`, `gateway_endpoint_ids` (map), `interface_endpoint_ids` (map), `interface_endpoint_dns_names` (map).

The maps are keyed by short service name (`s3`, `dynamodb`, `ecr.api`, `ecr.dkr`, `secretsmanager`, `kms`, `sts`, `logs`, `ssm`, `cognito-idp`, `bedrock-runtime`) so consumers can reference a specific endpoint without index surprises.

## How to run (dev account, today)

```bash
# 1. Confirm identity (must be <your-cli-user> @ <ACCOUNT_ID>)
aws sts get-caller-identity

# 2. From modules/network/examples/basic/
terraform init
terraform plan -out plan.tfplan
# Review carefully — IAM role + 11 endpoints — before applying.
terraform apply plan.tfplan
```

## How to expand to staging / prod (later)

The module is account-agnostic. When staging and prod accounts exist:

1. Create `modules/network/examples/staging/main.tf` and `examples/prod/main.tf` as copies of `examples/basic/main.tf`, changing:
   - `env_name = "staging"` (or `"prod"`)
   - `vpc_cidr = "10.41.0.0/16"` (or `"10.42.0.0/16"`)
   - Backend `bucket` → the env's state bucket from its bootstrap apply
   - Backend `key` → `examples/network-basic/terraform.tfstate` (still namespaced per account-bucket)
   - `allowed_account_ids = ["<env-account-id>"]`
2. Run `terraform init / plan / apply` against the env's AWS profile.

When the real `envs/{env}/main.tf` files come online (Phase 2+), they consume `module "network"` directly with the same source path. The example-folder pattern is for module-development testing; the production wiring will live in `envs/`.

## Why two NAT gateways, not three

A NAT Gateway in `us-east-1` is ~$32.85/mo flat plus $0.045/GB processed. A third NAT GW in AZ-c would add ~$32/mo per environment for redundancy that the design does not require:

- Strata's SLO target is **99.9% monthly** (43.2 minutes of downtime budget).
- A single-AZ outage that takes out NAT-a would degrade AZ-c's egress for the duration of the AZ failure.
- AZ failure events at AWS are typically minutes, not hours; combined with workload spread across AZ-a/AZ-b/AZ-c at the ECS layer, the realistic blast radius of NAT-a being down is "~33% of egress capacity gone for ~30 min" — comfortably within the 99.9% budget.

**The fallback is deterministic**: AZ-c's private route table (`strata-{env}-private-rt-us-east-1c`) sends `0.0.0.0/0` to `aws_nat_gateway.this[0]`, which is the AZ-a NAT. This is encoded in `local.private_az_to_nat_index = [0, 1, 0]` in `main.tf`. Verify in the console post-apply: AZ-c's private RT should show NAT-a as its target, not "no route" and not NAT-b.

When 99.9% no longer suffices (we'd need to hit ~99.95% to justify the math), promote to 3 NATs by changing `local.nat_az_indexes = [0, 1, 2]` and `local.private_az_to_nat_index = [0, 1, 2]`. One-line change, no resource recreation outside the new NAT itself.

## VPC endpoints — why and what they cost

11 endpoints by default:

- **2 gateway endpoints** (free): S3, DynamoDB. Routed via route tables, no ENIs. Cuts S3 traffic out of NAT (which would otherwise be billed at $0.045/GB) and removes the internet hop.
- **9 interface endpoints** (paid): ECR API, ECR DKR, Secrets Manager, KMS, STS, CloudWatch Logs, SSM, Cognito-idp, Bedrock Runtime. Each is one ENI per AZ × 3 AZs = 27 ENIs total. AWS charges per ENI-hour and per-GB processed.

**Always-on cost in `us-east-1`**: 9 endpoints × 3 AZs × $0.01/ENI-hour ≈ **~$72/month per environment**, before any data charges. With 3 environments that becomes ~$216/month at idle.

This is intentional. The trade-off is:

- **Without** these endpoints, every ECR pull, secret fetch, log push, KMS call, and Bedrock inference goes out the NAT GW → $0.045/GB processed + slower (extra hop) + crosses the public internet.
- **With** them, the same calls stay on the AWS backplane, are faster, and don't show up as NAT data charges.

The cross-over point depends on workload, but for the Strata profile (chatty Bedrock calls, frequent ECR pulls during deploys, secret fetches per task start) the endpoint cost beats NAT data charges from the first month in production.

`finops-analyst` reviews this trade-off before merge and may recommend dropping a subset (e.g. SSM, Cognito-idp) in dev where idle dominates traffic.

**Why the interface endpoints land in private subnets, not isolated**: the isolated tier is data-plane only (Aurora + Redis). Aurora and ElastiCache do not call AWS APIs from the data plane — they are reachable *as* the data plane. Putting endpoints there would just burn additional ENI-hours for no consumer.

## Flow Log IAM role — least-privilege scope

The role's trust policy allows only `vpc-flow-logs.amazonaws.com` to assume — no human or other service can. The attached inline policy:

- Allows `logs:CreateLogStream`, `logs:PutLogEvents`, `logs:DescribeLogStreams` on the **single** log group `/aws/vpc/{env}/flow-logs` and its log streams.
- Allows `logs:DescribeLogGroups` on `*` only because the IAM resource model does not support resource-level conditions for that action (AWS-published limitation; tracked in the AWS IAM service authorization reference). This is the minimum necessary; the action is read-only and exposes only group metadata.

This satisfies the workspace's least-privilege rule: the role can do exactly what flow-log delivery requires and nothing more.

## Cost summary (always-on, dev account, this module only)

| Component | Monthly |
|---|---|
| 2 × NAT Gateway (idle, no data) | ~$66 |
| 2 × NAT EIP (in-use, no charge while attached) | $0 |
| 9 × Interface VPC Endpoint × 3 AZs | ~$72 |
| CloudWatch Logs ingest (low-traffic dev) | <$2 |
| **Total at idle** | **~$140 / month** |

Add data processing for any meaningful load. `finops-analyst` updates the production estimate during AWS-5.x.

## Reviewers required before apply

- **`security-compliance`** — Flow Log IAM role trust + permissions; interface-endpoint security group ingress (443 from VPC CIDR is correct, but worth a second look for the "VPC CIDR" choice vs a tighter per-SG reference).
- **`finops-analyst`** — Confirm 11 endpoints is the right default for dev or recommend a subset; verify the 2-NAT decision against current SLO.

## Verification (post-apply)

```bash
# VPC and subnets
aws ec2 describe-vpcs --filters Name=tag:Project,Values=strata Name=tag:Environment,Values=dev \
  --query 'Vpcs[].[VpcId,CidrBlock]'

aws ec2 describe-subnets --filters Name=tag:Project,Values=strata Name=tag:Environment,Values=dev \
  --query 'Subnets[].[Tags[?Key==`Name`]|[0].Value,CidrBlock,AvailabilityZone]' --output table

# NAT GW count == 2 and the third AZ falls back to NAT-a
aws ec2 describe-nat-gateways --filter Name=tag:Project,Values=strata Name=tag:Environment,Values=dev \
  --query 'NatGateways[].[NatGatewayId,SubnetId,State]' --output table

# All 11 endpoints
aws ec2 describe-vpc-endpoints --filters Name=tag:Project,Values=strata Name=tag:Environment,Values=dev \
  --query 'VpcEndpoints[].[ServiceName,VpcEndpointType,State]' --output table
# → expect 11 rows: 2 Gateway, 9 Interface

# Flow logs landing in CloudWatch
aws logs describe-log-streams --log-group-name /aws/vpc/dev/flow-logs --max-items 1
```

## Related tickets

- **This:** AWS-1.1 (`specs/2026-04-25-strata-deploy-aws-plan.md`).
- **Blocked-by:** AWS-0.1 (bootstrap state backend).
- **Unblocks on apply:** AWS-1.2 (`ecs-cluster`), AWS-1.4 (`aurora-postgres`, also blocked by AWS-1.9), AWS-1.5 (`elasticache-redis`), AWS-1.11 (`ingress`).
- **Coordinates with:** AWS-1.10 (`observability`) — that module adds CMK encryption to the flow-log group; for now it uses the AWS-owned CloudWatch Logs key.
