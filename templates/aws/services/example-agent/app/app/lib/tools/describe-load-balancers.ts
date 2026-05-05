// describe_load_balancers — ELBv2 DescribeLoadBalancers + DescribeTargetGroups.
// Provides ALB / NLB inventory plus the target group bindings — the
// assistant can answer "what hostname routes to the strata service?" and
// "is the example-agent target group healthy?"
//
// TTL: 5 min. Load balancer config is stable; target health changes
// faster, but a 5 min stale read is acceptable for chat-grade answers.

import {
  ElasticLoadBalancingV2Client,
  DescribeLoadBalancersCommand,
  DescribeTargetGroupsCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import type { Tool } from '@anthropic-ai/sdk/resources/messages';
import type { ToolContext, ToolResult } from './context';
import { shortHash } from '../cache';

export const TOOL_DEFINITION: Tool = {
  name: 'describe_load_balancers',
  description: `**Purpose:** List ELBv2 load balancers (ALB/NLB) with their DNS names, schemes, and the target groups attached to each.
**When to use:** When the user asks about ingress, public hostnames, or which target groups exist. Pair with \`list_ecs_services\` when answering "what's reachable from the public internet?"
**Prerequisites:** None.
**Anti-pattern:** Don't use this for live traffic metrics (RPS, latency) — those are CloudWatch Metrics, not ELBv2 describe calls. Don't use it as a health probe; \`list_active_alarms\` is the canonical health-now check.`,
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
  const cacheKey = `describe_load_balancers:${shortHash({})}`;
  const cached = await ctx.cache.get<ToolResult>(cacheKey);
  if (cached) return cached;

  const elb = new ElasticLoadBalancingV2Client({ region: ctx.region });
  const [lbs, tgs] = await Promise.all([
    elb.send(new DescribeLoadBalancersCommand({})),
    elb.send(new DescribeTargetGroupsCommand({})),
  ]);

  // Index target groups by load-balancer ARN so each LB carries only its
  // own target groups in the result — keeps the per-LB summary self-contained.
  const tgByLb = new Map<string, Array<Record<string, unknown>>>();
  for (const tg of tgs.TargetGroups ?? []) {
    const summary = {
      name: tg.TargetGroupName ?? null,
      protocol: tg.Protocol ?? null,
      port: tg.Port ?? null,
      targetType: tg.TargetType ?? null,
      healthCheckPath: tg.HealthCheckPath ?? null,
    };
    for (const lbArn of tg.LoadBalancerArns ?? []) {
      if (!tgByLb.has(lbArn)) tgByLb.set(lbArn, []);
      tgByLb.get(lbArn)!.push(summary);
    }
  }

  const loadBalancers = (lbs.LoadBalancers ?? []).map((lb) => ({
    name: lb.LoadBalancerName ?? null,
    dnsName: lb.DNSName ?? null,
    scheme: lb.Scheme ?? null,
    type: lb.Type ?? null,
    state: lb.State?.Code ?? null,
    targetGroups: tgByLb.get(lb.LoadBalancerArn ?? '') ?? [],
  }));

  const result: ToolResult = {
    region: ctx.region,
    count: loadBalancers.length,
    loadBalancers,
  };
  await ctx.cache.set(cacheKey, result, { ttlSec: 300 });
  return result;
}
