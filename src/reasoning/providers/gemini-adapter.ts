/**
 * Gemini tool-calling provider adapter.
 *
 * Implements ToolCallingProvider using the Gemini generateContent API
 * with function calling. Handles Gemini-specific format:
 * - System instruction in top-level `system_instruction` field
 * - Messages as `contents` array with `role: "user" | "model"`
 * - Tools as `functionDeclarations` within a tools array
 * - Tool calls as `functionCall` parts, results as `functionResponse` parts
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
// Gemini API types
// ---------------------------------------------------------------------------

/** Gemini content part types */
type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | {
      functionResponse: {
        name: string;
        response: { result: string };
      };
    };

/** Gemini content message */
interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

/** Gemini function declaration */
interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Gemini API response shape */
interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: GeminiPart[];
    };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
  };
}

// ---------------------------------------------------------------------------
// Message conversion
// ---------------------------------------------------------------------------

/**
 * Convert AgentMessage array to Gemini format.
 *
 * Key differences:
 * - System messages become `system_instruction` (top-level, not in contents)
 * - assistant → role: "model"
 * - Tool calls are `functionCall` parts in model messages
 * - Tool results are `functionResponse` parts in user messages
 * - Consecutive tool results are merged into a single user message
 */
function toGeminiFormat(messages: AgentMessage[]): {
  systemInstruction: { parts: Array<{ text: string }> } | undefined;
  contents: GeminiContent[];
} {
  const systemParts: Array<{ text: string }> = [];
  const nonSystemMessages: AgentMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemParts.push({ text: msg.content });
    } else {
      nonSystemMessages.push(msg);
    }
  }

  const systemInstruction =
    systemParts.length > 0 ? { parts: systemParts } : undefined;

  // Build a map of toolCallId → function name from assistant messages,
  // so tool result messages can set functionResponse.name to the function name
  // (Gemini requires the function name, not a synthetic ID).
  const toolCallIdToName = new Map<string, string>();
  for (const msg of nonSystemMessages) {
    if (msg.role === "assistant" && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        toolCallIdToName.set(tc.id, tc.name);
      }
    }
  }

  const contents: GeminiContent[] = [];

  for (const msg of nonSystemMessages) {
    switch (msg.role) {
      case "user":
        contents.push({ role: "user", parts: [{ text: msg.content }] });
        break;

      case "assistant": {
        const parts: GeminiPart[] = [];
        if (msg.content) {
          parts.push({ text: msg.content });
        }
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            parts.push({
              functionCall: {
                name: tc.name,
                args: tc.arguments,
              },
            });
          }
        }
        if (parts.length === 0) {
          parts.push({ text: "" });
        }
        contents.push({ role: "model", parts });
        break;
      }

      case "tool": {
        const functionName = toolCallIdToName.get(msg.toolCallId) ?? msg.toolCallId;
        const responsePart: GeminiPart = {
          functionResponse: {
            name: functionName,
            response: { result: msg.content },
          },
        };

        // Merge consecutive tool results into a single user message
        const last = contents[contents.length - 1];
        if (last && last.role === "user") {
          const allFunctionResponses = last.parts.every(
            (p) => "functionResponse" in p,
          );
          if (allFunctionResponses) {
            last.parts.push(responsePart);
            break;
          }
        }

        contents.push({ role: "user", parts: [responsePart] });
        break;
      }
    }
  }

  return { systemInstruction, contents };
}

/**
 * Convert ToolDefinition array to Gemini function declarations.
 */
function toGeminiFunctionDeclarations(
  tools: ToolDefinition[],
): GeminiFunctionDeclaration[] {
  return tools.map(
    (t): GeminiFunctionDeclaration => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }),
  );
}

/**
 * Parse Gemini response parts into text content and tool calls.
 */
function parseResponse(parts: GeminiPart[] | undefined): {
  text: string | null;
  toolCalls: ToolCall[] | undefined;
} {
  if (!parts || parts.length === 0) {
    return { text: null, toolCalls: undefined };
  }

  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];
  let callIdCounter = 0;

  for (const part of parts) {
    if ("text" in part) {
      textParts.push(part.text);
    } else if ("functionCall" in part) {
      callIdCounter++;
      toolCalls.push({
        id: `gemini_call_${callIdCounter}_${Date.now()}`,
        name: part.functionCall.name,
        arguments: part.functionCall.args,
      });
    }
  }

  return {
    text: textParts.length > 0 ? textParts.join("") : null,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}

/**
 * Map Gemini finish reason to a normalized string.
 */
function mapFinishReason(
  reason: string | undefined,
  hasToolCalls: boolean,
): string {
  if (hasToolCalls) return "tool_calls";
  switch (reason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
      return "content_filter";
    default:
      return reason?.toLowerCase() || "stop";
  }
}

export class GeminiToolCallingProvider implements ToolCallingProvider {
  readonly name = "gemini";
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model = "gemini-2.5-flash") {
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

    const { systemInstruction, contents } = toGeminiFormat(messages);

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens,
      },
    };

    if (systemInstruction) {
      body.system_instruction = systemInstruction;
    }

    const declarations = toGeminiFunctionDeclarations(tools);
    if (declarations.length > 0) {
      body.tools = [{ functionDeclarations: declarations }];
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (response.status === 429) {
        throw new LlmError("Gemini rate limit exceeded", this.name, 429);
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new LlmError(
          `Gemini API error: ${response.status} ${text}`,
          this.name,
          response.status,
        );
      }

      const data = (await response.json()) as GeminiResponse;
      const candidate = data.candidates?.[0];
      const { text, toolCalls } = parseResponse(candidate?.content?.parts);

      return {
        content: text,
        toolCalls,
        finishReason: mapFinishReason(
          candidate?.finishReason,
          toolCalls !== undefined,
        ),
        usage: data.usageMetadata
          ? {
              promptTokens: data.usageMetadata.promptTokenCount,
              completionTokens: data.usageMetadata.candidatesTokenCount,
            }
          : undefined,
      };
    } catch (err) {
      if (err instanceof LlmError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new LlmError(
          `Gemini request timed out after ${timeoutMs}ms`,
          this.name,
        );
      }
      throw new LlmError(
        `Gemini request failed: ${err instanceof Error ? err.message : String(err)}`,
        this.name,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
