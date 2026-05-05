// infrastructure_topology — meta-tool. Composes results from
// list_vpc_resources, list_ecs_services, describe_aurora_cluster, and
// describe_load_balancers into a single summary. The model can call this
// once instead of four times when the user asks "give me the lay of the
// land".
//
// TTL: 5 min. Each underlying tool has its own TTL; this composite key
// caches the post-processing too.

import type { Tool } from '@anthropic-ai/sdk/resources/messages';
import type { ToolContext, ToolResult } from './context';
import { shortHash } from '../cache';
import { execute as listVpcResources } from './list-vpc-resources';
import { execute as listEcsServices } from './list-ecs-services';
import { execute as describeAuroraCluster } from './describe-aurora-cluster';
import { execute as describeLoadBalancers } from './describe-load-balancers';

export const TOOL_DEFINITION: Tool = {
  name: 'infrastructure_topology',
  description: `**Purpose:** One-call snapshot of the deploy's infrastructure: VPC + subnets, running ECS services, Aurora cluster status, and load balancers. Composes four other tools into a single summary.
**When to use:** When the user asks an open-ended "describe the deployment" or "what's running?" question. Strongly prefer this over making four separate calls — same cost (each underlying call is independently cached) but cleaner conversation.
**Prerequisites:** None. Inherits caches and TTLs from the underlying tools.
**Anti-pattern:** Don't use this when the user wants a specific drill-down (e.g. just the alarms, just the cost) — those have dedicated tools and are cheaper. This is the "give me everything" tool.`,
  input_schema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
};

export async function execute(
  _input: Record<string, never>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const cacheKey = `infrastructure_topology:${shortHash({ region: ctx.region, cluster: ctx.clusterName })}`;
  const cached = await ctx.cache.get<ToolResult>(cacheKey);
  if (cached) return cached;

  // Run the four underlying calls in parallel — each one is independently
  // cached, so a warm-cache invocation here is essentially free.
  const [vpc, ecs, aurora, lbs] = await Promise.all([
    listVpcResources({}, ctx),
    listEcsServices({}, ctx),
    describeAuroraCluster({}, ctx),
    describeLoadBalancers({}, ctx),
  ]);

  const result: ToolResult = {
    region: ctx.region,
    cluster: ctx.clusterName,
    vpc: {
      vpcCount: Array.isArray((vpc as any).vpcs) ? (vpc as any).vpcs.length : 0,
      subnetCount: Array.isArray((vpc as any).subnets) ? (vpc as any).subnets.length : 0,
      natGatewayCount: Array.isArray((vpc as any).natGateways) ? (vpc as any).natGateways.length : 0,
      vpcEndpointCount: Array.isArray((vpc as any).vpcEndpoints) ? (vpc as any).vpcEndpoints.length : 0,
    },
    ecs: {
      serviceCount: Array.isArray((ecs as any).services) ? (ecs as any).services.length : 0,
      services: (ecs as any).services ?? [],
    },
    aurora,
    loadBalancers: {
      count: (lbs as any).count ?? 0,
      summary: ((lbs as any).loadBalancers ?? []).map((lb: any) => ({
        name: lb.name,
        scheme: lb.scheme,
        state: lb.state,
      })),
    },
  };
  await ctx.cache.set(cacheKey, result, { ttlSec: 300 });
  return result;
}
