// Per-tool invocation examples, embedded into the tool's `description`
// string at registration time.
//
// Why a separate file rather than inlining into each tool module:
// - Keeps the per-tool file focused on Purpose/When/Prereq/Anti-pattern;
//   examples are a separate kind of doc that the model treats as anchors.
// - Lets us keep examples typed (input is parametrized by the tool's own
//   Input shape, so a missed field surfaces at compile time).
//
// Why embed-into-description rather than a top-level `tools[].input_examples`:
// - The Anthropic Messages API does not have an `input_examples` field
//   on the tool object. Passing one would 400 at runtime. Embedding 1-3
//   representative invocations under an `**Examples**` heading inside
//   the `description` string is the canonical Anthropic-recommended
//   pattern for guiding tool selection.
//
// Format rendered into the description:
//   **Examples**
//   - <label>: <toolName>(<args-json>) — <comment>
//   - …

export interface ToolInputExample {
  // One-word use-case label ("inventory", "triage", "scoped"). The model
  // pattern-matches on these when picking which example fits the user's
  // ask, so keep them short and consistent across tools.
  label: string;
  // The exact JSON args the tool would be called with. `null` is a
  // legitimate "no-args" call.
  args: Record<string, unknown> | null;
  // One-line rationale rendered after an em-dash. Tell the model WHEN
  // this shape is appropriate, not what the tool does in general.
  comment: string;
}

export const TOOL_EXAMPLES: Record<string, ToolInputExample[]> = {
  who_am_i: [
    {
      label: 'identity check',
      args: {},
      comment: 'no inputs; returns account, role ARN, region.',
    },
  ],
  list_ecs_services: [
    {
      label: 'default cluster',
      args: {},
      comment: 'omit cluster — agent uses its own ECS_CLUSTER_NAME env.',
    },
    {
      label: 'override cluster',
      args: { cluster: 'strata-staging' },
      comment: 'staging cluster from a dev-pointing agent.',
    },
  ],
  describe_aurora_cluster: [
    {
      label: 'default cluster',
      args: {},
      comment: 'omit clusterId — agent uses AURORA_CLUSTER_ID env.',
    },
    {
      label: 'override',
      args: { clusterId: 'strata-staging' },
      comment: 'inspect a sibling environment\'s cluster.',
    },
  ],
  list_active_alarms: [
    {
      label: 'triage',
      args: { stateValue: 'ALARM' },
      comment: 'only currently firing alarms — for "is anything wrong?".',
    },
    {
      label: 'inventory',
      args: {},
      comment: 'every alarm regardless of state — for "what alarms exist?".',
    },
    {
      label: 'scoped',
      args: { alarmNamePrefix: 'strata-dev-', limit: 25 },
      comment: 'narrow to one service\'s alarms with a smaller cap.',
    },
  ],
  tail_recent_logs: [
    {
      label: 'errors',
      args: { filterPattern: 'ERROR', lookbackMinutes: 15 },
      comment: 'recent errors only, default group, 15-min window.',
    },
    {
      label: 'wider window',
      args: { logGroupName: '/ecs/strata-dev', lookbackMinutes: 60 },
      comment: 'all events, ECS group, last hour.',
    },
    {
      label: 'lambda',
      args: {
        logGroupName: '/aws/lambda/strata-dev-mcp-canary',
        filterPattern: '?WARN ?error',
      },
      comment: 'multi-keyword pattern on the canary lambda group.',
    },
  ],
  list_log_groups: [
    {
      label: 'discover',
      args: {},
      comment: 'enumerate visible log groups before deciding what to tail.',
    },
    {
      label: 'scoped',
      args: { namePrefix: '/aws/lambda/strata-' },
      comment: 'just the strata-* lambda groups.',
    },
  ],
  list_vpc_resources: [
    {
      label: 'topology',
      args: {},
      comment: 'no inputs; returns VPCs/subnets/NAT/endpoints in the region.',
    },
  ],
  describe_load_balancers: [
    {
      label: 'inventory',
      args: {},
      comment: 'no inputs; lists ELBv2 LBs with their target groups.',
    },
  ],
  s3_bucket_summary: [
    {
      label: 'inventory',
      args: {},
      comment: 'no inputs; lists buckets with region + encryption posture.',
    },
  ],
  cost_last_7_days: [
    {
      label: 'default 7d',
      args: {},
      comment: 'omit days — defaults to 7-day window.',
    },
    {
      label: 'last month',
      args: { days: 30 },
      comment: '30-day rollup; same Cost Explorer pricing applies.',
    },
  ],
  infrastructure_topology: [
    {
      label: 'snapshot',
      args: {},
      comment:
        'no inputs; composes VPC + ECS + Aurora + ELB into one summary.',
    },
  ],
};

// Render the tool's examples into a description-tail block. Returns the
// existing description with an `**Examples**` section appended, OR the
// description unchanged if no examples are registered for this tool.
//
// We keep the rendering logic in one place so the format can evolve once
// (e.g. switching to `<example>` XML tags if Anthropic publishes new
// guidance) without touching every tool module.
export function withExamples(toolName: string, baseDescription: string): string {
  const examples = TOOL_EXAMPLES[toolName];
  if (!examples || examples.length === 0) return baseDescription;

  const lines = examples.map((ex) => {
    const argsJson = ex.args === null ? 'null' : JSON.stringify(ex.args);
    return `- ${ex.label}: ${toolName}(${argsJson}) — ${ex.comment}`;
  });

  return `${baseDescription}\n\n**Examples**\n${lines.join('\n')}`;
}
