// Tool registry. The agent loop imports `TOOLS` (Anthropic tool
// definitions) and `executeTool` (dispatcher). Each tool module exports
// its own TOOL_DEFINITION + execute(); this file is just the wiring.

import type { Tool } from '@anthropic-ai/sdk/resources/messages';
import type { ToolContext, ToolResult } from './context';

import * as whoAmI from './who-am-i';
import * as listEcsServices from './list-ecs-services';
import * as describeAuroraCluster from './describe-aurora-cluster';
import * as listActiveAlarms from './list-active-alarms';
import * as tailRecentLogs from './tail-recent-logs';
import * as listLogGroups from './list-log-groups';
import * as listVpcResources from './list-vpc-resources';
import * as describeLoadBalancers from './describe-load-balancers';
import * as s3BucketSummary from './s3-bucket-summary';
import * as costLast7Days from './cost-last-7-days';
import * as infrastructureTopology from './infrastructure-topology';

type ToolModule = {
  TOOL_DEFINITION: Tool;
  execute: (input: any, ctx: ToolContext) => Promise<ToolResult>;
};

const REGISTRY: Record<string, ToolModule> = {
  who_am_i: whoAmI,
  list_ecs_services: listEcsServices,
  describe_aurora_cluster: describeAuroraCluster,
  list_active_alarms: listActiveAlarms,
  tail_recent_logs: tailRecentLogs,
  list_log_groups: listLogGroups,
  list_vpc_resources: listVpcResources,
  describe_load_balancers: describeLoadBalancers,
  s3_bucket_summary: s3BucketSummary,
  cost_last_7_days: costLast7Days,
  infrastructure_topology: infrastructureTopology,
};

export const TOOLS: Tool[] = Object.values(REGISTRY).map(
  (m) => m.TOOL_DEFINITION,
);

export async function executeTool(
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const mod = REGISTRY[name];
  if (!mod) {
    return { error: `Unknown tool: ${name}` };
  }
  try {
    return await mod.execute(input ?? {}, ctx);
  } catch (err) {
    // Surface the error to the model rather than throwing — the model
    // can decide whether to retry, fall back to a different tool, or
    // tell the user. Don't leak SDK internals; use the error name+message.
    const e = err as Error;
    return {
      error: e.name ?? 'Error',
      message: e.message ?? String(e),
    };
  }
}

export type { ToolContext, ToolResult };
