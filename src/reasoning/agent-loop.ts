/**
 * Production Agent Loop Engine
 *
 * Generalizes the benchmark's OpenAI-only agent loop to work with any provider
 * via the ToolCallingProvider interface (OpenAI, Anthropic, Gemini).
 *
 * The LOOP LOGIC is the same as the benchmark (iterative retrieval with planning
 * + reflection); the TOOL EXECUTION operates on Strata's production stores
 * (search engine, event store, knowledge store, document store) instead of
 * benchmark-specific data structures.
 *
 * Three critical agentic instructions from the OpenAI GPT-4.1 prompting guide:
 * 1. Persistence — keep searching until confident
 * 2. Tool verification — use get_session to verify, don't guess
 * 3. Planning + reflection — plan before each call, reflect after
 */

import type { ToolCallingProvider, ToolDefinition, ToolCall, TokenUsage, AgentMessage } from "./tool-calling-provider.js";
import type { QuestionType } from "./procedures.js";
import { classifyQuestion, getProcedure, getToolSubset } from "./procedures.js";
import { createToolCallingProvider } from "./providers/factory.js";
import { CONFIG } from "../config.js";
import type { SqliteSearchEngine, SearchOptions } from "../search/sqlite-search-engine.js";
import type { IEventStore } from "../storage/interfaces/event-store.js";
import type { IKnowledgeStore } from "../storage/interfaces/knowledge-store.js";
import type { IDocumentStore } from "../storage/interfaces/document-store.js";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** Dependencies injected into the agent loop — production Strata stores. */
export interface AgentLoopDependencies {
  searchEngine: SqliteSearchEngine;
  documentStore: IDocumentStore;
  eventStore?: IEventStore;
  knowledgeStore?: IKnowledgeStore;
}

/** Options for customizing a single agent loop invocation. */
export interface AgentLoopOptions {
  /** Maximum agent loop iterations (default from CONFIG.reasoning.maxIterations). */
  maxIterations?: number;
  /** Override provider selection ("openai", "anthropic", "gemini", or "auto"). */
  provider?: string;
  /** Override model selection (provider-specific, e.g. "gpt-4o", "gemini-2.5-flash"). */
  model?: string;
  /** User scope for multi-tenant search isolation. */
  user?: string;
}

/** Result of a completed agent loop run. */
export interface AgentLoopResult {
  answer: string;
  questionType: QuestionType;
  latencyMs: number;
  iterations: number;
  toolCallLog: Array<{
    tool: string;
    args: Record<string, unknown>;
    resultLength: number;
  }>;
  tokenUsage: TokenUsage;
}

// ---------------------------------------------------------------------------
// Tool definitions (ToolDefinition objects for the provider interface)
// ---------------------------------------------------------------------------

const TOOL_SEARCH_SESSIONS: ToolDefinition = {
  name: "search_sessions",
  description:
    "Search conversation sessions by semantic meaning and keywords. Returns the most " +
    "relevant sessions with their dates and content previews. Use this as your primary " +
    "search tool. Try multiple queries with DIFFERENT vocabulary if the first search " +
    "misses sessions you expect to find — the same topic often uses different words. " +
    "Example inputs: 'model kit purchase', 'camping trip national park', 'doctor appointment'.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query. Natural language or key phrases.",
      },
      limit: {
        type: "number",
        description: "Maximum sessions to return (default 10, max 20).",
      },
    },
    required: ["query"],
  },
};

const TOOL_SEARCH_EVENTS: ToolDefinition = {
  name: "search_events",
  description:
    "Search a structured calendar of events extracted from all conversations. Returns " +
    "discrete activities, purchases, experiences, and facts as concise dated entries. " +
    "Each entry is one distinct event — more reliable for counting than raw sessions. " +
    "Example inputs: 'model kit', 'concert', 'book', 'workout', 'restaurant visit'. " +
    "ALWAYS use this for counting questions alongside search_sessions.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search keywords for events. Short phrases work best.",
      },
      limit: {
        type: "number",
        description: "Maximum events to return (default 15, max 50).",
      },
    },
    required: ["query"],
  },
};

