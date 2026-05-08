// list_log_groups — CloudWatch Logs DescribeLogGroups, filtered to the
// strata-* allowlist this deploy exposes to the model.
//
// Why this tool exists: previously the model had to guess log-group
// names from the system prompt's allowlist documentation. If the
// operator asked "tail the canary lambda" and the model picked the
// wrong path shape, `tail_recent_logs` errored without a recoverable
// next step. With `list_log_groups` the model can enumerate the actual
// groups it's allowed to read, then call `tail_recent_logs` on a
// concrete name. Closes the loop.
//
// Behaviour: even if CloudWatch returns groups outside the strata-*
// allowlist (DescribeLogGroups doesn't enforce our app-layer policy),
// we filter them out before returning. The model never sees a path it
// can't act on.
//
// TTL: 5 min. Log groups don't churn on a chat-turn cadence.

import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import type { Tool } from '@anthropic-ai/sdk/resources/messages';
import type { ToolContext, ToolResult } from './context';
import { shortHash } from '../cache';
import { listLogGroupsZod, listLogGroupsJsonSchema } from './schemas';
import { withExamples } from './tool-examples';

const NAME = 'list_log_groups';

// Mirrors the allowlist in tail-recent-logs.ts. Kept duplicated rather
// than shared because the tail tool needs single-name validation
// (regex match on a specific input) while this tool needs prefix
// awareness (filter the SDK output). If we add a 5th log-group consumer
// we can refactor; not yet.
const ALLOWED_PREFIXES: RegExp[] = [
  /^\/ecs\/strata-[a-z]+$/,
  /^\/aws\/lambda\/strata-[a-z]+-mcp-canary$/,
  /^\/aws\/lambda\/strata-[a-z]+-pre-signup$/,
  /^\/aws\/lambda\/strata-[a-z]+-post-confirmation$/,
];

function isAllowed(name: string): boolean {
  return ALLOWED_PREFIXES.some((re) => re.test(name));
}

export const TOOL_DEFINITION: Tool = {
  name: NAME,
  description: withExamples(
    NAME,
    `**Purpose:** Enumerate the CloudWatch log groups this deploy exposes to the agent (the strata-* allowlist). Returns name, retention days, and stored-bytes per group.
**When to use:** Before \`tail_recent_logs\` if you don't already know the exact group name to read. Pair with \`list_active_alarms\` when you have an alarm naming a service and need the matching log group.
**Prerequisites:** None.
**Anti-pattern:** Don't call this just to confirm a group exists — pass the name to \`tail_recent_logs\` directly; it will reject unknown names server-side. Don't expect to see groups outside the strata-* allowlist; they're filtered out even if CloudWatch returns them.`,
  ),
  input_schema: listLogGroupsJsonSchema,
};

export async function execute(
  input: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = listLogGroupsZod.parse(input ?? {});
  const namePrefix = parsed.namePrefix;
  const limit = parsed.limit ?? 50;

  const cacheKey = `${NAME}:${shortHash({ namePrefix, limit })}`;
  const cached = await ctx.cache.get<ToolResult>(cacheKey);
  if (cached) return cached;

  const cwl = new CloudWatchLogsClient({ region: ctx.region });
  const out = await cwl.send(
    new DescribeLogGroupsCommand({
      // CloudWatch happily filters server-side; saves bytes when the
      // model already has a hint (e.g. "/aws/lambda/strata-").
      ...(namePrefix ? { logGroupNamePrefix: namePrefix } : {}),
      limit,
    }),
  );

  const groups = (out.logGroups ?? [])
    .map((g) => ({
      name: g.logGroupName ?? null,
      retentionDays: g.retentionInDays ?? null,
      storedBytes: g.storedBytes ?? null,
      createdUtc: g.creationTime
        ? new Date(g.creationTime).toISOString()
        : null,
    }))
    .filter(
      (g): g is { name: string; retentionDays: number | null; storedBytes: number | null; createdUtc: string | null } =>
        typeof g.name === 'string' && isAllowed(g.name),
    );

  const result: ToolResult = {
    region: ctx.region,
    namePrefix: namePrefix ?? null,
    count: groups.length,
    logGroups: groups,
  };
  await ctx.cache.set(cacheKey, result, { ttlSec: 300 });
  return result;
}
