###############################################################################
# strata network — VPC + 3-AZ subnets + NAT + endpoints + flow logs
#
# Topology (CIDR examples shown for the dev default 10.40.0.0/16):
#
#   Public  /24  × 3 AZs  →  NAT GW + ALB only           (10.40.0.0/24..2.0/24)
#   Private /20 × 3 AZs  →  ECS Fargate tasks            (10.40.16.0/20..48.0/20)
#   Isolated /22 × 3 AZs →  Aurora + Redis (no internet) (10.40.64.0/22..72.0/22)
#
# NAT GWs: 2 (in AZ-a and AZ-b public subnets), not 3. AZ-c's private subnet
# routes back to NAT-a. Documented trade-off — saves ~$32/mo at the cost of
# AZ-a being a SPOF for AZ-c egress during a single-AZ failure. Acceptable
# at the 99.9% target. See README §"Why two NAT gateways, not three".
#
# Endpoints:
#   - Gateway (free, route-table based): S3, DynamoDB
#   - Interface (paid, ENI-based, ~$7.20/mo each + data): 9 endpoints attached
#     to the *private* tier across 3 AZs. Isolated tier is data-plane-only and
#     does not need to reach AWS APIs.
###############################################################################

locals {
  default_tags = {
    Project     = "strata"
    Component   = "network"
    ManagedBy   = "terraform"
    Environment = var.env_name
  }

  tags = merge(local.default_tags, var.extra_tags)

  # ---------------------------------------------------------------------------
  # CIDR plan (deterministic via cidrsubnet)
  # ---------------------------------------------------------------------------
  # For a /16 VPC:
  #   public  /24: newbits=8, indexes 0..2  → 10.x.0.0/24,  10.x.1.0/24,  10.x.2.0/24
  #   private /20: newbits=4, indexes 1..3  → 10.x.16.0/20, 10.x.32.0/20, 10.x.48.0/20
  #     (index 0 (10.x.0.0/20) overlaps the public /24s, so we skip it)
  #   isolated /22: newbits=6, indexes 16..18 → 10.x.64.0/22, 10.x.68.0/22, 10.x.72.0/22
  #     (indexes 0..15 land inside the public+private space; 16 is the first
  #      /22 that begins at 10.x.64.0, cleanly past the private /20s)
  public_subnet_cidrs = [
    for i in range(length(var.availability_zones)) :
    cidrsubnet(var.vpc_cidr, 8, i)
  ]

  private_subnet_cidrs = [
    for i in range(length(var.availability_zones)) :
    cidrsubnet(var.vpc_cidr, 4, i + 1)
  ]

  isolated_subnet_cidrs = [
    for i in range(length(var.availability_zones)) :
    cidrsubnet(var.vpc_cidr, 6, i + 16)
  ]

  # NAT placement: indexes 0 and 1. Index 2 (AZ-c) routes via NAT at index 0.
  nat_az_indexes = [0, 1]

  # Per-private-subnet NAT routing table:
  #   AZ-a (idx 0) -> NAT-a (idx 0)
  #   AZ-b (idx 1) -> NAT-b (idx 1)
  #   AZ-c (idx 2) -> NAT-a (idx 0)   <- intentional fallback
  private_az_to_nat_index = [0, 1, 0]

  # Interface endpoints. Names are short keys; the full service name is
  # constructed as "com.amazonaws.${region}.${name}".
  interface_endpoint_services = [
    "ecr.api",
    "ecr.dkr",
    "secretsmanager",
    "kms",
    "sts",
    "logs",
    "ssm",
    "cognito-idp",
    "bedrock-runtime",
  ]
}

###############################################################################
# 1. VPC
###############################################################################

resource "aws_vpc" "this" {
  # checkov:skip=CKV2_AWS_11:Flow logs ARE enabled on this VPC (see aws_flow_log.this below); checkov occasionally misses the cross-resource link.
  # checkov:skip=CKV2_AWS_12:Default SG is left at AWS defaults; service-specific SGs are owned by consumer modules (ECS, Aurora, Redis) — they never assign the default SG.
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true
  instance_tenancy     = "default"

  tags = merge(local.tags, {
    Name = "strata-${var.env_name}-vpc"
  })
}

###############################################################################
# 2. Internet Gateway
###############################################################################

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = merge(local.tags, {
    Name = "strata-${var.env_name}-igw"
  })
}

###############################################################################
# 3. Subnets — 3 tiers × 3 AZs = 9 subnets
###############################################################################

resource "aws_subnet" "public" {
  count = length(var.availability_zones)

  vpc_id            = aws_vpc.this.id
  cidr_block        = local.public_subnet_cidrs[count.index]
  availability_zone = var.availability_zones[count.index]

  # Security default: ALBs work with auto-assign off. Anything that genuinely
  # needs a public IP can be given one explicitly via the EC2/ENI API.
  map_public_ip_on_launch = false

  tags = merge(local.tags, {
    Name = "strata-${var.env_name}-public-${var.availability_zones[count.index]}"
    Tier = "public"
    AZ   = var.availability_zones[count.index]
  })
}

