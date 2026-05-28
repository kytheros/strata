/**
 * Agent Loop for LongMemEval Benchmark
 *
 * Implements iterative retrieval via OpenAI function calling.
 * GPT-4o calls Strata search tools iteratively until it has enough
 * context to answer the question.
 *
 * Inspired by Chronos's ReAct tool-calling architecture (91.73% multi-session with GPT-4o).
 * Uses OpenAI function calling instead of text-based ReAct — schema-enforced, no parsing fragility.
 *
 * Usage:
 *   npx tsx benchmarks/longmemeval/run-benchmark.ts --agent-loop --max-iterations=8 \
 *     --skip=70 --limit=31 --session-scoring --reranker=onnx --events --event-top-k=9999
 */

import type { LongMemQuestion, LongMemTurn } from "./types.js";
import type { IngestedQuestion } from "./ingest.js";
import { strataSessionIdToIndex } from "./ingest.js";
import { loadCachedEvents, filterEventsByRelevance, type ExtractedEvent, type SVOEvent } from "./extract-events.js";
import { searchEventsFts } from "./benchmark-schema.js";
import { searchByDateRange } from "./retrieve.js";
import { deduplicateToSessions, isCountingQuestion, isDurationQuestion } from "./answer.js";
import { LlmError } from "../../src/extensions/llm-extraction/llm-provider.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

type AgentMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface AgentLoopOptions {
  maxIterations?: number;
  includeGrep?: boolean;
}

/**
 * A single training-pair capture from one agent-loop decision.
 * Buffered during the loop, written to training_data table by the caller
 * after the judge returns a verdict.
 *
 * Spec: specs/2026-05-28-reasoning-trace-capture-design.md
 */
export type CapturePair =
  | {
      kind: "reasoning_tool_call";
      messages: Array<{ role: string; content?: string | null; [k: string]: unknown }>;
      toolCall: { name: string; args: unknown };
      reasoning: string | null;
    }
  | {
      kind: "reasoning_final_answer";
      messages: Array<{ role: string; content?: string | null; [k: string]: unknown }>;
      answer: string;
      reasoning: string | null;
    };

