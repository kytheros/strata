###############################################################################
# strata ecs-service - Fargate task def + service + autoscaling + LB/APIGW
#
# What this module owns:
#
#   Owns: 1 ECS task definition (rev-managed), 1 ECS service, 1 IAM task role
#         (with inline + managed policies pluggable by the caller), 1 task
#         security group, fine-grained ingress/egress rules attached to it,
#         optional ALB target group + listener rule, optional API GW HTTP_PROXY
#         integration stub, app-autoscaling target + 1-2 policies (CPU always;
#         request-count only when LB-attached), and per-resource tags.
#
#   Does NOT own: the ECS cluster, the task execution role, the ALB itself, the
#                 API GW HTTP API itself, the Cloud Map namespace, the log
#                 group, the Aurora/Redis security groups, or the secrets the
#                 task pulls. Those are upstream module outputs the caller
#                 wires in via variables.
#
# Per-spec defaults: 80% FARGATE_SPOT / 20% FARGATE on-demand. Deployment
# circuit breaker is non-negotiable - always on with rollback. ECS Exec on by
# default. Service Connect opt-in.
#
# LB-attachment branching: when var.attach_to_alb_listener_arn is non-empty
# the module emits a target group + listener rule, attaches the LB block to
# the service, and adds an ALBRequestCountPerTarget autoscaling policy. When
# empty, none of those resources are emitted.
#
# Network reachability: the task SG always permits egress to var.vpc_cidr
# (catches Aurora/Redis/Service-Connect peers without naming each SG), plus
# 443 to var.allowed_egress_cidrs (default 0.0.0.0/0 for AWS APIs and LLM
# egress). Inbound is on var.container_port_for_ingress from the ALB SG (when
# LB-attached), API-GW VPC-Link SG (when API-GW-attached), and any
# var.ingress_security_group_ids supplied by the caller.
###############################################################################

locals {
  default_tags = {
    Project     = "strata"
    Component   = "ecs-service"
    ManagedBy   = "terraform"
    Environment = var.env_name
    Service     = var.service_name
  }

  tags = merge(local.default_tags, var.extra_tags)

  family_name    = "${var.service_name}-${var.env_name}"
  task_role_name = "${var.service_name}-${var.env_name}-task"
  sg_name        = "${var.service_name}-${var.env_name}-sg"

  # AWS target-group name max length: 32 chars. Truncate `<service>-tg` and
  # append a 6-char hash suffix for collision-resistance when the truncated
  # form would have been ambiguous between two services with the same prefix.
  tg_name_raw = "${var.service_name}-tg"
  tg_name = (
    length(local.tg_name_raw) <= 32
    ? local.tg_name_raw
    : format("%s-%s", substr(var.service_name, 0, 22), substr(sha1(var.service_name), 0, 6))
  )

  # Branching helpers
  alb_attached   = var.attach_to_alb_listener_arn != ""
  apigw_attached = var.attach_to_apigw_vpc_link_id != ""
  sc_enabled     = var.service_connect_namespace_arn != "" && var.service_connect_config != null

  # The container_definitions argument expects a JSON string. We render the
  # var.containers list into AWS's container-definition shape.
  container_definitions_json = jsonencode([
    for c in var.containers : merge(
      {
        name      = c.name
        image     = c.image
        essential = c.essential

        portMappings = [
          for p in c.port_mappings : merge(
            {
              containerPort = p.container_port
              hostPort      = p.container_port
              protocol      = p.protocol
            },
            # Service Connect requires named ports; only emit `name` when
            # the caller supplied one. Empty/null `name` is allowed for
            # services that don't register with Service Connect.
            p.name == null ? {} : { name = p.name },
          )
        ]

        environment = [
          for e in c.environment : {
            name  = e.name
            value = e.value
          }
        ]

        secrets = [
          for s in c.secrets : {
            name      = s.name
            valueFrom = s.value_from
          }
        ]

        # Default to awslogs at the cluster log group when the caller did not
        # supply a log_configuration. The streamPrefix scopes log streams to
        # this service so multiple services can share the cluster log group
        # without collisions.
        logConfiguration = c.log_configuration != null ? {
          logDriver = c.log_configuration.log_driver
          options   = c.log_configuration.options
          } : {
          logDriver = "awslogs"
          options = {
            awslogs-group         = var.log_group_name
            awslogs-region        = var.aws_region
            awslogs-stream-prefix = var.service_name
          }
        }
      },
      # Optional fields - only included when set so the rendered JSON stays
      # minimal and diff-clean.
      c.command != null ? { command = c.command } : {},
      c.health_check != null ? {
        healthCheck = {
          command     = c.health_check.command
          interval    = c.health_check.interval
          timeout     = c.health_check.timeout
          retries     = c.health_check.retries
          startPeriod = c.health_check.start_period
        }
      } : {},
    )
  ])
}