const TOOL_GET_SESSION: ToolDefinition = {
  name: "get_session",
  description:
    "Retrieve the complete text of a specific conversation session by its ID. " +
    "Use this when search_sessions returns a promising session and you need to " +
    "read the full conversation to verify details or extract exact numbers. " +
    "The session_id is shown in search results.",
  parameters: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "The session ID from search results.",
      },
    },
    required: ["session_id"],
  },
};

const TOOL_SEARCH_KNOWLEDGE: ToolDefinition = {
  name: "search_knowledge",
  description:
    "Search structured knowledge entries extracted from conversations — facts, " +
    "preferences, and episodic memories in concise form. Good for factual questions " +
    "and as a complement to search_sessions for broader coverage. " +
    "Example inputs: 'pet name', 'job title', 'favorite restaurant'.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query for knowledge entries.",
      },
      limit: {
        type: "number",
        description: "Maximum entries to return (default 10, max 20).",
      },
    },
    required: ["query"],
  },
};

const TOOL_COUNT_SESSIONS: ToolDefinition = {
  name: "count_sessions",
  description:
    "Returns the total number of conversation sessions and the date range. " +
    "Call this first to understand the scope of the history.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
};

const TOOL_SEARCH_BY_DATE: ToolDefinition = {
  name: "search_by_date",
  description:
    "Find conversation sessions within a specific date range. Returns sessions " +
    "whose timestamp falls between the two dates. Use this for temporal questions — " +
    "when you need to find what happened during a specific time period. " +
    "Example: to find what happened 3 weeks ago from 2023-04-15, search " +
    "after_date='2023-03-24' before_date='2023-03-26'. Keep the window NARROW " +
    "(a few days) for best results.",
  parameters: {
    type: "object",
    properties: {
      after_date: {
        type: "string",
        description: "Start of date range (ISO format: YYYY-MM-DD). Sessions ON or AFTER this date.",
      },
      before_date: {
        type: "string",
        description: "End of date range (ISO format: YYYY-MM-DD). Sessions ON or BEFORE this date.",
      },
      limit: {
        type: "number",
        description: "Maximum sessions to return (default 10).",
      },
    },
    required: ["after_date", "before_date"],
  },
};

/** All tool definitions, keyed by name for subset filtering. */
const ALL_TOOLS: Record<string, ToolDefinition> = {
  search_sessions: TOOL_SEARCH_SESSIONS,
  search_events: TOOL_SEARCH_EVENTS,
  get_session: TOOL_GET_SESSION,
  search_knowledge: TOOL_SEARCH_KNOWLEDGE,
  count_sessions: TOOL_COUNT_SESSIONS,
  search_by_date: TOOL_SEARCH_BY_DATE,
};

// ---------------------------------------------------------------------------
// Tool execution (production stores)
// ---------------------------------------------------------------------------

/** Format session-level search results for the agent. */
function formatSessionResults(
  results: Array<{ sessionId: string; text: string; timestamp: number; score: number }>,
): string {
  if (results.length === 0) return "No sessions found. Try different keywords.";

  const lines = [`Found ${results.length} session(s):\n`];
  for (const r of results) {
    const date = new Date(r.timestamp);
    const dateStr = isNaN(date.getTime()) ? "Unknown date" : date.toISOString().split("T")[0];
    const preview = r.text.length > 1500
      ? r.text.slice(0, 1500) + `\n[...use get_session("${r.sessionId}") for full text]`
      : r.text;
    lines.push(`--- Session [id=${r.sessionId}, date=${dateStr}] ---\n${preview}\n`);
  }
  return lines.join("\n");
}

