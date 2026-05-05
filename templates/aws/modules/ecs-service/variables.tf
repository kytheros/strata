###############################################################################
# Identity
###############################################################################

variable "env_name" {
  description = "Environment short name (dev|staging|prod). Used in resource naming and tags."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.env_name)
    error_message = "env_name must be one of: dev, staging, prod."
  }
}

variable "service_name" {
  description = "Short, kebab-case name for this service. Used as the ECS service name and as the prefix for all module-owned sub-resources (task definition family, task role, security group, target group). Must be unique within the cluster."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}[a-z0-9]$", var.service_name))
    error_message = "service_name must be lowercase kebab-case, 3-32 chars, start with a letter, and end with a letter or digit."
  }
}

variable "aws_region" {
  description = "AWS region. Currently informational; used in tag context and reserved for future cross-region wiring."
  type        = string
  default     = "us-east-1"
}

###############################################################################
# Cluster wiring
###############################################################################

variable "cluster_arn" {
  description = "ARN of the ECS cluster this service runs on. Comes from the `ecs-cluster` module's `cluster_arn` output."
  type        = string
}

variable "execution_role_arn" {
  description = "ARN of the IAM role used by the ECS agent itself to pull images, write logs, and resolve secrets at task-launch time. Typically the cluster's `exec_role_arn` output, BUT the cluster module's exec role is the *operator* role for `aws ecs execute-command`; the task execution role is a different role and is supplied here by the caller (often a thin caller-managed role with `AmazonECSTaskExecutionRolePolicy` + secrets read). See README §\"Wiring the execution role.\""
  type        = string
}

variable "log_group_name" {
  description = "Name of the CloudWatch log group the awslogs driver writes container logs into. Typically the cluster's `log_group_name` output, but a service can opt into its own group when log volume warrants separate retention/lifecycle."
  type        = string
}

###############################################################################
# Network
###############################################################################

variable "vpc_id" {
  description = "ID of the VPC the service security group attaches to. Comes from the `network` module's `vpc_id` output."
  type        = string
}

variable "subnet_ids" {
  description = "List of private subnet IDs the Fargate tasks get ENIs in. Use the `network` module's `private_subnet_ids` — never `public_subnet_ids`. Tasks reach out via NAT or VPC endpoints; ALB/API GW reach in through the security-group rule wiring this module emits."
  type        = list(string)

  validation {
    condition     = length(var.subnet_ids) >= 2
    error_message = "subnet_ids must contain at least 2 subnets for AZ redundancy."
  }
}

###############################################################################
# Task shape
###############################################################################

variable "cpu" {
  description = "Fargate task-level CPU units. Must form a valid Fargate (CPU, memory) combo with var.memory — see https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-cpu-memory-error.html. Common dev value: 256 (0.25 vCPU). Bump to 512+ for the Strata service in staging/prod."
  type        = number
  default     = 256

  validation {
    condition     = contains([256, 512, 1024, 2048, 4096, 8192, 16384], var.cpu)
    error_message = "cpu must be one of 256, 512, 1024, 2048, 4096, 8192, 16384 (Fargate-supported CPU values)."
  }
}

variable "memory" {
  description = "Fargate task-level memory (MiB). Must pair with var.cpu per the Fargate CPU/memory matrix. Common defaults: cpu=256 → memory=512|1024|2048; cpu=512 → memory=1024..4096."
  type        = number
  default     = 512
}

variable "runtime_platform" {
  description = "Runtime platform for the task. `LINUX/X86_64` (default) or `LINUX/ARM64`. ARM saves ~20% on Fargate cost but requires multi-arch container images — flip only when the consumer's image is built for arm64."
  type        = string
  default     = "LINUX/X86_64"

  validation {
    condition     = contains(["LINUX/X86_64", "LINUX/ARM64"], var.runtime_platform)
    error_message = "runtime_platform must be LINUX/X86_64 or LINUX/ARM64."
  }
}