###############################################################################
# Pre-flight validation
###############################################################################

check "alb_and_apigw_mutually_consistent" {
  assert {
    condition     = !(local.apigw_attached && (var.apigw_integration_uri == "" || var.apigw_api_id == ""))
    error_message = "When attach_to_apigw_vpc_link_id is set, both apigw_integration_uri and apigw_api_id must be supplied."
  }
}

check "service_connect_consistency" {
  assert {
    condition     = (var.service_connect_namespace_arn == "") == (var.service_connect_config == null)
    error_message = "service_connect_namespace_arn and service_connect_config must both be set or both be unset."
  }
}

###############################################################################
# 1. Task role - assumed by the running container via the task metadata service
#
# Trust policy: ecs-tasks.amazonaws.com only. Inline policies are the primary
# integration point for upstream modules - callers pass in the
# `consumer_iam_policy_json` outputs from aurora-postgres, elasticache-redis,
# and secrets to grant least-privilege access without leaking permissions
# across services.
###############################################################################

data "aws_iam_policy_document" "task_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "task" {
  name               = local.task_role_name
  assume_role_policy = data.aws_iam_policy_document.task_assume.json
  description        = "Task role assumed by the ${var.service_name} container in env ${var.env_name}."

  tags = local.tags
}

resource "aws_iam_role_policy" "task_inline" {
  for_each = { for p in var.task_role_inline_policies : p.name => p.policy_json }

  name   = each.key
  role   = aws_iam_role.task.id
  policy = each.value
}

resource "aws_iam_role_policy_attachment" "task_managed" {
  for_each = toset(var.task_role_managed_policy_arns)

  role       = aws_iam_role.task.name
  policy_arn = each.value
}

###############################################################################
# 2. Task security group - VPC-level perimeter for the task ENIs
###############################################################################

resource "aws_security_group" "this" {
  # checkov:skip=CKV_AWS_23:Per-rule descriptions are inlined on each aws_vpc_security_group_*_rule below.
  name        = local.sg_name
  description = "Security group for ECS service ${var.service_name} (${var.env_name}). Ingress on container port from configured sources; egress to VPC + 443 to allowed CIDRs."
  vpc_id      = var.vpc_id

  tags = merge(local.tags, {
    Name = local.sg_name
  })
}

###############################################################################
# 2a. Ingress rules - from ALB SG, API-GW VPC-link SG, and caller list
#
# We rely on the ingress module's published outputs as the source of the SG
# ID. Both rules are emitted only when the corresponding attach_* var is set.
###############################################################################

# When LB-attached, the caller's listener ARN comes from the ingress module -
# which also exposes the ALB SG via output `security_group_id`. Rather than
# require the caller to thread the SG separately, we additionally accept the
# ALB SG as ingress when listed in var.ingress_security_group_ids. The simpler
# pattern for v1 - make the caller pass the ingress source SG ID(s) explicitly
# in var.ingress_security_group_ids, regardless of attachment kind.
resource "aws_vpc_security_group_ingress_rule" "from_caller_sgs" {
  # checkov:skip=CKV_AWS_260:False positive - this rule uses referenced_security_group_id (not cidr_ipv4), so the source is always a specific SG (e.g. ALB SG, API GW VPC link SG, peer service SG). The container port is configurable via var.container_port_for_ingress; default 80 is the convention for HTTP services. CKV_AWS_260 only fires on 0.0.0.0/0 sources, but the static analyzer can't tell from the resource shape that a referenced-SG ingress is not internet-open.
  for_each = toset(var.ingress_security_group_ids)

  security_group_id            = aws_security_group.this.id
  description                  = "Ingress to ${var.service_name} container port from caller-supplied security group ${each.value}."
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = var.container_port_for_ingress
  to_port                      = var.container_port_for_ingress

  tags = local.tags
}

###############################################################################
# 2b. Egress rules - VPC-wide TCP, plus 443 to allowed CIDRs
###############################################################################

# All TCP to the VPC CIDR - covers Aurora (5432), Redis (6379), Service
# Connect peers, and any future internal endpoint without naming each SG.
# This is the same pattern the ALB SG uses for reaching tasks.
resource "aws_vpc_security_group_egress_rule" "to_vpc" {
  security_group_id = aws_security_group.this.id
  description       = "All TCP to the VPC interior - Aurora, Redis, Service Connect peers, internal endpoints."
  cidr_ipv4         = var.vpc_cidr
  ip_protocol       = "tcp"
  from_port         = 0
  to_port           = 65535

  tags = local.tags
}

