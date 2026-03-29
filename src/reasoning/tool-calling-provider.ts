/**
 * Tool-calling LLM provider interface for the production reasoning agent loop.
 *
 * This is SEPARATE from the text-in/text-out LlmProvider used for extraction
 * and summarization (src/extensions/llm-extraction/llm-provider.ts).
 * ToolCallingProvider models support structured tool/function calling,
 * enabling iterative retrieval via an agent loop.
 */

/** A tool definition for the agent loop */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

/** A tool call requested by the model */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Token usage for cost tracking */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

/** A message in the agent loop conversation */
export type AgentMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

/** Provider interface for LLMs that support tool/function calling */
export interface ToolCallingProvider {
  readonly name: string;
  chatWithTools(
    messages: AgentMessage[],
    tools: ToolDefinition[],
    options?: { temperature?: number; maxTokens?: number; timeoutMs?: number }
  ): Promise<{
    content: string | null;
    toolCalls?: ToolCall[];
    finishReason: string;
    usage?: TokenUsage;
  }>;
}