variable "containers" {
  description = <<-EOT
    List of container definitions for the task. Most services run a single container.

    Per-entry shape:
      - name              (string, required)  — container name; must be unique in the task; used by ECS Exec and load-balancer attachment.
      - image             (string, required)  — image URI (ECR or public registry).
      - essential         (bool, optional, default true) — when true, task stops if this container exits.
      - port_mappings     (list, optional)    — [{ container_port = number, protocol = "tcp"|"udp" }]
      - environment       (list, optional)    — [{ name = string, value = string }]
      - secrets           (list, optional)    — [{ name = string, value_from = "<secret-arn>" }]
                                                  Translated to ECS `secrets` (Secrets Manager / SSM Parameter Store).
      - command           (list(string), opt) — entrypoint override.
      - health_check      (object, optional)  — { command = list(string), interval = number, timeout = number, retries = number, start_period = number }
      - log_configuration (object, optional)  — { log_driver = string, options = map(string) }
                                                  When omitted, defaults to awslogs at var.log_group_name with stream prefix var.service_name.
  EOT

  type = list(object({
    name      = string
    image     = string
    essential = optional(bool, true)
    port_mappings = optional(list(object({
      container_port = number
      protocol       = optional(string, "tcp")
    })), [])
    environment = optional(list(object({
      name  = string
      value = string
    })), [])
    secrets = optional(list(object({
      name       = string
      value_from = string
    })), [])
    command = optional(list(string), null)
    health_check = optional(object({
      command      = list(string)
      interval     = optional(number, 30)
      timeout      = optional(number, 5)
      retries      = optional(number, 3)
      start_period = optional(number, 10)
    }), null)
    log_configuration = optional(object({
      log_driver = string
      options    = map(string)
    }), null)
  }))

  validation {
    condition     = length(var.containers) >= 1
    error_message = "containers must contain at least one entry."
  }
}

###############################################################################
# Capacity
###############################################################################

variable "desired_count" {
  description = "Desired running task count at deploy time. Default 1 is appropriate for dev; staging/prod should set ≥ 2 for AZ redundancy. Auto-scaling overrides this within [autoscaling_min, autoscaling_max]."
  type        = number
  default     = 1

  validation {
    condition     = var.desired_count >= 0
    error_message = "desired_count must be a non-negative integer."
  }
}

variable "capacity_provider_strategy" {
  description = "Capacity provider strategy for placing tasks. Default: 80% FARGATE_SPOT / 20% FARGATE on-demand, base 0 on both. The strategy is enforced at the service level — overriding the cluster's default. Set base > 0 on FARGATE for a guaranteed on-demand floor."
  type = list(object({
    capacity_provider = string
    weight            = number
    base              = number
  }))

  default = [
    {
      capacity_provider = "FARGATE_SPOT"
      weight            = 80
      base              = 0
    },
    {
      capacity_provider = "FARGATE"
      weight            = 20
      base              = 0
    },
  ]

  validation {
    condition = alltrue([
      for s in var.capacity_provider_strategy :
      contains(["FARGATE", "FARGATE_SPOT"], s.capacity_provider)
    ])
    error_message = "capacity_provider_strategy entries must reference FARGATE or FARGATE_SPOT only — no EC2 capacity providers in this module."
  }
}

variable "autoscaling_min" {
  description = "Minimum task count under autoscaling. Default 1; bump to 2 for prod for AZ redundancy."
  type        = number
  default     = 1
}

variable "autoscaling_max" {
  description = "Maximum task count under autoscaling. Default 3; bump higher in prod after measuring task-startup latency under load."
  type        = number
  default     = 3
}

variable "cpu_target_tracking" {
  description = "Target average CPU utilization (percent) for the CPU target-tracking autoscaling policy. Lower values scale out earlier (more headroom, more cost); 60 is a balanced default for general HTTP services."
  type        = number
  default     = 60

  validation {
    condition     = var.cpu_target_tracking > 0 && var.cpu_target_tracking <= 100
    error_message = "cpu_target_tracking must be in the range (0, 100]."
  }
}

variable "request_count_target" {
  description = "Target requests-per-target-per-minute for the ALBRequestCountPerTarget target-tracking policy. Only emitted when var.attach_to_alb_listener_arn != \"\". Default 1000 req/min/target — adjust per the service's measured cost-per-request."
  type        = number
  default     = 1000

  validation {
    condition     = var.request_count_target > 0
    error_message = "request_count_target must be > 0."
  }
}

###############################################################################
# Ingress attachment — ALB
###############################################################################

