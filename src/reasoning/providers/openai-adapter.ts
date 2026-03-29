/**
 * OpenAI tool-calling provider adapter.
 *
 * Implements ToolCallingProvider using the OpenAI Chat Completions API
 * with function calling. Ported from the benchmark's callOpenAIWithTools.
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

/** OpenAI message format */
interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

/** OpenAI tool call format */
interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/** OpenAI tool definition format */
interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** OpenAI API response shape */
interface OpenAIResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
  };
}

/**
 * Convert AgentMessage array to OpenAI message format.
 */
function toOpenAIMessages(messages: AgentMessage[]): OpenAIMessage[] {
  return messages.map((msg): OpenAIMessage => {
    switch (msg.role) {
      case "system":
        return { role: "system", content: msg.content };
      case "user":
        return { role: "user", content: msg.content };
      case "assistant": {
        const result: OpenAIMessage = {
          role: "assistant",
          content: msg.content,
        };
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          result.tool_calls = msg.toolCalls.map(
            (tc): OpenAIToolCall => ({
              id: tc.id,
              type: "function",
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments),
              },
            }),
          );
        }
        return result;
      }
      case "tool":
        return {
          role: "tool",
          content: msg.content,
          tool_call_id: msg.toolCallId,
        };
    }
  });
}

/**
 * Convert ToolDefinition array to OpenAI tool format.
 */
function toOpenAITools(tools: ToolDefinition[]): OpenAITool[] {
  return tools.map(
    (t): OpenAITool => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }),
  );
}

/**
 * Parse OpenAI tool calls into ToolCall array.
 */
function parseToolCalls(
  toolCalls: OpenAIToolCall[] | undefined,
): ToolCall[] | undefined {
  if (!toolCalls || toolCalls.length === 0) return undefined;

  return toolCalls.map((tc): ToolCall => {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
    } catch {
      // If JSON parse fails, pass the raw string as a single argument
      args = { _raw: tc.function.arguments };
    }
    return {
      id: tc.id,
      name: tc.function.name,
      arguments: args,
    };
  });
}

export class OpenAIToolCallingProvider implements ToolCallingProvider {
  readonly name = "openai";
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model = "gpt-4o") {
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

    const body: Record<string, unknown> = {
      model: this.model,
      messages: toOpenAIMessages(messages),
      temperature,
      max_tokens: maxTokens,
    };

    const openAITools = toOpenAITools(tools);
    if (openAITools.length > 0) {
      body.tools = openAITools;
      body.tool_choice = "auto";
      // Benchmark finding: parallel tool calls cause errors
      body.parallel_tool_calls = false;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );

      if (response.status === 429) {
        throw new LlmError("OpenAI rate limit exceeded", this.name, 429);
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new LlmError(
          `OpenAI API error: ${response.status} ${text}`,
          this.name,
          response.status,
        );
      }

      const data = (await response.json()) as OpenAIResponse;
      const choice = data.choices?.[0];

      return {
        content: choice?.message?.content ?? null,
        toolCalls: parseToolCalls(choice?.message?.tool_calls),
        finishReason: choice?.finish_reason || "stop",
        usage: data.usage
          ? {
              promptTokens: data.usage.prompt_tokens,
              completionTokens: data.usage.completion_tokens,
            }
          : undefined,
      };
    } catch (err) {
      if (err instanceof LlmError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new LlmError(
          `OpenAI request timed out after ${timeoutMs}ms`,
          this.name,
        );
      }
      throw new LlmError(
        `OpenAI request failed: ${err instanceof Error ? err.message : String(err)}`,
        this.name,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
