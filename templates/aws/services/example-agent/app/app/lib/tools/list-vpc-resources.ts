// list_vpc_resources — parallel calls to EC2 DescribeVpcs / DescribeSubnets
// / DescribeNatGateways / DescribeVpcEndpoints. Returns a single
// topology summary the assistant can quote.
//
// TTL: 5 min. VPC topology rarely changes between chat turns; refreshing
// every 5 min is more than enough.

import {
  EC2Client,
  DescribeVpcsCommand,
  DescribeSubnetsCommand,
  DescribeNatGatewaysCommand,
  DescribeVpcEndpointsCommand,
} from '@aws-sdk/client-ec2';
import type { Tool } from '@anthropic-ai/sdk/resources/messages';
import type { ToolContext, ToolResult } from './context';
import { shortHash } from '../cache';
import { listVpcResourcesZod, listVpcResourcesJsonSchema } from './schemas';
import { withExamples } from './tool-examples';

const NAME = 'list_vpc_resources';

export const TOOL_DEFINITION: Tool = {
  name: NAME,
  description: withExamples(
    NAME,
    `**Purpose:** Summarize the VPC topology — VPCs, subnets (per-AZ + tier), NAT gateways, and VPC endpoints — in the agent's region.
**When to use:** When the user asks about network architecture, subnet layout, NAT cost posture, or which AWS services have private endpoints. Also a precondition for cost-related questions about NAT data-processing.
**Prerequisites:** None.
**Anti-pattern:** Don't use this for routing-table investigations — those need DescribeRouteTables (not yet shipped). For traffic flow questions, also call \`describe_load_balancers\`.`,
  ),
  input_schema: listVpcResourcesJsonSchema,
};

export async function execute(
  input: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  listVpcResourcesZod.parse(input ?? {});
  const cacheKey = `list_vpc_resources:${shortHash({})}`;
  const cached = await ctx.cache.get<ToolResult>(cacheKey);
  if (cached) return cached;

  const ec2 = new EC2Client({ region: ctx.region });
  const [vpcs, subnets, nats, endpoints] = await Promise.all([
    ec2.send(new DescribeVpcsCommand({})),
    ec2.send(new DescribeSubnetsCommand({})),
    ec2.send(new DescribeNatGatewaysCommand({})),
    ec2.send(new DescribeVpcEndpointsCommand({})),
  ]);

  const result: ToolResult = {
    region: ctx.region,
    vpcs: (vpcs.Vpcs ?? []).map((v) => ({
      id: v.VpcId ?? null,
      cidr: v.CidrBlock ?? null,
      isDefault: v.IsDefault ?? null,
    })),
    subnets: (subnets.Subnets ?? []).map((s) => ({
      id: s.SubnetId ?? null,
      vpcId: s.VpcId ?? null,
      az: s.AvailabilityZone ?? null,
      cidr: s.CidrBlock ?? null,
      mapPublicIp: s.MapPublicIpOnLaunch ?? null,
    })),
    natGateways: (nats.NatGateways ?? []).map((n) => ({
      id: n.NatGatewayId ?? null,
      state: n.State ?? null,
      subnetId: n.SubnetId ?? null,
      vpcId: n.VpcId ?? null,
    })),
    vpcEndpoints: (endpoints.VpcEndpoints ?? []).map((e) => ({
      id: e.VpcEndpointId ?? null,
      service: e.ServiceName ?? null,
      type: e.VpcEndpointType ?? null,
      state: e.State ?? null,
    })),
  };
  await ctx.cache.set(cacheKey, result, { ttlSec: 300 });
  return result;
}