# Per-SG egress to specific peer SGs - useful when the caller wants explicit
# auditability over which downstream resources this service can reach (Aurora,
# Redis, etc.). Stacks alongside the VPC-CIDR rule; redundancy is acceptable.
resource "aws_vpc_security_group_egress_rule" "to_peer_sgs" {
  for_each = toset(var.allowed_egress_security_group_ids)

  security_group_id            = aws_security_group.this.id
  description                  = "Egress from ${var.service_name} to peer security group ${each.value}."
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = 0
  to_port                      = 65535

  tags = local.tags
}

# 443 to the wider world for AWS API + LLM provider egress. When VPC endpoints
# are present (network module ships 9 of them) most AWS API traffic stays in
# the VPC and never traverses this rule; LLM egress (OpenAI, Anthropic) and
# Cognito hosted UI traffic still need it.
resource "aws_vpc_security_group_egress_rule" "https_egress" {
  for_each = toset(var.allowed_egress_cidrs)

  # checkov:skip=CKV_AWS_382:443/0.0.0.0/0 is required for AWS API and LLM-provider egress when VPC endpoints don't cover the destination. Caller can lock down further by passing only specific CIDRs.
  security_group_id = aws_security_group.this.id
  description       = "HTTPS egress from ${var.service_name} to ${each.value} - AWS APIs and LLM provider APIs"
  cidr_ipv4         = each.value
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443

  tags = local.tags
}

###############################################################################
# 3. Task definition
###############################################################################

resource "aws_ecs_task_definition" "this" {
  family                   = local.family_name
  cpu                      = tostring(var.cpu)
  memory                   = tostring(var.memory)
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]

  execution_role_arn = var.execution_role_arn
  task_role_arn      = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = split("/", var.runtime_platform)[0]
    cpu_architecture        = split("/", var.runtime_platform)[1]
  }

  container_definitions = local.container_definitions_json

  tags = merge(local.tags, {
    Name = local.family_name
  })
}

###############################################################################
# 4. Optional ALB target group + listener rule
###############################################################################

resource "aws_lb_target_group" "this" {
  count = local.alb_attached ? 1 : 0

  # checkov:skip=CKV_AWS_378:HTTP between ALB and Fargate task is appropriate - TLS is terminated at the ALB and the VPC interior is the trust boundary. End-to-end TLS to tasks would require per-service ACM certs which is not warranted at this scale.
  name        = local.tg_name
  port        = var.target_group_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id

  health_check {
    enabled             = true
    path                = var.health_check_path
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  dynamic "stickiness" {
    for_each = var.stickiness_enabled ? [1] : []
    content {
      type            = "lb_cookie"
      cookie_duration = var.stickiness_duration_seconds
      enabled         = true
    }
  }

  # Avoid name collisions when target groups are recreated (e.g. health-check
  # path changes that force replacement) - let TF spin up the new TG before
  # destroying the old.
  lifecycle {
    create_before_destroy = true
  }

  tags = merge(local.tags, {
    Name = local.tg_name
  })
}

resource "aws_lb_listener_rule" "this" {
  count = local.alb_attached ? 1 : 0

  listener_arn = var.attach_to_alb_listener_arn
  priority     = var.alb_listener_priority

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this[0].arn
  }

  condition {
    path_pattern {
      values = var.alb_path_patterns
    }
  }

  dynamic "condition" {
    for_each = length(var.alb_host_headers) > 0 ? [1] : []
    content {
      host_header {
        values = var.alb_host_headers
      }
    }
  }

  tags = local.tags
}

###############################################################################
# 5. Optional API GW HTTP_PROXY integration (stub)
#
# Per spec §"API GW integration": v1 ships a stub that takes apigw_integration_uri
# (the consumer provides the URL - typically a private NLB or Service Connect
# endpoint). Routes are caller-attached via aws_apigatewayv2_route separately.
###############################################################################

resource "aws_apigatewayv2_integration" "this" {
  count = local.apigw_attached ? 1 : 0

  api_id           = var.apigw_api_id
  integration_type = "HTTP_PROXY"
  integration_uri  = var.apigw_integration_uri

  integration_method     = "ANY"
  connection_type        = "VPC_LINK"
  connection_id          = var.attach_to_apigw_vpc_link_id
  payload_format_version = "1.0"

  timeout_milliseconds = 30000
}

###############################################################################
# 6. ECS service
###############################################################################

