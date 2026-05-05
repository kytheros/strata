// Shared context object every tool wrapper receives.
//
// `region` and `clusterName` come from container env vars set by the ECS
// task definition. `cache` is a Redis-backed (or in-memory, in tests) LRU
// for per-tool TTLs. Tools should never reach out to `process.env`
// directly — that breaks unit-testability and hides which env vars each
// tool relies on. All env reads go here.

import type { ToolCache, InMemoryToolCache } from '../cache';

export interface ToolContext {
  // AWS region. Defaults to AWS_REGION env, then us-east-1.
  region: string;
  // The ECS cluster name the example-agent runs in (e.g. strata-dev).
  // The list_ecs_services and infrastructure_topology tools default to
  // this cluster when no override is given.
  clusterName: string;
  // The Aurora cluster identifier (e.g. strata-dev). describe_aurora_cluster
  // looks this up directly when no override is provided.
  auroraClusterId: string;
  // Curated CloudWatch log group prefix for tail_recent_logs default.
  logGroupPrefix: string;
  // Cache wrapper — Redis-backed in production, in-memory in tests.
  cache: ToolCache | InMemoryToolCache;
}

export function buildDefaultContext(
  cache: ToolCache | InMemoryToolCache,
): ToolContext {
  const region = process.env.AWS_REGION ?? 'us-east-1';
  const env = process.env.ENV_NAME ?? 'dev';
  return {
    region,
    clusterName: process.env.ECS_CLUSTER_NAME ?? `strata-${env}`,
    auroraClusterId: process.env.AURORA_CLUSTER_ID ?? `strata-${env}`,
    logGroupPrefix: process.env.LOG_GROUP_PREFIX ?? `/ecs/strata-${env}`,
    cache,
  };
}

// Common envelope every tool returns. The agent loop stringifies this for
// the `tool_result` content block.
export type ToolResult = Record<string, unknown>;
