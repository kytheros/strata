output "vpc_id" {
  description = "ID of the VPC."
  value       = aws_vpc.this.id
}

output "vpc_cidr" {
  description = "CIDR block of the VPC. Useful for downstream security-group ingress rules."
  value       = aws_vpc.this.cidr_block
}

output "public_subnet_ids" {
  description = "IDs of the 3 public subnets (one per AZ). Order matches var.availability_zones."
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "IDs of the 3 private subnets (one per AZ). Order matches var.availability_zones. ECS Fargate tasks land here."
  value       = aws_subnet.private[*].id
}

output "isolated_subnet_ids" {
  description = "IDs of the 3 isolated subnets (one per AZ). Order matches var.availability_zones. Aurora and ElastiCache subnet groups consume these — no internet route."
  value       = aws_subnet.isolated[*].id
}

output "public_route_table_id" {
  description = "ID of the single public route table (0.0.0.0/0 → IGW)."
  value       = aws_route_table.public.id
}

output "private_route_table_ids" {
  description = "IDs of the 3 per-AZ private route tables. AZ-a/AZ-b route to their own NAT; AZ-c falls back to NAT-a."
  value       = aws_route_table.private[*].id
}

output "isolated_route_table_id" {
  description = "ID of the single isolated route table (no default route, gateway endpoints only)."
  value       = aws_route_table.isolated.id
}

output "internet_gateway_id" {
  description = "ID of the internet gateway."
  value       = aws_internet_gateway.this.id
}

output "nat_gateway_ids" {
  description = "IDs of the 2 NAT gateways (AZ-a and AZ-b). AZ-c traffic falls back to NAT-a — see README §'Why two NAT gateways, not three'."
  value       = aws_nat_gateway.this[*].id
}

output "nat_eip_public_ips" {
  description = "Public IPs of the NAT gateway EIPs. Useful for allowlisting outbound traffic on third-party services."
  value       = aws_eip.nat[*].public_ip
}

output "flow_log_group_name" {
  description = "Name of the CloudWatch Logs group receiving VPC flow logs."
  value       = aws_cloudwatch_log_group.flow_logs.name
}

output "flow_log_group_arn" {
  description = "ARN of the CloudWatch Logs group receiving VPC flow logs."
  value       = aws_cloudwatch_log_group.flow_logs.arn
}

output "flow_log_role_arn" {
  description = "ARN of the IAM role assumed by the VPC Flow Logs service. Scoped least-privilege to the single flow-log group above."
  value       = aws_iam_role.flow_log.arn
}

output "vpce_security_group_id" {
  description = "ID of the security group attached to all interface VPC endpoints. Ingress 443 from VPC CIDR only."
  value       = aws_security_group.vpce.id
}

output "gateway_endpoint_ids" {
  description = "Map of gateway VPC endpoint IDs by service name (s3, dynamodb)."
  value = {
    s3       = aws_vpc_endpoint.s3.id
    dynamodb = aws_vpc_endpoint.dynamodb.id
  }
}

output "interface_endpoint_ids" {
  description = "Map of interface VPC endpoint IDs by service short-name (ecr.api, ecr.dkr, secretsmanager, kms, sts, logs, ssm, cognito-idp, bedrock-runtime)."
  value       = { for k, v in aws_vpc_endpoint.interface : k => v.id }
}

output "interface_endpoint_dns_names" {
  description = "Map of interface VPC endpoint primary DNS names by service short-name. With private_dns_enabled the standard AWS service DNS already resolves to the endpoint, but these are useful for debugging."
  value       = { for k, v in aws_vpc_endpoint.interface : k => v.dns_entry[0].dns_name }
}
