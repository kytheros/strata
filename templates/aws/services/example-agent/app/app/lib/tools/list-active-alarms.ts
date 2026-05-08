// list_active_alarms — CloudWatch DescribeAlarms.
//
// Returns the smallest payload that lets the assistant answer "is anything
// on fire right now?" — name, metric, threshold, and the freeform reason
// CloudWatch records when a state transition happens.
//
// Behaviour win vs. the previous version: state filtering is now an
// optional input. The old wrapper hard-coded `StateValue: 'ALARM'`, which
// meant "list all my alarms" was unanswerable from this tool — the model
// had to invent an answer or punt to the console. Passing no `stateValue`
// now returns the full inventory. Pass `stateValue: "ALARM"` for triage,
// `stateValue: "OK"` to confirm something stopped firing, etc.
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
import {
  listActiveAlarmsZod,
  listActiveAlarmsJsonSchema,
} from './schemas';
import { withExamples } from './tool-examples';

const NAME = 'list_active_alarms';

export const TOOL_DEFINITION: Tool = {
  name: NAME,
  description: withExamples(
    NAME,
    `**Purpose:** Lists CloudWatch alarms with metric, threshold, and the latest state-transition reason. Optional filters narrow by state (ALARM/OK/INSUFFICIENT_DATA) and name prefix.
**When to use:** First call when the user asks "is anything wrong?", "any active alarms?", or "what alarms exist?" — pass \`stateValue: "ALARM"\` for triage, omit for full inventory. Also useful as a precondition before deeper drills (\`tail_recent_logs\`, \`describe_aurora_cluster\`).
**Prerequisites:** None. Reads alarms in the agent's region.
**Anti-pattern:** Don't fetch a 100-row inventory when the user asked "what's firing?" — pass \`stateValue: "ALARM"\` and a prefix to keep the payload tight.`,
  ),
  input_schema: listActiveAlarmsJsonSchema,
};

export async function execute(
  input: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = listActiveAlarmsZod.parse(input ?? {});
  const stateValue = parsed.stateValue;
  const alarmNamePrefix = parsed.alarmNamePrefix;
  const limit = parsed.limit ?? 100;

  const cacheKey = `${NAME}:${shortHash({ stateValue, alarmNamePrefix, limit })}`;
  const cached = await ctx.cache.get<ToolResult>(cacheKey);
  if (cached) return cached;

  const cw = new CloudWatchClient({ region: ctx.region });
  const out = await cw.send(
    new DescribeAlarmsCommand({
      // CloudWatch ignores StateValue when undefined → full inventory.
      ...(stateValue ? { StateValue: stateValue } : {}),
      ...(alarmNamePrefix ? { AlarmNamePrefix: alarmNamePrefix } : {}),
      MaxRecords: limit,
    }),
  );
  const alarms = (out.MetricAlarms ?? []).map((a) => ({
    name: a.AlarmName ?? null,
    state: a.StateValue ?? null,
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
    stateFilter: stateValue ?? 'ANY',
    namePrefix: alarmNamePrefix ?? null,
    activeCount: alarms.filter((a) => a.state === 'ALARM').length,
    totalCount: alarms.length,
    alarms,
  };
  await ctx.cache.set(cacheKey, result, { ttlSec: 60 });
  return result;
}
