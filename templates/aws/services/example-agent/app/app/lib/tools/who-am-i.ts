// who_am_i — STS GetCallerIdentity. Identity check primarily; lets the
// chat assistant ground its responses ("I am running as the
// example-agent task role in account 6249…").
//
// TTL: 1 hour. STS identity for a Fargate task role does not change
// during the task's lifetime — only a deploy can rotate it.

import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import type { Tool } from '@anthropic-ai/sdk/resources/messages';
import type { ToolContext, ToolResult } from './context';
import { shortHash } from '../cache';
import { whoAmIZod, whoAmIJsonSchema } from './schemas';
import { withExamples } from './tool-examples';

const NAME = 'who_am_i';

export const TOOL_DEFINITION: Tool = {
  name: NAME,
  description: withExamples(
    NAME,
    `**Purpose:** Resolve the AWS identity (account ID, IAM role ARN, region) the agent is running under.
**When to use:** When the user asks "what account / role / region are you in?", or as a sanity check before a multi-call investigation so subsequent answers can scope to the right account.
**Prerequisites:** None — this is the canonical no-input call.
**Anti-pattern:** Don't call this on every turn. The result is stable for the task's lifetime; use cached output instead of forcing a refetch.`,
  ),
  input_schema: whoAmIJsonSchema,
};

export async function execute(
  input: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  whoAmIZod.parse(input ?? {});
  const cacheKey = `who_am_i:${shortHash({})}`;
  const cached = await ctx.cache.get<ToolResult>(cacheKey);
  if (cached) return cached;

  const sts = new STSClient({ region: ctx.region });
  const out = await sts.send(new GetCallerIdentityCommand({}));

  const result: ToolResult = {
    accountId: out.Account ?? null,
    userArn: out.Arn ?? null,
    userId: out.UserId ?? null,
    region: ctx.region,
  };
  await ctx.cache.set(cacheKey, result, { ttlSec: 3600 });
  return result;
}