variable "attach_to_alb_listener_arn" {
  description = "ARN of an ALB HTTPS listener to attach this service to. When non-empty, the module creates a target group + listener rule pointing path/host conditions at this service's tasks. Set to `\"\"` (default) when fronting via API GW or when the service is internal-only / Service-Connect-only."
  type        = string
  default     = ""
}

variable "alb_path_patterns" {
  description = "List of path-pattern conditions for the ALB listener rule. Default `[\"/*\"]` — catch-all. Set to e.g. `[\"/api/*\", \"/health\"]` to scope. Ignored when var.attach_to_alb_listener_arn = \"\"."
  type        = list(string)
  default     = ["/*"]
}

variable "alb_host_headers" {
  description = "Optional list of host-header conditions for the ALB listener rule (host-based routing). When non-empty, both path-pattern AND host-header conditions are applied (AND, not OR — they must all match). Empty list disables host-based routing."
  type        = list(string)
  default     = []
}

variable "alb_listener_priority" {
  description = "Priority assigned to this service's ALB listener rule. ALB evaluates rules in numeric order. Caller is responsible for picking a unique priority across all services on the same listener — collisions cause apply errors."
  type        = number
  default     = 100

  validation {
    condition     = var.alb_listener_priority >= 1 && var.alb_listener_priority <= 50000
    error_message = "alb_listener_priority must be in the AWS-supported range [1, 50000]."
  }
}

variable "target_group_port" {
  description = "TCP port the ALB target group sends traffic to inside the container. Must match a port in the corresponding entry of var.containers[*].port_mappings[*].container_port. Ignored when var.attach_to_alb_listener_arn = \"\"."
  type        = number
  default     = 80
}

variable "health_check_path" {
  description = "HTTP path the ALB uses for target health checks. Should return 200 OK from a healthy task. Convention: `/health` or `/healthz`."
  type        = string
  default     = "/health"
}

variable "health_check_grace_period_seconds" {
  description = "Seconds the service ignores ALB health checks after a task is started. Useful when the container has a long warm-up. Only applies when var.attach_to_alb_listener_arn != \"\"."
  type        = number
  default     = 60
}

variable "stickiness_enabled" {
  description = "Enable target-group stickiness (lb_cookie). Off by default — Strata's HTTP API is stateless. Turn on for SSE-style sessions if the consumer can't rely on Cognito-issued tokens for affinity."
  type        = bool
  default     = false
}

variable "stickiness_duration_seconds" {
  description = "Stickiness duration in seconds when var.stickiness_enabled = true. Default 1 day."
  type        = number
  default     = 86400
}

###############################################################################
# Ingress attachment — API GW VPC link
###############################################################################

variable "attach_to_apigw_vpc_link_id" {
  description = "ID of an API GW HTTP API VPC Link to attach this service to. When non-empty, the module creates an HTTP_PROXY integration the consumer's `aws_apigatewayv2_route` resources can reference. v1 stub: the consumer supplies var.apigw_integration_uri (typically a private NLB DNS name OR a Service Connect endpoint). Routes are caller-attached — see README §\"API GW VPC-link integration\"."
  type        = string
  default     = ""
}

variable "apigw_integration_uri" {
  description = "Backend URI for the HTTP_PROXY API GW integration. Required when var.attach_to_apigw_vpc_link_id != \"\". Typically a private NLB listener URL or a Service Connect endpoint. Ignored when not attaching to API GW."
  type        = string
  default     = ""
}

variable "apigw_api_id" {
  description = "API GW HTTP API ID the integration belongs to. Required when var.attach_to_apigw_vpc_link_id != \"\" — the consumer passes the same `api_id` output emitted by the `ingress` module."
  type        = string
  default     = ""
}

###############################################################################
# Service Connect
###############################################################################

variable "service_connect_namespace_arn" {
  description = "ARN of an AWS Cloud Map namespace for Service Connect. When non-empty, the service joins the namespace and exposes/discovers peers via Service Connect. Default off — only useful in staging+ when multiple services need to reach each other internally without going through the ingress layer."
  type        = string
  default     = ""
}

