// describe_aurora_cluster — RDS DescribeDBClusters for the strata-{env}
// Aurora Serverless v2 cluster. Returns the fields a chat user actually
// asks about: status, endpoint, engine version, current capacity,
// retention, encryption posture.
//
// TTL: 5 min. ACU autoscaling happens on the order of seconds, but the
// chat-relevant capacity is "where are we sitting now" — 5 min is fine.

import { RDSClient, DescribeDBClustersCommand } from '@aws-sdk/client-rds';
import type { Tool } from '@anthropic-ai/sdk/resources/messages';
import type { ToolContext, ToolResult } from './context';
import { shortHash } from '../cache';
import {
  describeAuroraClusterZod,
  describeAuroraClusterJsonSchema,
} from './schemas';
import { withExamples } from './tool-examples';

const NAME = 'describe_aurora_cluster';

// App-layer namespace boundary. Aurora cluster identifiers in this
// account always match `strata-<env>`. A prompt-injected `clusterId`
// referencing some other cluster (e.g. a tenant DB elsewhere in the
// account) is rejected before the RDS SDK call.
const ALLOWED_CLUSTER_ID_PATTERN = /^strata-[a-z0-9-]+$/;

function assertAllowedClusterId(id: string): void {
  if (!ALLOWED_CLUSTER_ID_PATTERN.test(id)) {
    throw new Error(
      `Cluster ${id} is outside the allowed strata-* namespace. ` +
        `Allowed pattern: strata-<env>.`,
    );
  }
}

export const TOOL_DEFINITION: Tool = {
  name: NAME,
  description: withExamples(
    NAME,
    `**Purpose:** Describe the deploy's Aurora Postgres Serverless v2 cluster — status, endpoints, engine version, current ACU capacity, backup retention, encryption.
**When to use:** When the user asks how the database is doing, whether it's available, or about its scaling/backup posture. Also pair with \`list_active_alarms\` when investigating a database-related incident.
**Prerequisites:** None. Defaults to the agent's own cluster ID (\`AURORA_CLUSTER_ID\` env, default \`strata-{env}\`).
**Anti-pattern:** Don't use this for query-level metrics — those are not in DescribeDBClusters; query Performance Insights via the CloudWatch tools instead.`,
  ),
  input_schema: describeAuroraClusterJsonSchema,
};

export async function execute(
  input: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = describeAuroraClusterZod.parse(input ?? {});
  const clusterId = parsed.clusterId ?? ctx.auroraClusterId;
  // Server-side allowlist check BEFORE cache or SDK. The model can ask
  // for any cluster string; we only let through strata-* identifiers.
  assertAllowedClusterId(clusterId);
  const cacheKey = `describe_aurora_cluster:${shortHash({ clusterId })}`;
  const cached = await ctx.cache.get<ToolResult>(cacheKey);
  if (cached) return cached;

  const rds = new RDSClient({ region: ctx.region });
  const out = await rds.send(
    new DescribeDBClustersCommand({ DBClusterIdentifier: clusterId }),
  );
  const cluster = out.DBClusters?.[0];
  if (!cluster) {
    const result: ToolResult = { clusterId, found: false };
    await ctx.cache.set(cacheKey, result, { ttlSec: 300 });
    return result;
  }

  const result: ToolResult = {
    clusterId,
    found: true,
    status: cluster.Status ?? null,
    engine: cluster.Engine ?? null,
    engineVersion: cluster.EngineVersion ?? null,
    endpoint: cluster.Endpoint ?? null,
    readerEndpoint: cluster.ReaderEndpoint ?? null,
    serverlessV2: cluster.ServerlessV2ScalingConfiguration
      ? {
          minCapacity: cluster.ServerlessV2ScalingConfiguration.MinCapacity ?? null,
          maxCapacity: cluster.ServerlessV2ScalingConfiguration.MaxCapacity ?? null,
        }
      : null,
    currentCapacity: cluster.Capacity ?? null,
    backupRetentionDays: cluster.BackupRetentionPeriod ?? null,
    storageEncrypted: cluster.StorageEncrypted ?? null,
    deletionProtection: cluster.DeletionProtection ?? null,
    multiAz: cluster.MultiAZ ?? null,
  };
  await ctx.cache.set(cacheKey, result, { ttlSec: 300 });
  return result;
}
