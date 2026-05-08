// Tool input schemas — Zod (runtime validation) + JSON Schema (Anthropic
// tool definition) side-by-side.
//
// Why both shapes hand-written rather than zod-to-json-schema:
// - Schemas are small (≤6 fields per tool). The duplication cost is one
//   extra block per tool; the dependency cost of zod-to-json-schema is a
//   transitive supply-chain surface for a benefit we don't need.
// - The JSON Schema shape we ship to Anthropic must stay 1:1 with the
//   format the Messages API expects. Hand-writing it keeps that contract
//   visible at the file level instead of trusting a converter.
// - Zod still earns its keep at runtime: every tool's `execute()` calls
//   `schema.parse()` to enforce types + ranges before any AWS SDK call.
//
// Pattern per tool: `${name}Zod` + `${name}JsonSchema`. Keep descriptions
// in sync between the two by reading from a single source of truth string
// where the duplication is annoying enough to warrant it; otherwise just
// keep the strings identical and rely on review to catch drift.

import { z } from 'zod';
import type { Tool } from '@anthropic-ai/sdk/resources/messages';

// JSON Schema shape Anthropic accepts. Narrow to the input_schema field of
// the SDK's Tool type so a typo here surfaces at compile time.
type InputSchema = Tool['input_schema'];

// ────────────────────────────────────────────────────────────────────────
// who_am_i — no inputs.
// ────────────────────────────────────────────────────────────────────────

export const whoAmIZod = z.object({}).strict();

export const whoAmIJsonSchema: InputSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

// ────────────────────────────────────────────────────────────────────────
// list_ecs_services
// ────────────────────────────────────────────────────────────────────────

export const listEcsServicesZod = z
  .object({
    cluster: z
      .string()
      .optional()
      .describe(
        'Override the cluster name. Defaults to the agent\'s own cluster (strata-{env}). Must match strata-<env>.',
      ),
  })
  .strict();

export const listEcsServicesJsonSchema: InputSchema = {
  type: 'object',
  properties: {
    cluster: {
      type: 'string',
      description:
        'Override the cluster name. Defaults to the agent\'s own cluster (strata-{env}). Must match strata-<env>.',
    },
  },
  additionalProperties: false,
};

// ────────────────────────────────────────────────────────────────────────
// describe_aurora_cluster
// ────────────────────────────────────────────────────────────────────────

export const describeAuroraClusterZod = z
  .object({
    clusterId: z
      .string()
      .optional()
      .describe(
        'Override the cluster identifier. Defaults to the agent\'s own (strata-{env}). Must match strata-<env>.',
      ),
  })
  .strict();

export const describeAuroraClusterJsonSchema: InputSchema = {
  type: 'object',
  properties: {
    clusterId: {
      type: 'string',
      description:
        'Override the cluster identifier. Defaults to the agent\'s own (strata-{env}). Must match strata-<env>.',
    },
  },
  additionalProperties: false,
};

// ────────────────────────────────────────────────────────────────────────
// list_active_alarms — was hard-coded to ALARM state. Now optional.
// Behaviour win: callers can ask for full inventory by passing nothing,
// or scope to a state by passing stateValue.
// ────────────────────────────────────────────────────────────────────────

