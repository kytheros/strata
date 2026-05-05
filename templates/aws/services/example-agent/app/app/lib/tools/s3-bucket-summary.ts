// s3_bucket_summary — ListBuckets + per-bucket HeadBucket +
// GetBucketEncryption. Returns name + region + encryption posture per
// bucket. Bucket size requires CloudWatch metrics; we keep this tool
// scoped to inventory + encryption.
//
// TTL: 1 hour. Bucket inventory is among the most stable AWS resources
// for the agent's purposes.

import {
  S3Client,
  ListBucketsCommand,
  GetBucketEncryptionCommand,
  GetBucketLocationCommand,
} from '@aws-sdk/client-s3';
import type { Tool } from '@anthropic-ai/sdk/resources/messages';
import type { ToolContext, ToolResult } from './context';
import { shortHash } from '../cache';

export const TOOL_DEFINITION: Tool = {
  name: 's3_bucket_summary',
  description: `**Purpose:** List S3 buckets in the account with their region and at-rest encryption posture.
**When to use:** When the user asks about S3 inventory, encryption coverage, or which buckets belong to the deploy. Pair with \`who_am_i\` if you need to confirm the account scope first.
**Prerequisites:** None. Requires \`s3:ListAllMyBuckets\` (granted by \`ReadOnlyAccess\`) and per-bucket \`s3:GetEncryptionConfiguration\`.
**Anti-pattern:** Don't use this for object listings or bucket sizes — those are different APIs (ListObjects, CloudWatch BucketSizeBytes). The summary intentionally omits object-count to stay token-efficient.`,
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
  const cacheKey = `s3_bucket_summary:${shortHash({})}`;
  const cached = await ctx.cache.get<ToolResult>(cacheKey);
  if (cached) return cached;

  const s3 = new S3Client({ region: ctx.region });
  const list = await s3.send(new ListBucketsCommand({}));
  const buckets = list.Buckets ?? [];

  const summaries = await Promise.all(
    buckets.map(async (b) => {
      const name = b.Name ?? '';
      let region: string | null = null;
      let encryption: string | null = null;
      try {
        const loc = await s3.send(new GetBucketLocationCommand({ Bucket: name }));
        // S3 quirk: us-east-1 buckets return null/empty.
        region = (loc.LocationConstraint as string | undefined) ?? 'us-east-1';
      } catch {
        region = null;
      }
      try {
        const enc = await s3.send(
          new GetBucketEncryptionCommand({ Bucket: name }),
        );
        const rule =
          enc.ServerSideEncryptionConfiguration?.Rules?.[0]?.ApplyServerSideEncryptionByDefault;
        encryption = rule?.SSEAlgorithm ?? null;
      } catch {
        encryption = 'unconfigured';
      }
      return { name, region, encryption, createdUtc: b.CreationDate?.toISOString() ?? null };
    }),
  );

  const result: ToolResult = { count: summaries.length, buckets: summaries };
  await ctx.cache.set(cacheKey, result, { ttlSec: 3600 });
  return result;
}