variable "service_connect_config" {
  description = <<-EOT
    Service Connect configuration. Required when var.service_connect_namespace_arn != \"\".

    Shape:
      {
        services = list(object({
          port_name             = string                # logical name from task definition portMappings.name
          discovery_name        = optional(string)      # service name in Cloud Map; defaults to port_name
          ingress_port_override = optional(number)      # port on the proxy
          client_alias = list(object({
            port     = number                            # port the client uses to reach this service
            dns_name = string                            # DNS name peers use, e.g. "strata"
          }))
        }))
      }
  EOT
  type = object({
    services = list(object({
      port_name             = string
      discovery_name        = optional(string)
      ingress_port_override = optional(number)
      client_alias = list(object({
        port     = number
        dns_name = string
      }))
    }))
  })
  default = null
}

###############################################################################
# Egress (outbound from tasks)
###############################################################################

variable "allowed_egress_security_group_ids" {
  description = "List of security-group IDs the task ENIs are allowed to reach (e.g. Aurora SG, Redis SG). Each entry produces an egress rule allowing all TCP to that SG. Combined with var.allowed_egress_cidrs."
  type        = list(string)
  default     = []
}

variable "allowed_egress_cidrs" {
  description = "List of CIDR blocks the task ENIs are allowed to reach over TCP/443 (HTTPS). Default `[\"0.0.0.0/0\"]` — covers AWS APIs (via VPC endpoints when available, NAT otherwise) and external LLM/auth providers. To lock down further, pass the VPC CIDR only and rely on VPC endpoints for AWS APIs."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "vpc_cidr" {
  description = "CIDR block of the VPC. Used to emit a default egress rule allowing all TCP to the VPC interior (catches Aurora, Redis, Service Connect peers without naming each SG)."
  type        = string
}

###############################################################################
# Ingress (from non-LB sources)
###############################################################################

variable "ingress_security_group_ids" {
  description = "List of security-group IDs allowed to reach this service's tasks on the container port (the first port_mapping of the first container). Use for Service-Connect peers, internal admin tools, or other non-LB callers. The ALB SG and API-GW VPC-link SG are wired automatically when their respective `attach_to_*` vars are set — do NOT also list them here."
  type        = list(string)
  default     = []
}

variable "container_port_for_ingress" {
  description = "Container port that ingress rules (ALB target, API GW backend, ingress_security_group_ids) point at. Defaults to 80; set to your service's actual listening port. Must match a port in var.containers[*].port_mappings."
  type        = number
  default     = 80
}

###############################################################################
# IAM (task role)
###############################################################################

variable "task_role_inline_policies" {
  description = <<-EOT
    Inline policies to attach to the task role (the role the *running container* assumes via the metadata service).

    Shape: list of { name = string, policy_json = string }.

    This is the primary integration point for consumer modules — pass in the
    `consumer_iam_policy_json` outputs from `aurora-postgres`, `elasticache-redis`,
    and `secrets` to grant the task least-privilege access to those resources.
  EOT
  type = list(object({
    name        = string
    policy_json = string
  }))
  default = []
}

variable "task_role_managed_policy_arns" {
  description = "List of AWS-managed (or customer-managed) IAM policy ARNs to attach to the task role. Useful for example-agent's `arn:aws:iam::aws:policy/ReadOnlyAccess` baseline; for production services, prefer narrowly-scoped inline policies via var.task_role_inline_policies."
  type        = list(string)
  default     = []
}

variable "enable_execute_command" {
  description = "Whether ECS Exec is enabled for tasks in this service. Default true — operators run `aws ecs execute-command` against tasks for debugging. Set to false in environments where exec must be disabled (PCI scope, etc.)."
  type        = bool
  default     = true
}

###############################################################################
# Deployment
###############################################################################

variable "deployment_maximum_percent" {
  description = "Maximum percent of desired_count tasks that can run during a rolling deployment. 200 means the deploy may briefly run 2× the steady-state count. Lower this for memory-bound services where double-up overshoots Fargate quota."
  type        = number
  default     = 200
}

variable "deployment_minimum_healthy_percent" {
  description = "Minimum percent of desired_count tasks that must remain healthy during a rolling deployment. 100 means no task is stopped until its replacement is healthy — zero-downtime deploys at the cost of briefly running more tasks."
  type        = number
  default     = 100
}

###############################################################################
# Tags
###############################################################################

variable "extra_tags" {
  description = "Additional tags merged into the default tag set. Default tags: Project=strata, Component=ecs-service, ManagedBy=terraform, Environment=<env_name>, Service=<service_name>."
  type        = map(string)
  default     = {}
}
