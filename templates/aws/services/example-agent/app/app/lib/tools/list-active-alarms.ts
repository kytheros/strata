// list_active_alarms — CloudWatch DescribeAlarms filtered to ALARM state.
//
// Returns the smallest payload that lets the assistant answer "is anything
// on fire right now?" — name, metric, threshold, and the freeform reason
// CloudWatch records when a state transition happens.
//
// TTL: 60s. Alarm state transitions take a minute or so to propagate;
// shorter TTLs would spam DescribeAlarms without practical benefit.

import {
  CloudWatchClient,
  DescribeAlarmsCommand,
} from '@aws-sdk/client-cloudwatch';
import type { Tool } from '@anthropic-ai/sdk/resources/messages';
import type { ToolContext, ToolResult } from './context';
import { shortHash } from '../cache';

export const TOOL_DEFINITION: Tool = {
  name: 'list_active_alarms',
  description: `**Purpose:** Lists every CloudWatch alarm currently in the ALARM state, with metric, threshold, and the latest state-transition reason.
**When to use:** First call when the user asks "is anything wrong?", "any active alarms?", or to triage at the start of an investigation. Also useful as a precondition before deeper drills (\`tail_recent_logs\`, \`describe_aurora_cluster\`).
**Prerequisites:** None. Reads alarms in the agent's region.
**Anti-pattern:** Don't use this to enumerate all alarms — it filters to ALARM state. Use the AWS console or a separate \`describe_all_alarms\` tool (not yet shipped) when you need the full inventory.`,
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
  const cacheKey = `list_active_alarms:${shortHash({})}`;
  const cached = await ctx.cache.get<ToolResult>(cacheKey);
  if (cached) return cached;

  const cw = new CloudWatchClient({ region: ctx.region });
  const out = await cw.send(
    new DescribeAlarmsCommand({ StateValue: 'ALARM', MaxRecords: 100 }),
  );
  const alarms = (out.MetricAlarms ?? []).map((a) => ({
    name: a.AlarmName ?? null,
    metric: a.MetricName ?? null,
    namespace: a.Namespace ?? null,
    threshold: a.Threshold ?? null,
    comparison: a.ComparisonOperator ?? null,
    reason: a.StateReason ?? null,
    sinceUtc: a.StateUpdatedTimestamp
      ? a.StateUpdatedTimestamp.toISOString()
      : null,
  }));
  const result: ToolResult = {
    region: ctx.region,
    activeCount: alarms.length,
    alarms,
  };
  await ctx.cache.set(cacheKey, result, { ttlSec: 60 });
  return result;
}
