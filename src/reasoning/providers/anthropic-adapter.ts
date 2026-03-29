/**
 * Anthropic tool-calling provider adapter.
 *
 * Implements ToolCallingProvider using the Anthropic Messages API
 * with tool use. Handles Anthropic-specific message format requirements:
 * - System prompt in top-level `system` field, not in messages
 * - Alternating user/assistant messages
 * - Tool results as `tool_result` content blocks in user messages
 *
 * Uses raw fetch — no SDK dependency.
 */

import type {
  ToolCallingProvider,
  ToolDefinition,
  ToolCall,
  AgentMessage,
  TokenUsage,
} from "../tool-calling-provider.js";
import { LlmError } from "../../extensions/llm-extraction/llm-provider.js";

// ---------------------------------------------------------------------------
// Anthropic API types
// ---------------------------------------------------------------------------

/** Anthropic tool definition */
interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Anthropic content block types */
type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

/** Anthropic message format */
interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

/** Anthropic API response shape */
interface AnthropicResponse {
  content?: AnthropicContentBlock[];
  stop_reason?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

// ---------------------------------------------------------------------------
// Message conversion
// ---------------------------------------------------------------------------

/**
 * Convert AgentMessage array to Anthropic format.
 *
 * Key differences from OpenAI:
 * - System messages are extracted to a separate top-level `system` string
 * - Assistant messages with tool calls become content block arrays
 * - Tool result messages become user messages with tool_result content blocks
 * - Consecutive tool results are merged into a single user message
 *   (Anthropic requires strict user/assistant alternation)
 */
function toAnthropicFormat(messages: AgentMessage[]): {
  system: string | undefined;
  messages: AnthropicMessage[];
} {
  // Extract system messages into a combined system string
  const systemParts: string[] = [];
  const nonSystemMessages: AgentMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemParts.push(msg.content);
    } else {
      nonSystemMessages.push(msg);
    }
  }

  const system = systemParts.length > 0 ? systemParts.join("\n\n") : undefined;

  // Convert remaining messages, merging consecutive tool results
  const result: AnthropicMessage[] = [];

  for (const msg of nonSystemMessages) {
    switch (msg.role) {
      case "user":
        result.push({ role: "user", content: msg.content });
        break;

      case "assistant": {
        const blocks: AnthropicContentBlock[] = [];
        if (msg.content) {
          blocks.push({ type: "text", text: msg.content });
        }
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            blocks.push({
              type: "tool_use",
              id: tc.id,
              name: tc.name,
              input: tc.arguments,
            });
          }
        }
        result.push({
          role: "assistant",
          content: blocks.length > 0 ? blocks : msg.content ?? "",
        });
        break;
      }

      case "tool": {
        const toolResultBlock: AnthropicContentBlock = {
          type: "tool_result",
          tool_use_id: msg.toolCallId,
          content: msg.content,
        };

        // Merge into the previous user message if the last message is a user
        // message with tool_result content blocks (consecutive tool results)
        const last = result[result.length - 1];
        if (last && last.role === "user" && Array.isArray(last.content)) {
          // Check that all existing blocks are tool_result
          const allToolResults = (last.content as AnthropicContentBlock[]).every(
            (b) => b.type === "tool_result",
          );
          if (allToolResults) {
            (last.content as AnthropicContentBlock[]).push(toolResultBlock);
            break;
          }
        }

        // Otherwise, create a new user message with the tool result
        result.push({
          role: "user",
          content: [toolResultBlock],
        });
        break;
      }
    }
  }

  return { system, messages: result };
}

/**
 * Convert ToolDefinition array to Anthropic tool format.
 */
function toAnthropicTools(tools: ToolDefinition[]): AnthropicTool[] {
  return tools.map(
    (t): AnthropicTool => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }),
  );
}

/**
 * Parse Anthropic response content blocks into text and tool calls.
 */
function parseResponse(content: AnthropicContentBlock[] | undefined): {
  text: string | null;
  toolCalls: ToolCall[] | undefined;
} {
  if (!content || content.length === 0) {
    return { text: null, toolCalls: undefined };
  }

  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];

  for (const block of content) {
    if (block.type === "text") {
      textParts.push(block.text);
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: block.input,
      });
    }
  }

  return {
    text: textParts.length > 0 ? textParts.join("") : null,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}

/**
 * Map Anthropic stop_reason to a normalized finish reason string.
 */
function mapFinishReason(stopReason: string | undefined): string {
  switch (stopReason) {
    case "end_turn":
      return "stop";
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    default:
      return stopReason || "stop";
  }
}

export class AnthropicToolCallingProvider implements ToolCallingProvider {
  readonly name = "anthropic";
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model = "claude-sonnet-4-20250514") {
    this.apiKey = apiKey;
    this.model = model;
  }

  async chatWithTools(
    messages: AgentMessage[],
    tools: ToolDefinition[],
    options: {
      temperature?: number;
      maxTokens?: number;
      timeoutMs?: number;
    } = {},
  ): Promise<{
    content: string | null;
    toolCalls?: ToolCall[];
    finishReason: string;
    usage?: TokenUsage;
  }> {
    const { temperature = 0, maxTokens = 2048, timeoutMs = 90000 } = options;

    const { system, messages: anthropicMessages } =
      toAnthropicFormat(messages);

    const body: Record<string, unknown> = {
      model: this.model,
      messages: anthropicMessages,
      temperature,
      max_tokens: maxTokens,
    };

    if (system) {
      body.system = system;
    }

    const anthropicTools = toAnthropicTools(tools);
    if (anthropicTools.length > 0) {
      body.tools = anthropicTools;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (response.status === 429) {
        throw new LlmError(
          "Anthropic rate limit exceeded",
          this.name,
          429,
        );
      }
      if (response.status === 529) {
        throw new LlmError(
          "Anthropic API overloaded",
          this.name,
          529,
        );
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new LlmError(
          `Anthropic API error: ${response.status} ${text}`,
          this.name,
          response.status,
        );
      }

      const data = (await response.json()) as AnthropicResponse;
      const { text, toolCalls } = parseResponse(data.content);

      return {
        content: text,
        toolCalls,
        finishReason: mapFinishReason(data.stop_reason),
        usage: data.usage
          ? {
              promptTokens: data.usage.input_tokens,
              completionTokens: data.usage.output_tokens,
            }
          : undefined,
      };
    } catch (err) {
      if (err instanceof LlmError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new LlmError(
          `Anthropic request timed out after ${timeoutMs}ms`,
          this.name,
        );
      }
      throw new LlmError(
        `Anthropic request failed: ${err instanceof Error ? err.message : String(err)}`,
        this.name,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