/** Execute a single tool call against production stores. */
async function executeTool(
  name: string,
  args: Record<string, unknown>,
  deps: AgentLoopDependencies,
  user?: string,
): Promise<string> {
  try {
    switch (name) {
      case "search_sessions": {
        const query = String(args.query || "").trim();
        if (!query) return "Empty query — please provide a search term.";
        const limit = Math.min(Number(args.limit) || 10, 20);
        const searchOpts: SearchOptions & { sessionK?: number } = {
          limit: limit * 3,
          sessionK: limit,
          user,
        };
        const results = await deps.searchEngine.searchSessionLevel(query, searchOpts);
        return formatSessionResults(results.slice(0, limit));
      }

      case "search_events": {
        if (!deps.eventStore) {
          return "Event store not available. Use search_sessions instead.";
        }
        const query = String(args.query || "").trim();
        if (!query) return "Empty query — please provide a search term.";
        const limit = Math.min(Number(args.limit) || 15, 50);
        const events = await deps.eventStore.search(query, limit);
        if (events.length === 0) return "No events found. Try search_sessions instead.";
        const lines = [`Found ${events.length} structured event(s):\n`];
        for (const e of events) {
          const dateTag = e.startDate ? ` [${e.startDate}]` : "";
          lines.push(`- [session ${e.sessionId}] ${e.subject} ${e.verb} ${e.object}${dateTag}`);
        }
        return lines.join("\n");
      }

      case "get_session": {
        const sessionId = String(args.session_id || "").trim();
        if (!sessionId) return "session_id is required.";
        const chunks = await deps.documentStore.getBySession(sessionId);
        if (chunks.length === 0) return `No session found with ID "${sessionId}".`;
        // Sort by message index to reconstruct conversation order
        chunks.sort((a, b) => a.messageIndex - b.messageIndex);
        const fullText = chunks.map((c) => c.text).join("\n\n");
        const date = new Date(chunks[0].timestamp);
        const dateStr = isNaN(date.getTime()) ? "Unknown date" : date.toISOString().split("T")[0];
        const truncated = fullText.length > 8000
          ? fullText.slice(0, 8000) + "\n\n[...session truncated — use a more specific search query]"
          : fullText;
        return `Session [id=${sessionId}, date=${dateStr}]:\n\n${truncated}`;
      }

      case "search_knowledge": {
        if (!deps.knowledgeStore) {
          return "Knowledge store not available. Use search_sessions instead.";
        }
        const query = String(args.query || "").trim();
        if (!query) return "Empty query.";
        const limit = Math.min(Number(args.limit) || 10, 20);
        const entries = await deps.knowledgeStore.search(query, undefined, user);
        if (entries.length === 0) return "No knowledge entries found. Try search_sessions.";
        const limited = entries.slice(0, limit);
        const lines = [`Found ${limited.length} knowledge entry/ies:\n`];
        for (const e of limited) {
          lines.push(`- [${e.type}, session=${e.sessionId}] ${e.summary}`);
          if (e.details) lines.push(`  Details: ${e.details}`);
        }
        return lines.join("\n");
      }

      case "count_sessions": {
        const sessionIds = await deps.documentStore.getSessionIds();
        const count = sessionIds.size;
        if (count === 0) return "No sessions found in the database.";
        // Get date range by fetching all documents and finding min/max timestamps
        const allDocs = await deps.documentStore.getAllDocuments();
        let earliest = Infinity;
        let latest = -Infinity;
        for (const doc of allDocs) {
          if (doc.timestamp < earliest) earliest = doc.timestamp;
          if (doc.timestamp > latest) latest = doc.timestamp;
        }
        const earliestStr = earliest === Infinity ? "unknown" : new Date(earliest).toISOString().split("T")[0];
        const latestStr = latest === -Infinity ? "unknown" : new Date(latest).toISOString().split("T")[0];
        return `Total sessions: ${count}\nDate range: ${earliestStr} to ${latestStr}`;
      }

      case "search_by_date": {
        const afterStr = String(args.after_date || "").trim();
        const beforeStr = String(args.before_date || "").trim();
        if (!afterStr || !beforeStr) return "Both after_date and before_date are required (YYYY-MM-DD format).";
        const afterMs = new Date(afterStr).getTime();
        const beforeMs = new Date(beforeStr + "T23:59:59").getTime();
        if (isNaN(afterMs) || isNaN(beforeMs)) return "Invalid date format. Use YYYY-MM-DD.";
        const limit = Math.min(Number(args.limit) || 10, 30);
        const results = await deps.searchEngine.searchByDateRange(afterMs, beforeMs, { limit, user });
        if (results.length === 0) return `No sessions found between ${afterStr} and ${beforeStr}.`;
        return formatSessionResults(results);
      }

      default:
        return `Unknown tool: ${name}.`;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Tool error in ${name}: ${msg}`;
  }
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(
  sessionCount: number,
  procedure: string,
  currentDate: string,
): string {
  return [
    "You are a memory assistant answering questions from a user's conversation history.",
    `You have access to search tools to find relevant information across ${sessionCount} conversation sessions.`,
    "",
    // OpenAI GPT-4.1 prompting guide: three critical agentic instructions
    "",
    "# Agent Instructions",
    "",
    // 1. Persistence — prevent premature convergence
    "You are an agent — keep searching until you are SURE you have found all relevant information. " +
    "Do NOT stop after one or two searches. Only produce your final answer when you are confident " +
    "you have thoroughly covered the user's conversation history. If you found fewer items than " +
    "expected, search again with different vocabulary.",
    "",
    // 2. Tool-calling — prevent hallucination/guessing
    "If you are not sure about the content of a conversation session, use get_session to read it " +
    "in full — do NOT guess or assume what a session contains based on a preview. Always verify " +
    "your findings by reading the actual session text before including an item in your count.",
    "",
    // 3. Planning + reflection — prevent blind tool chaining
    "You MUST plan extensively before each function call, and reflect extensively on the outcomes " +
    "of the previous function calls. After each search result, write out what you found and what " +
    "is still missing before deciding your next action. DO NOT chain function calls without " +
    "reflecting on results in between.",
    "",
    "# Procedure",
    "",
    procedure,
    "",
    `Current date: ${currentDate}`,
    "",
    // Repeat key instructions at end (OpenAI guide: place instructions at both beginning AND end)
    "REMEMBER: Search thoroughly with multiple different queries before answering. Verify items " +
    "with get_session. Reflect on what you found after each search. When you are confident your " +
    "answer is complete, output ONLY your final answer with supporting evidence.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Main agent loop
// ---------------------------------------------------------------------------

/**
 * Run an iterative retrieval agent loop over the user's conversation history.
 *
 * The loop:
 * 1. Classifies the question type (counting, temporal, factual, etc.)
 * 2. Selects the appropriate procedure and tool subset
 * 3. Iteratively calls the LLM with tools until it produces a final answer
 * 4. Enforces token budget and iteration limits
 *
 * @param query - The user's question
 * @param deps - Production Strata stores (search engine, event store, etc.)
 * @param options - Optional overrides for iterations, provider, model
 * @returns The agent's answer with metadata (latency, iterations, token usage)
 * @throws Error if reasoning is disabled or no provider is available
 */
export async function runAgentLoop(
  query: string,
  deps: AgentLoopDependencies,
  options?: AgentLoopOptions,
): Promise<AgentLoopResult> {
  // Gate: reasoning must be enabled
  if (!CONFIG.reasoning.enabled) {
    throw new Error(
      "Reasoning agent loop is disabled. Set CONFIG.reasoning.enabled = true or " +
      "set the STRATA_REASONING_ENABLED environment variable.",
    );
  }

  const maxIterations = options?.maxIterations ?? CONFIG.reasoning.maxIterations;
  const maxTokens = CONFIG.reasoning.maxTokensPerQuery;

  // Create the provider (auto-detect or explicit)
  const providerName = options?.provider || CONFIG.reasoning.provider;
  const modelName = options?.model || CONFIG.reasoning.model || undefined;
  const provider: ToolCallingProvider = createToolCallingProvider(providerName, modelName);

  // Classify question and select procedure
  const questionType = classifyQuestion(query);
  const procedure = getProcedure(questionType);
  const toolSubset = getToolSubset(questionType);

  // Filter tools: only include tools in the subset AND whose stores are available
  const availableTools: ToolDefinition[] = [];
  for (const toolName of toolSubset) {
    // Skip tools whose backing stores are not available
    if (toolName === "search_events" && !deps.eventStore) continue;
    if (toolName === "search_knowledge" && !deps.knowledgeStore) continue;

    const toolDef = ALL_TOOLS[toolName];
    if (toolDef) {
      availableTools.push(toolDef);
    }
  }

  // Get session count for the system prompt
  const sessionIds = await deps.documentStore.getSessionIds();
  const sessionCount = sessionIds.size;

  // Build system prompt with current date
  const currentDate = new Date().toISOString().split("T")[0];
  const systemPrompt = buildSystemPrompt(sessionCount, procedure, currentDate);

  // Initialize conversation
  const messages: AgentMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: query },
  ];

  const toolCallLog: AgentLoopResult["toolCallLog"] = [];
  const start = performance.now();
  let iterations = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  // Iterative loop
  while (iterations < maxIterations) {
    iterations++;

    const response = await provider.chatWithTools(messages, availableTools, {
      temperature: 0,
      maxTokens: 2048,
    });

    // Track token usage
    totalPromptTokens += response.usage?.promptTokens ?? 0;
    totalCompletionTokens += response.usage?.completionTokens ?? 0;

    // Model produced a final text answer (no tool calls)
    if (response.finishReason === "stop" || !response.toolCalls?.length) {
      return {
        answer: (response.content || "Unable to determine answer.").trim(),
        questionType,
        latencyMs: performance.now() - start,
        iterations,
        toolCallLog,
        tokenUsage: {
          promptTokens: totalPromptTokens,
          completionTokens: totalCompletionTokens,
        },
      };
    }

    // Add assistant message with tool calls
    messages.push({
      role: "assistant",
      content: response.content,
      toolCalls: response.toolCalls,
    });

    // Execute each tool call and add results
    for (const toolCall of response.toolCalls) {
      const result = await executeTool(
        toolCall.name,
        toolCall.arguments,
        deps,
        options?.user,
      );

      toolCallLog.push({
        tool: toolCall.name,
        args: toolCall.arguments,
        resultLength: result.length,
      });

      messages.push({
        role: "tool",
        toolCallId: toolCall.id,
        content: result,
      });
    }

    // Check token budget AFTER processing the response — don't discard work already done.
    // Budget enforcement prevents the next LLM call, not the current one.
    const totalTokens = totalPromptTokens + totalCompletionTokens;
    if (totalTokens > maxTokens) {
      break;
    }
  }

  // Max iterations or token budget exceeded — force a final answer
  messages.push({
    role: "user",
    content: "You have reached the search limit. Based on everything you found, state your best answer now.",
  });

  const finalResponse = await provider.chatWithTools(messages, [], {
    temperature: 0,
    maxTokens: 2048,
  });
  totalPromptTokens += finalResponse.usage?.promptTokens ?? 0;
  totalCompletionTokens += finalResponse.usage?.completionTokens ?? 0;

  return {
    answer: (finalResponse.content || "Unable to determine answer.").trim(),
    questionType,
    latencyMs: performance.now() - start,
    iterations: iterations + 1,
    toolCallLog,
    tokenUsage: {
      promptTokens: totalPromptTokens,
      completionTokens: totalCompletionTokens,
    },
  };
}
