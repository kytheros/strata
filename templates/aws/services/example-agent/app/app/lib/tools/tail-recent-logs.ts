// tail_recent_logs — CloudWatch Logs FilterLogEvents over a configurable
// log group + lookback window. Returns the last 50 events.
//
// TTL: 30s. Log queries are time-sensitive enough that 30s is the
// shortest reasonable cache; identical follow-up questions in the same
// chat turn don't re-hit the API.

import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import type { Tool } from '@anthropic-ai/sdk/resources/messages';
import type { ToolContext, ToolResult } from './context';
import { shortHash } from '../cache';
import { tailRecentLogsZod, tailRecentLogsJsonSchema } from './schemas';
import { withExamples } from './tool-examples';

const NAME = 'tail_recent_logs';

// App-layer namespace boundary. The IAM role is being tightened in
// parallel, but IAM cannot enforce namespace constraints on user-supplied
// parameters with the precision a regex can. Any log group the model
// requests must match one of these patterns or the tool refuses before
// the SDK is touched. Enumerated explicitly so a future reviewer sees
// exactly which surface is exposed to operator prompts.
const ALLOWED_LOG_GROUP_PATTERNS: RegExp[] = [
  /^\/ecs\/strata-[a-z]+$/,                       // /ecs/strata-dev
  /^\/aws\/lambda\/strata-[a-z]+-mcp-canary$/,    // canary lambda
  /^\/aws\/lambda\/strata-[a-z]+-pre-signup$/,    // cognito pre-signup trigger
  /^\/aws\/lambda\/strata-[a-z]+-post-confirmation$/, // cognito post-confirmation trigger
];

function assertAllowedLogGroup(name: string): void {
  if (!ALLOWED_LOG_GROUP_PATTERNS.some((re) => re.test(name))) {
    throw new Error(
      `Log group ${name} is outside the allowed strata-dev namespace. ` +
        `Allowed prefixes: /ecs/strata-*, /aws/lambda/strata-*-mcp-canary, ` +
        `/aws/lambda/strata-*-pre-signup, /aws/lambda/strata-*-post-confirmation.`,
    );
  }
}

export const TOOL_DEFINITION: Tool = {
  name: NAME,
  description: withExamples(
    NAME,
    `**Purpose:** Tail the most recent log events from a CloudWatch log group, optionally filtered by a CloudWatch Logs filter pattern (e.g. \`ERROR\`, \`?WARN ?error\`).
**When to use:** When investigating "what just happened" — a 500 a user reported, an alarm that just triggered, an unexpected restart. Pair with \`list_active_alarms\` (which alarm fired?) and \`list_ecs_services\` (is the service still running?). Use \`list_log_groups\` first if you don't already know which group to tail.
**Prerequisites:** None. Defaults to a curated log group prefix; pass \`logGroupName\` to override.
**Anti-pattern:** Don't use this to count occurrences over a long window — call CloudWatch Logs Insights via a different tool (not yet shipped). Don't request more than 50 events; the wrapper caps at 50 to keep the tool result token-efficient.`,
  ),
  input_schema: tailRecentLogsJsonSchema,
};

export async function execute(
  input: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = tailRecentLogsZod.parse(input ?? {});
  const logGroupName = parsed.logGroupName ?? ctx.logGroupPrefix;
  // Server-side allowlist check BEFORE cache or SDK. A prompt-injected
  // request like "tail logs from /aws/lambda/billing-service" gets
  // rejected here, not by IAM after a wasted round trip.
  assertAllowedLogGroup(logGroupName);
  const lookbackMinutes = parsed.lookbackMinutes ?? 15;
  const filterPattern = parsed.filterPattern ?? '';
  const cacheKey = `tail_recent_logs:${shortHash({ logGroupName, lookbackMinutes, filterPattern })}`;
  const cached = await ctx.cache.get<ToolResult>(cacheKey);
  if (cached) return cached;

  const startTime = Date.now() - lookbackMinutes * 60 * 1000;
  const cwl = new CloudWatchLogsClient({ region: ctx.region });
  const out = await cwl.send(
    new FilterLogEventsCommand({
      logGroupName,
      startTime,
      filterPattern: filterPattern || undefined,
      limit: 50,
    }),
  );

  const events = (out.events ?? []).map((e) => ({
    timestamp: e.timestamp ? new Date(e.timestamp).toISOString() : null,
    message: (e.message ?? '').slice(0, 500),
    logStream: e.logStreamName ?? null,
  }));

  const result: ToolResult = {
    logGroupName,
    lookbackMinutes,
    filterPattern,
    eventCount: events.length,
    events,
  };
  await ctx.cache.set(cacheKey, result, { ttlSec: 30 });
  return result;
}
