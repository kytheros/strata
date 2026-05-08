// list_ecs_services — enumerate services in the strata-{env} cluster and
// summarize task counts + status. Two-phase: ListServices then
// DescribeServices (the only API path that returns running/desired
// counts).
//
// TTL: 60s. Service deployments are infrequent at the agent's chat
// cadence; a 60s window keeps "are tasks running" answers fresh enough
// for an investigation without hammering the control plane.

import {
  ECSClient,
  ListServicesCommand,
  DescribeServicesCommand,
} from '@aws-sdk/client-ecs';
import type { Tool } from '@anthropic-ai/sdk/resources/messages';
import type { ToolContext, ToolResult } from './context';
import { shortHash } from '../cache';
import { listEcsServicesZod, listEcsServicesJsonSchema } from './schemas';
import { withExamples } from './tool-examples';

const NAME = 'list_ecs_services';

// App-layer namespace boundary. ECS cluster names in this account always
// match `strata-<env>`. Reject any other cluster the model proposes
// before the SDK is touched.
const ALLOWED_CLUSTER_NAME_PATTERN = /^strata-[a-z0-9-]+$/;

function assertAllowedClusterName(name: string): void {
  if (!ALLOWED_CLUSTER_NAME_PATTERN.test(name)) {
    throw new Error(
      `Cluster ${name} is outside the allowed strata-* namespace. ` +
        `Allowed pattern: strata-<env>.`,
    );
  }
}

export const TOOL_DEFINITION: Tool = {
  name: NAME,
  description: withExamples(
    NAME,
    `**Purpose:** Lists ECS services in the deploy's primary cluster with running/desired task counts and deployment status.
**When to use:** When the user asks how many services are running, whether the strata service is healthy, or to confirm the example-agent itself is the only thing running. Also useful as a precondition check before tools that depend on a service being up (e.g. before calling \`describe_load_balancers\`).
**Prerequisites:** None. Reads the cluster passed in via container env (\`ECS_CLUSTER_NAME\`, default \`strata-{env}\`).
**Anti-pattern:** Don't use this for live request metrics — call \`describe_load_balancers\` for traffic data, or \`tail_recent_logs\` for application-level signal.`,
  ),
  input_schema: listEcsServicesJsonSchema,
};

export async function execute(
  input: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = listEcsServicesZod.parse(input ?? {});
  const cluster = parsed.cluster ?? ctx.clusterName;
  assertAllowedClusterName(cluster);
  const cacheKey = `list_ecs_services:${shortHash({ cluster })}`;
  const cached = await ctx.cache.get<ToolResult>(cacheKey);
  if (cached) return cached;

  const ecs = new ECSClient({ region: ctx.region });
  const list = await ecs.send(new ListServicesCommand({ cluster, maxResults: 100 }));
  const arns = list.serviceArns ?? [];
  if (arns.length === 0) {
    const empty: ToolResult = { cluster, services: [] };
    await ctx.cache.set(cacheKey, empty, { ttlSec: 60 });
    return empty;
  }
  const desc = await ecs.send(
    new DescribeServicesCommand({ cluster, services: arns }),
  );
  const services = (desc.services ?? []).map((s) => ({
    name: s.serviceName ?? null,
    runningCount: s.runningCount ?? 0,
    desiredCount: s.desiredCount ?? 0,
    pendingCount: s.pendingCount ?? 0,
    status: s.status ?? null,
    launchType: s.launchType ?? null,
    deploymentStatus:
      s.deployments && s.deployments[0]
        ? s.deployments[0].rolloutState ?? null
        : null,
  }));
  const result: ToolResult = { cluster, services };
  await ctx.cache.set(cacheKey, result, { ttlSec: 60 });
  return result;
}
