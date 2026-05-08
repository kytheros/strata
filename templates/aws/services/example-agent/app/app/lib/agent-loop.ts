// Anthropic SDK tool-use loop.
//
// One pass:
//   1. POST /messages with the conversation + the tool catalog.
//   2. If stop_reason = end_turn, return the assistant text.
//   3. If stop_reason = tool_use, execute every tool_use block in order,
//      append the assistant turn + a user turn carrying tool_result
//      blocks, and loop.
//   4. Cap iterations at maxIterations (default 10) so a misbehaving
//      model can't bill us into oblivion.
//
// Model: claude-sonnet-4-6. Per the AWS-3.3 ticket — fast enough for
// tool-use loops, cheap enough for portfolio-demo cadence. Bump to opus
// for harder reasoning later if the chat shows it.

import Anthropic from '@anthropic-ai/sdk';
import type {
  MessageParam,
  TextBlock,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/messages';
import { TOOLS, executeTool } from './tools';
import type { ToolContext } from './tools/context';
import { publishTokenMetric } from './metrics';
import { redact, logRedactionCounts } from './redact';

const DEFAULT_MAX_ITERATIONS = 10;
const DEFAULT_MODEL = 'claude-sonnet-4-6';

export interface AgentTurnTrace {
  name: string;
  input: unknown;
  output: unknown;
}

export interface AgentLoopResult {
  finalText: string;
  toolCalls: AgentTurnTrace[];
  iterations: number;
  stoppedReason: 'end_turn' | 'max_iterations';
}

export interface AgentLoopArgs {
  systemPrompt: string;
  messages: MessageParam[];
  ctx: ToolContext;
  maxIterations?: number;
  apiKey?: string;
  model?: string;
}

export async function runAgentLoop(
  args: AgentLoopArgs,
): Promise<AgentLoopResult> {
  const apiKey = args.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      '[agent-loop] ANTHROPIC_API_KEY not set — cannot reach Anthropic.',
    );
  }
  const client = new Anthropic({ apiKey });
  const model = args.model ?? DEFAULT_MODEL;
  const maxIterations = args.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  const conversation: MessageParam[] = [...args.messages];
  const toolCalls: AgentTurnTrace[] = [];

  // Tag spend metrics with the deploy's env so dev/staging/prod alarms
  // don't co-mingle. Falls back to "unknown" rather than throwing — a
  // missing env tag is a metric-fidelity issue, not a chat-blocking one.
  const metricEnv = process.env.ENV_NAME ?? 'unknown';

  for (let i = 0; i < maxIterations; i++) {
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: args.systemPrompt,
      tools: TOOLS,
      messages: conversation,
    });

    // AWS-3.4: emit token-usage metrics per direction so the
    // Concierge/Anthropic/TokensConsumed alarm can page on runaway burn.
    // Fire-and-forget — CloudWatch outage MUST NOT break the chat turn.
    if (response.usage) {
      void publishTokenMetric({
        env: metricEnv,
        model,
        direction: 'input',
        tokens: response.usage.input_tokens ?? 0,
      });
      void publishTokenMetric({
        env: metricEnv,
        model,
        direction: 'output',
        tokens: response.usage.output_tokens ?? 0,
      });
    }

    if (response.stop_reason === 'end_turn' || response.stop_reason === 'stop_sequence') {
      const finalText = response.content
        .filter((b): b is TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      return {
        finalText,
        toolCalls,
        iterations: i + 1,
        stoppedReason: 'end_turn',
      };
    }

    if (response.stop_reason === 'tool_use') {
      // Append the assistant turn verbatim. Anthropic's tool-use protocol
      // requires the next user turn's tool_result blocks to reference the
      // exact tool_use ids the assistant emitted.
      conversation.push({ role: 'assistant', content: response.content });

      const toolResults: Array<{
        type: 'tool_result';
        tool_use_id: string;
        content: string;
      }> = [];

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        const tu = block as ToolUseBlock;
        const startedAt = Date.now();
        let ok = true;
        let output: unknown;
        try {
          output = await executeTool(tu.name, tu.input, args.ctx);
        } catch (err) {
          // executeTool already swallows tool errors and returns an
          // {error, message} envelope; this catch only fires on a
          // dispatcher-level bug. Surface it the same way so the
          // model can recover.
          ok = false;
          const e = err as Error;
          output = { error: e.name ?? 'Error', message: e.message ?? String(e) };
        }

        // Audit log — one structured line per tool call. Truncated input,
        // no output (output goes through redaction below). The strata-dev
        // log group already collects stdout, so no new infra is required.
        const inputPreview = JSON.stringify(tu.input ?? {}).slice(0, 200);
        const elapsedMs = Date.now() - startedAt;
        // eslint-disable-next-line no-console
        console.log(
          `[tool-audit] tool=${tu.name} input=${inputPreview} elapsedMs=${elapsedMs} ok=${ok}`,
        );

        // Redact secrets BEFORE the tool output is shipped back into the
        // model's context. The model never sees a verbatim Anthropic key,
        // AWS access key, JWT, bearer token, or long hex secret that
        // accidentally landed in a CloudWatch log line.
        const stringified = JSON.stringify(output);
        const { redacted, counts } = redact(stringified);
        logRedactionCounts(`tool:${tu.name}`, counts);

        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: redacted,
        });
        // The trace surfaced in the chat response (`toolCalls` UI panel)
        // also gets the redacted form — the operator should never see a
        // raw secret echoed even in the debug pane.
        let traceOutput: unknown = output;
        try {
          traceOutput = JSON.parse(redacted);
        } catch {
          traceOutput = { redacted };
        }
        toolCalls.push({ name: tu.name, input: tu.input, output: traceOutput });
      }

      conversation.push({ role: 'user', content: toolResults as any });
      continue;
    }

    // max_tokens, refusal, or anything we didn't anticipate — stop.
    const finalText = response.content
      .filter((b): b is TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    return {
      finalText: finalText || `[stopped: ${response.stop_reason}]`,
      toolCalls,
      iterations: i + 1,
      stoppedReason: 'end_turn',
    };
  }

  return {
    finalText:
      'I exhausted my tool-use budget before settling on an answer. Try asking a more focused question.',
    toolCalls,
    iterations: maxIterations,
    stoppedReason: 'max_iterations',
  };
}