resource "aws_subnet" "private" {
  count = length(var.availability_zones)

  vpc_id            = aws_vpc.this.id
  cidr_block        = local.private_subnet_cidrs[count.index]
  availability_zone = var.availability_zones[count.index]

  map_public_ip_on_launch = false

  tags = merge(local.tags, {
    Name = "strata-${var.env_name}-private-${var.availability_zones[count.index]}"
    Tier = "private"
    AZ   = var.availability_zones[count.index]
  })
}

resource "aws_subnet" "isolated" {
  count = length(var.availability_zones)

  vpc_id            = aws_vpc.this.id
  cidr_block        = local.isolated_subnet_cidrs[count.index]
  availability_zone = var.availability_zones[count.index]

  map_public_ip_on_launch = false

  tags = merge(local.tags, {
    Name = "strata-${var.env_name}-isolated-${var.availability_zones[count.index]}"
    Tier = "isolated"
    AZ   = var.availability_zones[count.index]
  })
}

###############################################################################
# 4. NAT Gateways (2, in AZ-a and AZ-b public subnets)
###############################################################################

resource "aws_eip" "nat" {
  count = length(local.nat_az_indexes)

  domain = "vpc"

  tags = merge(local.tags, {
    Name = "strata-${var.env_name}-nat-eip-${var.availability_zones[local.nat_az_indexes[count.index]]}"
  })

  depends_on = [aws_internet_gateway.this]
}

resource "aws_nat_gateway" "this" {
  count = length(local.nat_az_indexes)

  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[local.nat_az_indexes[count.index]].id

  tags = merge(local.tags, {
    Name = "strata-${var.env_name}-nat-${var.availability_zones[local.nat_az_indexes[count.index]]}"
  })

  depends_on = [aws_internet_gateway.this]
}

###############################################################################
# 5. Route tables
###############################################################################

# --- Public RT: 0.0.0.0/0 → IGW. One RT, all 3 public subnets attached. ---

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  tags = merge(local.tags, {
    Name = "strata-${var.env_name}-public-rt"
    Tier = "public"
  })
}

resource "aws_route" "public_default" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  count = length(var.availability_zones)

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# --- Private RTs: one per AZ. Default route → NAT per local.private_az_to_nat_index ---

resource "aws_route_table" "private" {
  count = length(var.availability_zones)

  vpc_id = aws_vpc.this.id

  tags = merge(local.tags, {
    Name = "strata-${var.env_name}-private-rt-${var.availability_zones[count.index]}"
    Tier = "private"
    AZ   = var.availability_zones[count.index]
  })
}

resource "aws_route" "private_default" {
  count = length(var.availability_zones)

  route_table_id         = aws_route_table.private[count.index].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.this[local.private_az_to_nat_index[count.index]].id
}