export const listActiveAlarmsZod = z
  .object({
    stateValue: z
      .enum(['OK', 'ALARM', 'INSUFFICIENT_DATA'])
      .optional()
      .describe(
        'Filter to alarms in a specific state. Omit to return alarms in any state (full inventory).',
      ),
    alarmNamePrefix: z
      .string()
      .optional()
      .describe(
        'Filter to alarms whose name starts with this prefix. Useful for scoping to a service (e.g. "strata-dev-").',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Max alarms to return. Default 100, hard cap 100.'),
  })
  .strict();

export const listActiveAlarmsJsonSchema: InputSchema = {
  type: 'object',
  properties: {
    stateValue: {
      type: 'string',
      enum: ['OK', 'ALARM', 'INSUFFICIENT_DATA'],
      description:
        'Filter to alarms in a specific state. Omit to return alarms in any state (full inventory).',
    },
    alarmNamePrefix: {
      type: 'string',
      description:
        'Filter to alarms whose name starts with this prefix. Useful for scoping to a service (e.g. "strata-dev-").',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: 'Max alarms to return. Default 100, hard cap 100.',
    },
  },
  additionalProperties: false,
};

// ────────────────────────────────────────────────────────────────────────
// tail_recent_logs
// ────────────────────────────────────────────────────────────────────────

export const tailRecentLogsZod = z
  .object({
    logGroupName: z
      .string()
      .optional()
      .describe(
        'Log group name (e.g. /ecs/strata-dev). Defaults to the agent\'s curated group. Must be in the strata-* allowlist.',
      ),
    lookbackMinutes: z
      .number()
      .int()
      .min(1)
      .max(1440)
      .optional()
      .describe('How far back in minutes to scan. Default 15. Hard cap 1440 (24h).'),
    filterPattern: z
      .string()
      .optional()
      .describe(
        'CloudWatch Logs filter pattern (e.g. ERROR, ?WARN ?error). Empty matches everything.',
      ),
  })
  .strict();

export const tailRecentLogsJsonSchema: InputSchema = {
  type: 'object',
  properties: {
    logGroupName: {
      type: 'string',
      description:
        'Log group name (e.g. /ecs/strata-dev). Defaults to the agent\'s curated group. Must be in the strata-* allowlist.',
    },
    lookbackMinutes: {
      type: 'integer',
      minimum: 1,
      maximum: 1440,
      description: 'How far back in minutes to scan. Default 15. Hard cap 1440 (24h).',
    },
    filterPattern: {
      type: 'string',
      description:
        'CloudWatch Logs filter pattern (e.g. ERROR, ?WARN ?error). Empty matches everything.',
    },
  },
  additionalProperties: false,
};

// ────────────────────────────────────────────────────────────────────────
// list_log_groups — NEW. Lets the model discover allowlisted log groups
// before tailing one. Closes the loop where the model previously had to
// guess group names from the system prompt's allowlist documentation.
// ────────────────────────────────────────────────────────────────────────

export const listLogGroupsZod = z
  .object({
    namePrefix: z
      .string()
      .optional()
      .describe(
        'Filter to groups whose name starts with this prefix (server-applied to CloudWatch).',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe('Max groups to return. Default 50.'),
  })
  .strict();

export const listLogGroupsJsonSchema: InputSchema = {
  type: 'object',
  properties: {
    namePrefix: {
      type: 'string',
      description:
        'Filter to groups whose name starts with this prefix (server-applied to CloudWatch).',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 50,
      description: 'Max groups to return. Default 50.',
    },
  },
  additionalProperties: false,
};

// ────────────────────────────────────────────────────────────────────────
// list_vpc_resources — no inputs.
// ────────────────────────────────────────────────────────────────────────

export const listVpcResourcesZod = z.object({}).strict();

export const listVpcResourcesJsonSchema: InputSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

// ────────────────────────────────────────────────────────────────────────
// describe_load_balancers — no inputs.
// ────────────────────────────────────────────────────────────────────────

export const describeLoadBalancersZod = z.object({}).strict();

export const describeLoadBalancersJsonSchema: InputSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

// ────────────────────────────────────────────────────────────────────────
// s3_bucket_summary — no inputs.
// ────────────────────────────────────────────────────────────────────────

export const s3BucketSummaryZod = z.object({}).strict();

export const s3BucketSummaryJsonSchema: InputSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

// ────────────────────────────────────────────────────────────────────────
// cost_last_7_days — was hard-coded to 7 days. Now optional `days`.
// Behaviour win: callers can ask "last 30 days" without spinning a new tool.
// ────────────────────────────────────────────────────────────────────────

export const costLastNDaysZod = z
  .object({
    days: z
      .number()
      .int()
      .min(1)
      .max(30)
      .optional()
      .describe(
        'Lookback window in days. Default 7. Hard cap 30 — Cost Explorer pricing makes longer windows expensive.',
      ),
  })
  .strict();

export const costLastNDaysJsonSchema: InputSchema = {
  type: 'object',
  properties: {
    days: {
      type: 'integer',
      minimum: 1,
      maximum: 30,
      description:
        'Lookback window in days. Default 7. Hard cap 30 — Cost Explorer pricing makes longer windows expensive.',
    },
  },
  additionalProperties: false,
};

// ────────────────────────────────────────────────────────────────────────
// infrastructure_topology — no inputs.
// ────────────────────────────────────────────────────────────────────────

export const infrastructureTopologyZod = z.object({}).strict();

export const infrastructureTopologyJsonSchema: InputSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};