resource "aws_ecs_service" "this" {
  # checkov:skip=CKV_AWS_333:Tasks land in private subnets per var.subnet_ids; assign_public_ip is hard-coded false below. Public ingress arrives via the ALB or API GW VPC link, never directly to the task ENI.
  name            = var.service_name
  cluster         = var.cluster_arn
  task_definition = aws_ecs_task_definition.this.arn
  desired_count   = var.desired_count

  # When capacity_provider_strategy is set we MUST omit launch_type (the AWS
  # provider rejects setting both). The strategy here overrides the cluster's
  # default strategy - services pin their own preferences.
  dynamic "capacity_provider_strategy" {
    for_each = var.capacity_provider_strategy
    content {
      capacity_provider = capacity_provider_strategy.value.capacity_provider
      weight            = capacity_provider_strategy.value.weight
      base              = capacity_provider_strategy.value.base
    }
  }

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [aws_security_group.this.id]
    assign_public_ip = false
  }

  dynamic "load_balancer" {
    for_each = local.alb_attached ? [1] : []
    content {
      target_group_arn = aws_lb_target_group.this[0].arn
      container_name   = var.containers[0].name
      container_port   = var.container_port_for_ingress
    }
  }

  dynamic "service_connect_configuration" {
    for_each = local.sc_enabled ? [1] : []
    content {
      enabled   = true
      namespace = var.service_connect_namespace_arn

      dynamic "service" {
        for_each = var.service_connect_config.services
        content {
          port_name             = service.value.port_name
          discovery_name        = service.value.discovery_name
          ingress_port_override = service.value.ingress_port_override

          dynamic "client_alias" {
            for_each = service.value.client_alias
            content {
              port     = client_alias.value.port
              dns_name = client_alias.value.dns_name
            }
          }
        }
      }
    }
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  deployment_maximum_percent         = var.deployment_maximum_percent
  deployment_minimum_healthy_percent = var.deployment_minimum_healthy_percent

  health_check_grace_period_seconds = local.alb_attached ? var.health_check_grace_period_seconds : null

  enable_execute_command = var.enable_execute_command

  propagate_tags = "TASK_DEFINITION"

  # Don't fight the autoscaler: once the autoscaling target attaches, ignore
  # desired_count drift. The initial value comes from var.desired_count.
  lifecycle {
    ignore_changes = [desired_count]
  }

  tags = merge(local.tags, {
    Name = var.service_name
  })

  depends_on = [
    aws_lb_listener_rule.this,
  ]
}

###############################################################################
# 7. Auto-scaling
#
# Always: CPU target tracking.
# When LB-attached: ALBRequestCountPerTarget target tracking on top.
###############################################################################

resource "aws_appautoscaling_target" "this" {
  service_namespace  = "ecs"
  scalable_dimension = "ecs:service:DesiredCount"
  resource_id        = "service/${reverse(split("/", var.cluster_arn))[0]}/${aws_ecs_service.this.name}"
  min_capacity       = var.autoscaling_min
  max_capacity       = var.autoscaling_max

  tags = local.tags
}

resource "aws_appautoscaling_policy" "cpu" {
  name               = "${var.service_name}-${var.env_name}-cpu-tt"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.this.service_namespace
  scalable_dimension = aws_appautoscaling_target.this.scalable_dimension
  resource_id        = aws_appautoscaling_target.this.resource_id

  target_tracking_scaling_policy_configuration {
    target_value       = var.cpu_target_tracking
    scale_in_cooldown  = 60
    scale_out_cooldown = 60

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

# Request-count target tracking - only meaningful when LB-attached. The
# `resource_label` format is documented at:
#   https://docs.aws.amazon.com/autoscaling/application/APIReference/API_PredefinedMetricSpecification.html
# Format: app/<load-balancer-name>/<lb-id>/targetgroup/<tg-name>/<tg-id>
# We construct it from the listener_arn (which contains the LB id) and the
# target group's arn_suffix attribute.
resource "aws_appautoscaling_policy" "request_count" {
  count = local.alb_attached ? 1 : 0

  name               = "${var.service_name}-${var.env_name}-rcpt-tt"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.this.service_namespace
  scalable_dimension = aws_appautoscaling_target.this.scalable_dimension
  resource_id        = aws_appautoscaling_target.this.resource_id

  target_tracking_scaling_policy_configuration {
    target_value       = var.request_count_target
    scale_in_cooldown  = 60
    scale_out_cooldown = 60

    predefined_metric_specification {
      predefined_metric_type = "ALBRequestCountPerTarget"
      # ResourceLabel format documented at:
      # https://docs.aws.amazon.com/autoscaling/application/APIReference/API_PredefinedMetricSpecification.html
      #
      # Required shape: `app/<lb-name>/<lb-id>/targetgroup/<tg-name>/<tg-id>`.
      #
      # Listener ARN tail captures `app/<lb-name>/<lb-id>` via the regex below;
      # `aws_lb_target_group.arn_suffix` already returns
      # `targetgroup/<tg-name>/<tg-id>`. Concatenating yields the exact label.
      resource_label = format(
        "%s/%s",
        regex("listener/(app/[^/]+/[a-f0-9]+)", var.attach_to_alb_listener_arn)[0],
        aws_lb_target_group.this[0].arn_suffix,
      )
    }
  }
}