export interface AgentLoopResult {
  answer: string;
  latencyMs: number;
  iterations: number;
  toolCallLog: Array<{
    tool: string;
    args: Record<string, unknown>;
    resultLength: number;
  }>;
  tokenUsage: { promptTokens: number; completionTokens: number };
  /** Captured (state → reasoning → action) training pairs. Empty if loop crashed. */
  captureBuffer: CapturePair[];
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOL_SEARCH_SESSIONS: OpenAITool = {
  type: "function",
  function: {
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
  },
};

const TOOL_SEARCH_EVENTS: OpenAITool = {
  type: "function",
  function: {
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
  },
};

const TOOL_GET_SESSION: OpenAITool = {
  type: "function",
  function: {
    name: "get_session",
    description:
      "Retrieve the complete text of a specific conversation session by its index. " +
      "Use this when search_sessions returns a promising session and you need to " +
      "read the full conversation to verify details or extract exact numbers. " +
      "The index is shown in search results as [idx=N].",
    parameters: {
      type: "object",
      properties: {
        session_index: {
          type: "number",
          description: "Haystack index of the session (0-based, shown as idx=N in results).",
        },
      },
      required: ["session_index"],
    },
  },
};

const TOOL_SEARCH_KNOWLEDGE: OpenAITool = {
  type: "function",
  function: {
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
  },
};

const TOOL_COUNT_SESSIONS: OpenAITool = {
  type: "function",
  function: {
    name: "count_sessions",
    description:
      "Returns the total number of conversation sessions and the date range. " +
      "Call this first to understand the scope of the history.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
};

const TOOL_SEARCH_BY_DATE: OpenAITool = {
  type: "function",
  function: {
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
  },
};

const TOOL_GREP_SESSIONS: OpenAITool = {
  type: "function",
  function: {
    name: "grep_sessions",
    description:
      "Find sessions containing an exact keyword or phrase (case-insensitive). " +
      "Use when you know a specific name, brand, or technical term. " +
      "More precise than search_sessions for known exact terms. " +
      "Example inputs: 'Tamiya', 'Golden Retriever', 'Dr. Johnson'.",
    parameters: {
      type: "object",
      properties: {
        term: {
          type: "string",
          description: "Exact keyword or phrase (case-insensitive).",
        },
      },
      required: ["term"],
    },
  },
};

// ---------------------------------------------------------------------------
// Question-type procedures (skills)
// ---------------------------------------------------------------------------

// Individual procedures — selected by selectProcedure() based on question type regex
const PROCEDURE_COUNTING = `COUNTING PROCEDURE:
This question asks you to count discrete items across multiple conversations.

Required steps:
1. Call count_sessions() first to understand the total scope.
2. Call search_events() with the topic keyword — gives structured entries, one per distinct event.
3. Call search_sessions() with 2-3 different phrasings. Same topic uses different words:
   "purchased" vs "bought" vs "ordered" vs "got" vs "picked up".
   "attended" vs "went to" vs "was at" vs "showed up for".
4. For any session that looks promising, call get_session() to read the full conversation.
5. Before counting: list ALL candidate items found across all your searches.
   Identify duplicates explicitly: the same item mentioned in 3 sessions = 1 item, not 3.
   Apply the question's exact qualifier strictly.
6. State your final count with the complete list of qualifying items as evidence.

IMPORTANT: Do not commit to a count until you have run at least 3 searches with different vocabulary.`;

const PROCEDURE_DURATION = `DURATION PROCEDURE:
This question asks you to add up time periods or amounts across conversations.

Required steps:
1. Call search_events() with the activity type to find structured time/amount entries.
2. Call search_sessions() with 2 phrasings — people describe durations differently.
3. For sessions with ambiguous numbers, call get_session() to read the exact value.
4. List every time period or amount found with its unit.
5. Check for duplicates: the same period mentioned in two sessions = count once.
6. Sum the qualifying values and state the total with units.`;

const PROCEDURE_COMPARISON = `COMPARISON PROCEDURE:
This question asks which option is most/least frequent, or ranks highest/lowest.

Required steps:
1. Call search_sessions() with the topic.
2. Call search_events() to enumerate distinct instances.
3. For each candidate, call get_session() to get exact values (amounts, counts, dates).
4. Compare explicitly: "Option X = value1, Option Y = value2."
5. State the winner with evidence.`;

const PROCEDURE_TEMPORAL = `TEMPORAL PROCEDURE:
This question asks about when something happened or the order of events.

Required steps:
1. Call search_sessions() with the event topic.
2. Call search_events() — event entries have explicit date fields.
3. If multiple sessions discuss the same event, use the earliest session date.
4. For "before/after" questions, compare timestamps explicitly.
5. State the date or time relationship clearly, citing session dates as evidence.`;

const PROCEDURE_FACTUAL = `FACTUAL PROCEDURE:
This question asks about a specific fact from the user's conversation history.

Required steps:
1. Call search_sessions() with the topic.
2. IMMEDIATELY call get_session() on the top 1-2 results to read the FULL conversation text.
   The answer is almost always in the full session text, even if the preview doesn't show it.
3. If you found the answer in the session text, answer immediately. Do not keep searching.
4. Only if get_session() did not contain the answer, try search_sessions() with different keywords,
   then get_session() on those results.
5. 2-3 search+read cycles should be sufficient.

CRITICAL: You MUST call get_session() to read sessions. Do NOT answer based only on previews,
and do NOT keep calling search_sessions/search_knowledge without reading session text first.`;

function isTemporalQuestion(q: string): boolean {
  return /when did|what date|what day|what year|what month|how long ago|before or after|which came first|what time/i.test(q);
}

function isComparisonQuestion(q: string): boolean {
  return /which.*most|which.*least|most.*time|most.*often|most expensive|cheapest|highest|lowest|most money|most followers/i.test(q);
}

function selectProcedure(question: string): string {
  if (isDurationQuestion(question)) return PROCEDURE_DURATION;
  if (isCountingQuestion(question)) return PROCEDURE_COUNTING;
  if (isComparisonQuestion(question)) return PROCEDURE_COMPARISON;
  if (isTemporalQuestion(question)) return PROCEDURE_TEMPORAL;
  return PROCEDURE_FACTUAL;
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

function turnsToText(turns: LongMemTurn[]): string {
  return turns
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`)
    .join("\n\n");
}

function formatSessionResultsForAgent(
  results: Array<{ sessionId: string; text: string; timestamp: number; score: number }>,
  question: LongMemQuestion
): string {
  if (results.length === 0) return "No sessions found. Try different keywords.";

  const lines = [`Found ${results.length} session(s):\n`];
  for (const r of results) {
    const idx = strataSessionIdToIndex(r.sessionId);
    const date = new Date(r.timestamp);
    const dateStr = isNaN(date.getTime()) ? "Unknown date" : date.toISOString().split("T")[0];
    const preview = r.text.length > 1500
      ? r.text.slice(0, 1500) + `\n[...use get_session(${idx}) for full text]`
      : r.text;
    lines.push(`--- Session [idx=${idx}, date=${dateStr}] ---\n${preview}\n`);
  }
  return lines.join("\n");
}

function formatEventsForAgent(events: ExtractedEvent[]): string {
  if (events.length === 0) return "No events found. Try search_sessions instead.";

  const lines = [`Found ${events.length} event(s):\n`];
  for (const e of events) {
    const dateTag = e.date ? `, date=${e.date}` : "";
    lines.push(`- [idx=${e.sessionIndex}, category=${e.category}${dateTag}] ${e.summary}`);
  }
  return lines.join("\n");
}

function formatSVOEventsForAgent(events: SVOEvent[]): string {
  if (events.length === 0) return "No events found. Try search_sessions instead.";

  const lines = [`Found ${events.length} structured event(s):\n`];
  for (const e of events) {
    const dateTag = e.startDate ? ` [${e.startDate}]` : "";
    lines.push(`- [session ${e.sessionIndex}] ${e.subject} ${e.verb} ${e.object}${dateTag}`);
  }
  return lines.join("\n");
}

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  question: LongMemQuestion,
  ingested: IngestedQuestion
): Promise<string> {
  try {
    switch (name) {
      case "search_sessions": {
        const query = String(args.query || "").trim();
        if (!query) return "Empty query — please provide a search term.";
        const limit = Math.min(Number(args.limit) || 10, 20);
        const results = await ingested.searchEngine.searchSessionLevel(
          query,
          { limit: limit * 3, sessionK: limit }
        );
        const deduped = deduplicateToSessions(results);
        return formatSessionResultsForAgent(deduped.slice(0, limit), question);
      }

      case "search_events": {
        const query = String(args.query || "").trim();
        if (!query) return "Empty query — please provide a search term.";
        const limit = Math.min(Number(args.limit) || 15, 50);

        // Try FTS5 event search first (searches SVO fields + aliases)
        if (ingested.eventCount > 0) {
          const svoResults = searchEventsFts(ingested.db, query, limit);
          if (svoResults.length > 0) {
            return formatSVOEventsForAgent(svoResults);
          }
        }

        // Fallback to legacy cache with token overlap filtering
        const cached = loadCachedEvents(ingested.questionId);
        if (!cached || cached.events.length === 0) {
          return "No events found for this query. Try search_sessions instead.";
        }
        const relevant = filterEventsByRelevance(cached.events, query, limit);
        return formatEventsForAgent(relevant);
      }

      case "get_session": {
        const idx = Number(args.session_index);
        if (isNaN(idx) || idx < 0 || idx >= question.haystack_sessions.length) {
          return `Invalid session index ${idx}. Valid range: 0–${question.haystack_sessions.length - 1}.`;
        }
        const turns = question.haystack_sessions[idx];
        const date = question.haystack_dates?.[idx] || "Unknown date";
        const text = turnsToText(turns);
        const truncated = text.length > 8000
          ? text.slice(0, 8000) + "\n\n[...session truncated — use a more specific search query]"
          : text;
        return `Session [idx=${idx}, date=${date}]:\n\n${truncated}`;
      }

      case "search_knowledge": {
        const query = String(args.query || "").trim();
        if (!query) return "Empty query.";
        const limit = Math.min(Number(args.limit) || 10, 20);
        const term = `%${query}%`;
        const stmt = ingested.db.prepare(`
          SELECT summary, details, entry_type as type, session_id as sessionId
          FROM knowledge
          WHERE summary LIKE ? OR details LIKE ?
          ORDER BY created_at DESC
          LIMIT ?
        `);
        const rows = stmt.all(term, term, limit) as Array<{
          summary: string; details: string; type: string; sessionId: string;
        }>;
        if (rows.length === 0) return "No knowledge entries found. Try search_sessions.";
        const lines = [`Found ${rows.length} knowledge entry/ies:\n`];
        for (const e of rows) {
          const idx = strataSessionIdToIndex(e.sessionId);
          lines.push(`- [${e.type}, idx=${idx}] ${e.summary}`);
          if (e.details) lines.push(`  Details: ${e.details}`);
        }
        return lines.join("\n");
      }

      case "count_sessions": {
        const count = question.haystack_sessions.length;
        const dates = (question.haystack_dates || []).filter(Boolean).sort();
        const earliest = dates[0] || "unknown";
        const latest = dates[dates.length - 1] || "unknown";
        return `Total sessions: ${count}\nDate range: ${earliest} to ${latest}`;
      }

      case "search_by_date": {
        const afterStr = String(args.after_date || "").trim();
        const beforeStr = String(args.before_date || "").trim();
        if (!afterStr || !beforeStr) return "Both after_date and before_date are required (YYYY-MM-DD format).";
        const afterMs = new Date(afterStr).getTime();
        const beforeMs = new Date(beforeStr + "T23:59:59").getTime();
        if (isNaN(afterMs) || isNaN(beforeMs)) return "Invalid date format. Use YYYY-MM-DD.";
        const limit = Math.min(Number(args.limit) || 10, 30);
        const dateResults = searchByDateRange(ingested.db, afterMs, beforeMs, limit);
        if (dateResults.length === 0) return `No sessions found between ${afterStr} and ${beforeStr}.`;
        const lines = [`Found ${dateResults.length} session(s) between ${afterStr} and ${beforeStr}:\n`];
        for (const r of dateResults) {
          const idx = strataSessionIdToIndex(r.sessionId);
          const date = new Date(r.timestamp);
          const dateStr = isNaN(date.getTime()) ? "Unknown" : date.toISOString().split("T")[0];
          const preview = r.text.length > 1500
            ? r.text.slice(0, 1500) + `\n[...use get_session(${idx}) for full text]`
            : r.text;
          lines.push(`--- Session [idx=${idx}, date=${dateStr}] ---\n${preview}\n`);
        }
        return lines.join("\n");
      }

      case "grep_sessions": {
        const term = String(args.term || "").toLowerCase().trim();
        if (!term) return "Empty grep term.";
        const matches: string[] = [];
        for (let i = 0; i < question.haystack_sessions.length; i++) {
          const text = question.haystack_sessions[i].map(t => t.content).join("\n").toLowerCase();
          if (text.includes(term)) {
            const date = question.haystack_dates?.[i] || "Unknown";
            matches.push(`idx=${i} (${date})`);
          }
        }
        if (matches.length === 0) return `No sessions found containing "${args.term}".`;
        return `Sessions containing "${args.term}" (${matches.length} found):\n${matches.join("\n")}`;
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
// OpenAI function calling API
// ---------------------------------------------------------------------------

async function callOpenAIWithTools(
  apiKey: string,
  model: string,
  messages: AgentMessage[],
  tools: OpenAITool[]
): Promise<{
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  finish_reason: string;
  usage?: { promptTokens: number; completionTokens: number };
}> {
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: 0,
    max_tokens: 2048,
  };

  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
    // OpenAI guide: parallel tool calls can be incorrect; disable for reliability
    body.parallel_tool_calls = false;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (response.status === 429) {
      throw new LlmError("OpenAI rate limit exceeded", "openai", 429);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new LlmError(`OpenAI API error: ${response.status} ${text}`, "openai", response.status);
    }

    const data = await response.json() as any;
    const choice = data.choices?.[0];

    return {
      content: choice?.message?.content ?? null,
      tool_calls: choice?.message?.tool_calls,
      finish_reason: choice?.finish_reason || "stop",
      usage: data.usage
        ? { promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens }
        : undefined,
    };
  } catch (err) {
    if (err instanceof LlmError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new LlmError("OpenAI request timed out after 90s", "openai");
    }
    throw new LlmError(
      `OpenAI request failed: ${err instanceof Error ? err.message : String(err)}`,
      "openai"
    );
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Main agent loop
// ---------------------------------------------------------------------------

export async function runAgentLoop(
  apiKey: string,
  model: string,
  question: LongMemQuestion,
  ingested: IngestedQuestion,
  options: AgentLoopOptions = {}
): Promise<AgentLoopResult> {
  const { maxIterations = 8, includeGrep = false } = options;

  const tools: OpenAITool[] = [
    TOOL_SEARCH_SESSIONS,
    TOOL_SEARCH_EVENTS,
    TOOL_GET_SESSION,
    TOOL_SEARCH_KNOWLEDGE,
    TOOL_COUNT_SESSIONS,
    TOOL_SEARCH_BY_DATE,
    ...(includeGrep ? [TOOL_GREP_SESSIONS] : []),
  ];

  const procedure = selectProcedure(question.question);

  const systemPrompt = [
    "You are a memory assistant answering questions from a user's conversation history.",
    `You have access to search tools to find relevant information across ${ingested.sessionCount} conversation sessions.`,
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
    `Current date: ${question.question_date}`,
    "",
    // Repeat key instructions at end (OpenAI guide: place instructions at both beginning AND end)
    "REMEMBER: Search thoroughly with multiple different queries before answering. Verify items " +
    "with get_session. Reflect on what you found after each search. When you are confident your " +
    "answer is complete, output ONLY your final answer with supporting evidence.",
  ].join("\n");

  const messages: AgentMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: question.question },
  ];

  const toolCallLog: AgentLoopResult["toolCallLog"] = [];
  const captureBuffer: CapturePair[] = [];
  const start = performance.now();
  let iterations = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  while (iterations < maxIterations) {
    iterations++;
    const response = await callOpenAIWithTools(apiKey, model, messages, tools);

    totalPromptTokens += response.usage?.promptTokens ?? 0;
    totalCompletionTokens += response.usage?.completionTokens ?? 0;

    // Model produced a final text answer (no tool calls)
    if (response.finish_reason === "stop" || !response.tool_calls?.length) {
      const answer = (response.content || "Unable to determine answer.").trim();
      // Capture the final-answer training pair against the state that produced it.
      captureBuffer.push({
        kind: "reasoning_final_answer",
        messages: messages.map((m) => ({ ...m })),
        answer,
        reasoning: null,
      });
      return {
        answer,
        latencyMs: performance.now() - start,
        iterations,
        toolCallLog,
        tokenUsage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens },
        captureBuffer,
      };
    }

    // Snapshot the state that produced the upcoming tool_call decisions BEFORE
    // we mutate messages with the assistant turn. This is the (state) half of
    // the captured (state → reasoning → action) training pair.
    const decisionInputMessages = messages.map((m) => ({ ...m }));
    const decisionReasoning = response.content || null;

    // Add assistant message with tool calls
    messages.push({
      role: "assistant",
      content: response.content,
      tool_calls: response.tool_calls,
    });

    // Execute each tool call and add results
    for (const toolCall of response.tool_calls) {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
      } catch {
        args = {};
      }

      // Capture (state → reasoning → action) training pair before tool execution.
      captureBuffer.push({
        kind: "reasoning_tool_call",
        messages: decisionInputMessages,
        toolCall: { name: toolCall.function.name, args },
        reasoning: decisionReasoning,
      });

      const result = await executeTool(toolCall.function.name, args, question, ingested);

      toolCallLog.push({
        tool: toolCall.function.name,
        args,
        resultLength: result.length,
      });

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result,
      });
    }
  }

  // Max iterations — force a final answer
  messages.push({
    role: "user",
    content: "You have reached the search limit. Based on everything you found, state your best answer now.",
  });

  const finalResponse = await callOpenAIWithTools(apiKey, model, messages, []);
  totalPromptTokens += finalResponse.usage?.promptTokens ?? 0;
  totalCompletionTokens += finalResponse.usage?.completionTokens ?? 0;

  const forcedAnswer = (finalResponse.content || "Unable to determine answer.").trim();
  // Capture the forced-final-answer training pair against the state that produced it.
  captureBuffer.push({
    kind: "reasoning_final_answer",
    messages: messages.map((m) => ({ ...m })),
    answer: forcedAnswer,
    reasoning: null,
  });
  return {
    answer: forcedAnswer,
    latencyMs: performance.now() - start,
    iterations: maxIterations + 1,
    toolCallLog,
    tokenUsage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens },
    captureBuffer,
  };
}
