// cost_last_7_days — Cost Explorer GetCostAndUsage, daily, last 7 days,
// grouped by SERVICE. Returns the total spend + the top services by
// spend.
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

export const TOOL_DEFINITION: Tool = {
  name: 'cost_last_7_days',
  description: `**Purpose:** Total AWS spend across the last 7 days (UnblendedCost), broken down by service. Returns the top 10 services by spend.
**When to use:** When the user asks about cost, spend, or "what's burning money". Cost Explorer data lags 24h, so this is a "where did money go yesterday" question, not "what is happening right now".
**Prerequisites:** Cost Explorer must be enabled at the account level (one-time opt-in). Each call costs $0.01.
**Anti-pattern:** Don't call this on every chat turn — the data only refreshes daily. The 1-hour TTL keeps repeated questions cheap. For real-time cost anomalies, set up a CloudWatch billing alarm and call \`list_active_alarms\` instead.`,
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
  const cacheKey = `cost_last_7_days:${shortHash({})}`;
  const cached = await ctx.cache.get<ToolResult>(cacheKey);
  if (cached) return cached;

  // Cost Explorer is a global API but happily accepts a region — pin to
  // us-east-1 since that's where billing data is hosted.
  const ce = new CostExplorerClient({ region: 'us-east-1' });
  const today = new Date();
  const end = today.toISOString().slice(0, 10);
  const startDate = new Date(today);
  startDate.setUTCDate(today.getUTCDate() - 7);
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
    currency: 'USD',
    total: Number(total.toFixed(4)),
    byService: sorted,
  };
  await ctx.cache.set(cacheKey, result, { ttlSec: 3600 });
  return result;
}