resource "aws_route_table_association" "private" {
  count = length(var.availability_zones)

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

# --- Isolated RT: no default route. One RT, all 3 isolated subnets attached. ---

resource "aws_route_table" "isolated" {
  vpc_id = aws_vpc.this.id

  tags = merge(local.tags, {
    Name = "strata-${var.env_name}-isolated-rt"
    Tier = "isolated"
  })
}

resource "aws_route_table_association" "isolated" {
  count = length(var.availability_zones)

  subnet_id      = aws_subnet.isolated[count.index].id
  route_table_id = aws_route_table.isolated.id
}

###############################################################################
# 6. VPC Flow Logs → CloudWatch Logs
###############################################################################

resource "aws_cloudwatch_log_group" "flow_logs" {
  # checkov:skip=CKV_AWS_158:Log group uses the AWS-owned CloudWatch Logs key. KMS-CMK is added in AWS-1.10 (observability) where the key lifecycle is owned.
  # checkov:skip=CKV_AWS_338:Flow-log retention is intentionally 30d (var.flow_log_retention_days). Long-tail forensics are covered by S3 archival in AWS-1.10; CloudWatch is the hot tier only.
  name              = "/aws/vpc/${var.env_name}/flow-logs"
  retention_in_days = var.flow_log_retention_days

  tags = local.tags
}

# Trust policy: only the VPC Flow Logs delivery service can assume.
data "aws_iam_policy_document" "flow_log_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["vpc-flow-logs.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "flow_log" {
  name               = "strata-${var.env_name}-vpc-flow-log-role"
  assume_role_policy = data.aws_iam_policy_document.flow_log_assume.json
  description        = "Role assumed by VPC Flow Logs to deliver to CloudWatch Logs (scoped to the env's flow-log group only)."

  tags = local.tags
}

# Permissions: scoped tightly to the single log group + its log streams.
data "aws_iam_policy_document" "flow_log_permissions" {
  statement {
    sid    = "WriteFlowLogsToOwnedGroup"
    effect = "Allow"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogStreams",
    ]

    resources = [
      aws_cloudwatch_log_group.flow_logs.arn,
      "${aws_cloudwatch_log_group.flow_logs.arn}:*",
    ]
  }

  statement {
    sid    = "DescribeOwnGroup"
    effect = "Allow"

    actions = ["logs:DescribeLogGroups"]

    # DescribeLogGroups doesn't support resource-level conditions in IAM
    # (AWS-published limitation). Scope as tightly as the API allows.
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "flow_log" {
  name   = "flow-log-delivery"
  role   = aws_iam_role.flow_log.id
  policy = data.aws_iam_policy_document.flow_log_permissions.json
}

resource "aws_flow_log" "this" {
  iam_role_arn    = aws_iam_role.flow_log.arn
  log_destination = aws_cloudwatch_log_group.flow_logs.arn
  traffic_type    = "ALL"
  vpc_id          = aws_vpc.this.id

  tags = merge(local.tags, {
    Name = "strata-${var.env_name}-vpc-flow-log"
  })
}

###############################################################################
# 7. Gateway VPC endpoints (free): S3 + DynamoDB
#
# Attached to ALL private + isolated route tables. NOT to public — public
# already has IGW egress and gateway endpoints conflict with global routes
# only by precedence, but there's no reason to add them there.
###############################################################################

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${var.aws_region}.s3"
  vpc_endpoint_type = "Gateway"

  route_table_ids = concat(
    aws_route_table.private[*].id,
    [aws_route_table.isolated.id],
  )

  tags = merge(local.tags, {
    Name = "strata-${var.env_name}-vpce-s3"
  })
}

resource "aws_vpc_endpoint" "dynamodb" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${var.aws_region}.dynamodb"
  vpc_endpoint_type = "Gateway"

  route_table_ids = concat(
    aws_route_table.private[*].id,
    [aws_route_table.isolated.id],
  )

  tags = merge(local.tags, {
    Name = "strata-${var.env_name}-vpce-dynamodb"
  })
}

###############################################################################
# 8. Interface VPC endpoints (paid): 9 endpoints × ENI per AZ in private subnets
###############################################################################

# Security group for all interface endpoints. Ingress 443 from VPC CIDR only —
# no internet, no cross-VPC reachability.
resource "aws_security_group" "vpce" {
  # checkov:skip=CKV_AWS_23:All rules are tagged via the security group's Name tag; per-rule descriptions are provided inline below.
  name        = "vpce-${var.env_name}-sg"
  description = "HTTPS from within the VPC to interface VPC endpoints (env=${var.env_name})."
  vpc_id      = aws_vpc.this.id

  tags = merge(local.tags, {
    Name = "vpce-${var.env_name}-sg"
  })
}

resource "aws_vpc_security_group_ingress_rule" "vpce_https_from_vpc" {
  security_group_id = aws_security_group.vpce.id

  description = "Allow HTTPS from anywhere inside the VPC CIDR to interface VPC endpoints."
  cidr_ipv4   = aws_vpc.this.cidr_block
  ip_protocol = "tcp"
  from_port   = 443
  to_port     = 443

  tags = local.tags
}

# No explicit egress rule needed for an interface-endpoint SG; AWS allows the
# return traffic implicitly. Default egress (0.0.0.0/0) is acceptable here
# because the ENI lives inside our subnets and only forwards to the AWS
# service backplane.
# checkov:skip=CKV_AWS_382 — tracked: outbound is unrestricted on the endpoint
# SG by design; the endpoint ENI is a stub that returns AWS API traffic only.

# Interface endpoint services are not available in every AZ. cognito-idp in
# us-east-1, for example, only runs in 1a + 1b — deploying it into a 1c subnet
# yields InvalidParameter at apply time. We resolve the supported AZs per
# service via data lookup and intersect with our private subnet AZs.
data "aws_vpc_endpoint_service" "interface" {
  for_each = toset(local.interface_endpoint_services)

  service_name = "com.amazonaws.${var.aws_region}.${each.key}"
}

resource "aws_vpc_endpoint" "interface" {
  for_each = toset(local.interface_endpoint_services)

  vpc_id              = aws_vpc.this.id
  service_name        = "com.amazonaws.${var.aws_region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true

  # Filter to private subnets whose AZ is supported by this specific service.
  subnet_ids = [
    for s in aws_subnet.private :
    s.id if contains(data.aws_vpc_endpoint_service.interface[each.key].availability_zones, s.availability_zone)
  ]
  security_group_ids = [aws_security_group.vpce.id]

  tags = merge(local.tags, {
    Name = "strata-${var.env_name}-vpce-${each.key}"
  })
}
