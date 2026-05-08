// cost_last_7_days — Cost Explorer GetCostAndUsage, daily, configurable
// lookback (default 7 days), grouped by SERVICE. Returns the total spend
// + the top services by spend.
//
// Behaviour win vs. the previous version: lookback was hard-coded to 7
// days. Operators routinely ask "what did we spend last month?" — that's
// now answerable from the same tool by passing `days: 30` instead of
// either inventing a sibling tool or punting. Hard cap at 30 days because
// Cost Explorer charges per query and longer windows take longer to
// return; if the operator wants a quarter, they can run three calls.
//
// TTL: 1 hour. Cost Explorer data lags ~24h anyway — refreshing every
// hour is more than enough to feel "live" without burning $0.01 per
// API call (yes, Cost Explorer charges per query).

import {
  CostExplorerClient,
  GetCostAndUsageCommand,
} from '@aws-sdk/client-cost-explorer';
import type { Tool } from '@anthropic-ai/sdk/resources/messages';
import type { ToolContext, ToolResult } from './context';
import { shortHash } from '../cache';
import { costLastNDaysZod, costLastNDaysJsonSchema } from './schemas';
import { withExamples } from './tool-examples';

const NAME = 'cost_last_7_days';

export const TOOL_DEFINITION: Tool = {
  name: NAME,
  description: withExamples(
    NAME,
    `**Purpose:** Total AWS spend across the last N days (UnblendedCost), broken down by service. Returns the top 10 services by spend. Default window 7 days; pass \`days: 30\` to see "last month".
**When to use:** When the user asks about cost, spend, or "what's burning money". Cost Explorer data lags 24h, so this is a "where did money go yesterday" question, not "what is happening right now".
**Prerequisites:** Cost Explorer must be enabled at the account level (one-time opt-in). Each call costs $0.01.
**Anti-pattern:** Don't call this on every chat turn — the data only refreshes daily. The 1-hour TTL keeps repeated questions cheap. For real-time cost anomalies, set up a CloudWatch billing alarm and call \`list_active_alarms\` instead.`,
  ),
  input_schema: costLastNDaysJsonSchema,
};

export async function execute(
  input: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = costLastNDaysZod.parse(input ?? {});
  const days = parsed.days ?? 7;

  const cacheKey = `${NAME}:${shortHash({ days })}`;
  const cached = await ctx.cache.get<ToolResult>(cacheKey);
  if (cached) return cached;

  // Cost Explorer is a global API but happily accepts a region — pin to
  // us-east-1 since that's where billing data is hosted.
  const ce = new CostExplorerClient({ region: 'us-east-1' });
  const today = new Date();
  const end = today.toISOString().slice(0, 10);
  const startDate = new Date(today);
  startDate.setUTCDate(today.getUTCDate() - days);
  const start = startDate.toISOString().slice(0, 10);

  const out = await ce.send(
    new GetCostAndUsageCommand({
      TimePeriod: { Start: start, End: end },
      Granularity: 'DAILY',
      Metrics: ['UnblendedCost'],
      GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
      Filter: {
        Not: {
          Dimensions: {
            Key: 'RECORD_TYPE',
            Values: ['Credit', 'Refund'],
          },
        },
      },
    }),
  );

  // Aggregate across days into per-service totals.
  const byService = new Map<string, number>();
  for (const day of out.ResultsByTime ?? []) {
    for (const grp of day.Groups ?? []) {
      const svc = grp.Keys?.[0] ?? 'Unknown';
      const amt = parseFloat(grp.Metrics?.UnblendedCost?.Amount ?? '0');
      byService.set(svc, (byService.get(svc) ?? 0) + amt);
    }
  }
  const sorted = [...byService.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([service, amount]) => ({ service, amount: Number(amount.toFixed(4)) }));

  const total = [...byService.values()].reduce((a, b) => a + b, 0);
  const result: ToolResult = {
    periodStart: start,
    periodEnd: end,
    days,
    currency: 'USD',
    total: Number(total.toFixed(4)),
    byService: sorted,
  };
  await ctx.cache.set(cacheKey, result, { ttlSec: 3600 });
  return result;
}