export const SYSTEM_PROMPT_TEMPLATE = `You are the AWS-introspection chat assistant for the Strata-on-AWS deployment. You answer the operator's questions about the very AWS account you are running inside.

You have ~10 read-only AWS SDK tools. Pick the smallest set that answers the question. Prefer \`infrastructure_topology\` when the user asks an open-ended "what's running" question — it's already cached. Use specific drill-down tools (\`list_active_alarms\`, \`tail_recent_logs\`, \`cost_last_7_days\`) when the user wants a focused answer.

Behaviour rules:
- Cite numbers from tool results — never guess.
- If a tool errors, say so and propose a follow-up call (do not invent data).
- The operator is technical; skip marketing copy and exclamations.
- You CANNOT modify any AWS resource. Every tool is read-only. If the user asks for a change, suggest the right Terraform module + ticket instead.

Tool-semantics caveats — be precise about what your tools see vs. don't:
- \`list_active_alarms\` only returns alarms currently in the ALARM state. It cannot enumerate alarms in OK or INSUFFICIENT_DATA. When the operator asks "what alarms do I have" or "what CloudWatch alarms exist" (i.e. wants the inventory rather than what's firing), you MUST state explicitly that the tool only shows alarms in ALARM state right now and that the full inventory is visible in the AWS console (link them to CloudWatch > All alarms). Phrase it like: "Three alarms are currently firing — listed below. The full alarm inventory (including OK and INSUFFICIENT_DATA) isn't reachable from this tool; check the CloudWatch console for the rest." Never imply the firing list is the complete list.
- \`cost_last_7_days\` is account-scoped, not deploy-scoped — it returns ALL spend in the AWS account, not just strata-* resources.
- \`tail_recent_logs\` is constrained to /ecs/strata-* and /aws/lambda/strata-* by an allowlist. If the operator asks for a log group outside that namespace, the tool errors — say what the allowlist permits and offer the closest in-namespace match.
- \`s3_bucket_summary\` lists ALL buckets in the account (no IAM scoping on ListAllMyBuckets), but per-bucket details are only readable for buckets matching strata-*. Mention this when relevant.

Output format — clean and elegant, render as plain prose:
- NO emojis. None. Not even checkmarks, arrows, or status dots.
- NO Markdown tables. The UI does not render Markdown; tables become unaligned ASCII.
- NO Markdown headings (#, ##), no bold (**), no italic (*). The UI strips them and you waste tokens.
- Prefer short paragraphs. Two or three lines per idea.
- For lists of items (services, alarms, buckets), use a single dash (-) per line with the value first and any commentary after a colon. Keep each line under ~120 characters.
- Resource identifiers (ARNs, IDs, paths) appear inline as bare strings — no backticks, no quotes around them.
- Numbers carry units inline (e.g. "12.4 GB", "$3.27 over 7 days", "3 of 5 healthy"). Operators scan numbers; don't bury them.
- When summarising counts ("3 services running"), follow with a one-line dash list naming each.
- One blank line between distinct sections of the response. Never two.
- End with a one-line next-step suggestion if a follow-up call would obviously help (e.g. "Run tail_recent_logs on the redis cluster if you want to see why the alarm fired."). Otherwise end where the answer ends.

When relevant, use the recall context below — past memory the operator stored in Strata in earlier sessions:
`;
