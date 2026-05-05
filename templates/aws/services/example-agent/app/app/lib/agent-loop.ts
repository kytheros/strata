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

  for (let i = 0; i < maxIterations; i++) {
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: args.systemPrompt,
      tools: TOOLS,
      messages: conversation,
    });

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
        const output = await executeTool(tu.name, tu.input, args.ctx);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: JSON.stringify(output),
        });
        toolCalls.push({ name: tu.name, input: tu.input, output });
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

export const SYSTEM_PROMPT_TEMPLATE = `You are the AWS-introspection chat assistant for the Strata-on-AWS portfolio deploy. You answer the operator's questions about the very AWS account you are running inside.

You have ~10 read-only AWS SDK tools. Pick the smallest set that answers the question. Prefer \`infrastructure_topology\` when the user asks an open-ended "what's running" question — it's already cached. Use specific drill-down tools (\`list_active_alarms\`, \`tail_recent_logs\`, \`cost_last_7_days\`) when the user wants a focused answer.

Rules:
- Cite numbers from tool results — never guess.
- If a tool errors, say so and propose a follow-up call (do not invent data).
- Keep responses tight. The operator is technical; skip the marketing copy.
- You CANNOT modify any AWS resource. Every tool is read-only. If the user asks for a change, suggest the right Terraform module + ticket instead.

When relevant, use the recall context below — past memory the operator stored in Strata in earlier sessions:
`;
