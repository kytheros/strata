/**
 * Gemini-native Agent Loop for LongMemEval Benchmark
 *
 * Same tools and procedures as agent-loop.ts (OpenAI), but uses Gemini's
 * native function calling API instead of OpenAI's tool_calls format.
 *
 * Gemini function calling:
 * - Tools defined as functionDeclarations in request config
 * - Model returns functionCall parts with {id, name, args}
 * - Results sent as functionResponse parts with matching id
 * - Uses generateContent REST endpoint
 *
 * Docs: https://ai.google.dev/gemini-api/docs/function-calling
 */

import type { LongMemQuestion, LongMemTurn } from "./types.js";
import type { IngestedQuestion } from "./ingest.js";
import { strataSessionIdToIndex } from "./ingest.js";
import { loadCachedEvents, filterEventsByRelevance, type ExtractedEvent, type SVOEvent } from "./extract-events.js";
import { searchEventsFts } from "./benchmark-schema.js";
import { searchByDateRange } from "./retrieve.js";
import { deduplicateToSessions, isCountingQuestion, isDurationQuestion } from "./answer.js";
import type { CapturePair } from "./agent-loop.js";
import type { MinimalGenAIClient } from "../../src/extensions/llm-extraction/vertex-gemini-provider.js";
import { withVertexBackoff } from "./vertex-backoff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface GeminiFunctionCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

interface GeminiPart {
  text?: string;
  functionCall?: GeminiFunctionCall;
  functionResponse?: { name: string; id?: string; response: { result: string } };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export interface GeminiAgentLoopOptions {
  maxIterations?: number;
  /**
   * When provided, the loop calls Vertex AI (via the injected @google/genai
   * client) instead of the AI Studio HTTP endpoint. The request shape is
   * identical under the unified SDK — only auth + URL differ.
   */
  vertexClient?: MinimalGenAIClient;
}

export interface GeminiAgentLoopResult {
  answer: string;
  latencyMs: number;
  iterations: number;
  toolCallLog: Array<{ tool: string; args: Record<string, unknown>; resultLength: number }>;
  /** Captured (state → reasoning → action) training pairs. Empty if loop crashed. */
  captureBuffer: CapturePair[];
}

// ---------------------------------------------------------------------------
// Tool declarations (Gemini format — same semantics as agent-loop.ts)
// ---------------------------------------------------------------------------

const TOOL_DECLARATIONS: GeminiFunctionDeclaration[] = [
  {
    name: "search_sessions",
    description:
      "Search conversation sessions by semantic meaning and keywords. Returns the most " +
      "relevant sessions with dates and content previews. Try multiple queries with " +
      "DIFFERENT vocabulary if the first search misses expected sessions.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query. Natural language or key phrases." },
        limit: { type: "number", description: "Maximum sessions to return (default 10, max 20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "search_events",
    description:
      "Search a structured calendar of events extracted from conversations. Returns " +
      "discrete activities, purchases, and facts. Each entry is one distinct event. " +
      "ALWAYS use for counting questions alongside search_sessions.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search keywords for events." },
        limit: { type: "number", description: "Maximum events to return (default 15, max 50)." },
      },
      required: ["query"],
    },
  },
  {
    name: "get_session",
    description:
      "Retrieve the complete text of a specific conversation session by its index. " +
      "Use when search_sessions returns a promising session and you need the full text. " +
      "The index is shown in search results as [idx=N].",
    parameters: {
      type: "object",
      properties: {
        session_index: { type: "number", description: "Haystack index (0-based, shown as idx=N)." },
      },
      required: ["session_index"],
    },
  },
  {
    name: "search_knowledge",
    description:
      "Search structured knowledge entries — facts, preferences, episodic memories. " +
      "Good for factual questions. Complements search_sessions.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query for knowledge entries." },
        limit: { type: "number", description: "Maximum entries (default 10, max 20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "count_sessions",
    description: "Returns total session count and date range. Call first to understand scope.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "search_by_date",
    description:
      "Find sessions within a specific date range. Use for temporal questions. " +
      "Keep the window NARROW (a few days) for best results. " +
      "Example: after_date='2023-03-24', before_date='2023-03-26'.",
    parameters: {
      type: "object",
      properties: {
        after_date: { type: "string", description: "Start date (YYYY-MM-DD)." },
        before_date: { type: "string", description: "End date (YYYY-MM-DD)." },
        limit: { type: "number", description: "Maximum sessions (default 10)." },
      },
      required: ["after_date", "before_date"],
    },
  },
];

// ---------------------------------------------------------------------------
// Procedures (reused from agent-loop.ts)
// ---------------------------------------------------------------------------

const PROCEDURE_COUNTING = `COUNTING PROCEDURE:
1. Call count_sessions() to understand scope.
2. Call search_events() with the topic keyword.
3. Call search_sessions() with 2-3 different phrasings.
4. Call get_session() on promising sessions to verify.
5. List ALL candidates. Deduplicate: same item in 3 sessions = 1 item.
6. State your count with evidence.
Do not commit to a count until you have searched with at least 3 different phrasings.`;

const PROCEDURE_DURATION = `DURATION PROCEDURE:
1. Call search_events() to find time/amount entries.
2. Call search_sessions() with 2 phrasings.
3. Call get_session() for ambiguous numbers.
4. List amounts with units. Deduplicate. Sum and state total.`;

const PROCEDURE_COMPARISON = `COMPARISON PROCEDURE:
1. Call search_sessions() and search_events() with the topic.
2. Call get_session() for each candidate to get exact values.
3. Compare explicitly. State the winner with evidence.`;

const PROCEDURE_TEMPORAL = `TEMPORAL PROCEDURE:
1. Call search_sessions() with the event topic.
2. Calculate the absolute date from any relative reference in the question (e.g., "3 weeks ago" from the current date).
   Then call search_by_date(after_date="YYYY-MM-DD", before_date="YYYY-MM-DD") with a NARROW window (2-5 days) around that date.
   This is your most powerful tool for temporal questions — USE IT.
3. Call get_session() to read the full text of promising sessions and extract exact dates.
4. Show your date arithmetic briefly before answering.
CRITICAL: "I was thinking about X" means X did NOT happen on that date.`;

const PROCEDURE_FACTUAL = `FACTUAL PROCEDURE:
1. Call search_sessions() with the topic.
2. Call get_session() on top result to verify.
3. Call search_knowledge() if needed.
4. 2-3 searches is sufficient. Answer directly.`;

function selectProcedure(question: string): string {
  if (isDurationQuestion(question)) return PROCEDURE_DURATION;
  if (isCountingQuestion(question)) return PROCEDURE_COUNTING;
  if (/which.*most|which.*least|most.*time|most.*often|most expensive|cheapest|highest|lowest|most money|most followers/i.test(question)) return PROCEDURE_COMPARISON;
  if (/when did|what date|what day|what year|what month|how long ago|before or after|which came first|what time/i.test(question)) return PROCEDURE_TEMPORAL;
  return PROCEDURE_FACTUAL;
}

// ---------------------------------------------------------------------------
// Tool execution (reused logic from agent-loop.ts)
// ---------------------------------------------------------------------------

function turnsToText(turns: LongMemTurn[]): string {
  return turns.map(t => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`).join("\n\n");
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
        if (!query) return "Empty query.";
        const limit = Math.min(Number(args.limit) || 10, 20);
        const results = await ingested.searchEngine.searchSessionLevel(query, { limit: limit * 3, sessionK: limit });
        const deduped = deduplicateToSessions(results);
        if (deduped.length === 0) return "No sessions found. Try different keywords.";
        const lines = [`Found ${Math.min(deduped.length, limit)} session(s):\n`];
        for (const r of deduped.slice(0, limit)) {
          const idx = strataSessionIdToIndex(r.sessionId);
          const date = new Date(r.timestamp);
          const dateStr = isNaN(date.getTime()) ? "Unknown" : date.toISOString().split("T")[0];
          const preview = r.text.length > 1500 ? r.text.slice(0, 1500) + `\n[...use get_session(${idx}) for full text]` : r.text;
          lines.push(`--- Session [idx=${idx}, date=${dateStr}] ---\n${preview}\n`);
        }
        return lines.join("\n");
      }

      case "search_events": {
        const query = String(args.query || "").trim();
        if (!query) return "Empty query.";
        const limit = Math.min(Number(args.limit) || 15, 50);
        if (ingested.eventCount > 0) {
          const svoResults = searchEventsFts(ingested.db, query, limit);
          if (svoResults.length > 0) {
            const lines = [`Found ${svoResults.length} event(s):\n`];
            for (const e of svoResults) {
              const dateTag = e.startDate ? ` [${e.startDate}]` : "";
              lines.push(`- [session ${e.sessionIndex}] ${e.subject} ${e.verb} ${e.object}${dateTag}`);
            }
            return lines.join("\n");
          }
        }
        const cached = loadCachedEvents(ingested.questionId);
        if (!cached || cached.events.length === 0) return "No events found. Try search_sessions.";
        const relevant = filterEventsByRelevance(cached.events, query, limit);
        if (relevant.length === 0) return "No events found. Try search_sessions.";
        const lines = [`Found ${relevant.length} event(s):\n`];
        for (const e of relevant) {
          const dateTag = e.date ? `, ${e.date}` : "";
          lines.push(`- [session ${e.sessionIndex}${dateTag}] ${e.summary}`);
        }
        return lines.join("\n");
      }

      case "get_session": {
        const idx = Number(args.session_index);
        if (isNaN(idx) || idx < 0 || idx >= question.haystack_sessions.length) {
          return `Invalid index ${idx}. Valid: 0–${question.haystack_sessions.length - 1}.`;
        }
        const date = question.haystack_dates?.[idx] || "Unknown";
        const text = turnsToText(question.haystack_sessions[idx]);
        const truncated = text.length > 8000 ? text.slice(0, 8000) + "\n[...truncated]" : text;
        return `Session [idx=${idx}, date=${date}]:\n\n${truncated}`;
      }

      case "search_knowledge": {
        const query = String(args.query || "").trim();
        if (!query) return "Empty query.";
        const limit = Math.min(Number(args.limit) || 10, 20);
        const rows = ingested.db.prepare(
          `SELECT summary, details, entry_type as type, session_id as sessionId FROM knowledge WHERE summary LIKE ? OR details LIKE ? ORDER BY created_at DESC LIMIT ?`
        ).all(`%${query}%`, `%${query}%`, limit) as Array<{ summary: string; details: string; type: string; sessionId: string }>;
        if (rows.length === 0) return "No knowledge entries found. Try search_sessions.";
        const lines = [`Found ${rows.length} entry/ies:\n`];
        for (const e of rows) {
          const idx = strataSessionIdToIndex(e.sessionId);
          lines.push(`- [${e.type}, idx=${idx}] ${e.summary}`);
        }
        return lines.join("\n");
      }

      case "count_sessions": {
        const count = question.haystack_sessions.length;
        const dates = (question.haystack_dates || []).filter(Boolean).sort();
        return `Total sessions: ${count}\nDate range: ${dates[0] || "unknown"} to ${dates[dates.length - 1] || "unknown"}`;
      }

      case "search_by_date": {
        const afterStr = String(args.after_date || "").trim();
        const beforeStr = String(args.before_date || "").trim();
        if (!afterStr || !beforeStr) return "Both after_date and before_date required (YYYY-MM-DD).";
        const afterMs = new Date(afterStr).getTime();
        const beforeMs = new Date(beforeStr + "T23:59:59").getTime();
        if (isNaN(afterMs) || isNaN(beforeMs)) return "Invalid date format. Use YYYY-MM-DD.";
        const limit = Math.min(Number(args.limit) || 10, 30);
        const dateResults = searchByDateRange(ingested.db, afterMs, beforeMs, limit);
        if (dateResults.length === 0) return `No sessions between ${afterStr} and ${beforeStr}.`;
        const lines = [`Found ${dateResults.length} session(s) between ${afterStr} and ${beforeStr}:\n`];
        for (const r of dateResults) {
          const idx = strataSessionIdToIndex(r.sessionId);
          const dateStr = new Date(r.timestamp).toISOString().split("T")[0];
          const preview = r.text.length > 1500 ? r.text.slice(0, 1500) + `\n[...use get_session(${idx})]` : r.text;
          lines.push(`--- Session [idx=${idx}, date=${dateStr}] ---\n${preview}\n`);
        }
        return lines.join("\n");
      }

      default:
        return `Unknown tool: ${name}.`;
    }
  } catch (err) {
    return `Tool error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ---------------------------------------------------------------------------
// Gemini API with function calling
// ---------------------------------------------------------------------------

async function callGeminiWithTools(
  apiKey: string,
  model: string,
  contents: GeminiContent[],
  systemInstruction: string,
  tools: GeminiFunctionDeclaration[],
  vertexClient?: MinimalGenAIClient
): Promise<{
  parts: GeminiPart[];
  finishReason: string;
}> {
  // Vertex SDK path — identical request shape, different transport.
  if (vertexClient) {
    const sdkRequest = {
      model,
      contents: contents.map((c) => ({
        role: c.role,
        parts: c.parts as Array<{ text: string }>,
      })),
      config: {
        temperature: 1.0,
        maxOutputTokens: 8192,
        systemInstruction: { parts: [{ text: systemInstruction }] },
        tools: [{ functionDeclarations: tools }],
        toolConfig: { functionCallingConfig: { mode: "AUTO" } },
      },
    };
    const sdkResponse = await withVertexBackoff(() =>
      vertexClient.models.generateContent(sdkRequest as never)
    );
    const candidate = sdkResponse.candidates?.[0] as
      | { content?: { parts?: GeminiPart[] }; finishReason?: string }
      | undefined;
    return {
      parts: candidate?.content?.parts || [],
      finishReason: candidate?.finishReason || "STOP",
    };
  }

  // AI Studio path (unchanged).
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const body: Record<string, unknown> = {
    contents,
    systemInstruction: { parts: [{ text: systemInstruction }] },
    tools: [{ functionDeclarations: tools }],
    toolConfig: { functionCallingConfig: { mode: "AUTO" } },
    generationConfig: {
      temperature: 1.0, // Gemini docs: don't go below 1.0
      maxOutputTokens: 8192,
    },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (response.status === 429) {
      throw new Error("Gemini rate limit exceeded");
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Gemini API error: ${response.status} ${text.slice(0, 200)}`);
    }

    const data = await response.json() as any;
    const candidate = data.candidates?.[0];

    return {
      parts: candidate?.content?.parts || [],
      finishReason: candidate?.finishReason || "STOP",
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Main: Gemini Agent Loop
// ---------------------------------------------------------------------------

/**
 * Select a focused tool subset per question type.
 * Fewer tools = model can't default to the wrong one.
 * Mirrors Honcho's approach: different tool subsets per question type.
 *
 * Uses the LongMemEval question_type field (authoritative) for routing.
 */
function selectToolsForQuestionType(questionType: string): GeminiFunctionDeclaration[] {
  const allTools = Object.fromEntries(TOOL_DECLARATIONS.map(t => [t.name, t]));

  switch (questionType) {
    case "temporal-reasoning":
      // ONLY date search + get_session. Force the model to use date filtering.
      return [allTools.search_by_date, allTools.get_session, allTools.count_sessions];
    case "multi-session":
      return [allTools.search_events, allTools.search_sessions, allTools.get_session];
    case "knowledge-update":
      return [allTools.search_sessions, allTools.get_session];
    case "single-session-preference":
      return [allTools.search_sessions, allTools.search_knowledge, allTools.get_session];
    default:
      // single-session-user, single-session-assistant, etc.
      return [allTools.search_sessions, allTools.get_session];
  }
}

export async function runGeminiAgentLoop(
  apiKey: string,
  model: string,
  question: LongMemQuestion,
  ingested: IngestedQuestion,
  options: GeminiAgentLoopOptions = {}
): Promise<GeminiAgentLoopResult> {
  const { maxIterations = 8, vertexClient } = options;
  const procedure = selectProcedure(question.question);

  const systemInstruction = [
    "You are a memory assistant answering questions from a user's conversation history.",
    `You have access to search tools across ${ingested.sessionCount} conversation sessions.`,
    "",
    "# Agent Instructions",
    "",
    "You are an agent — keep searching until you are SURE you have found all relevant information.",
    "Do NOT stop after one or two searches. If you found fewer items than expected, search with different vocabulary.",
    "",
    "If you are not sure about a session's content, use get_session to read it in full — do NOT guess.",
    "",
    "You MUST plan before each function call and reflect on outcomes. After each search, write what you found",
    "and what is still missing before your next action.",
    "",
    "# Procedure",
    "",
    procedure,
    "",
    `Current date: ${question.question_date}`,
    "",
    "REMEMBER: Search thoroughly, verify with get_session, reflect after each search.",
    "When confident, output ONLY your final answer with evidence.",
  ].join("\n");

  const contents: GeminiContent[] = [
    { role: "user", parts: [{ text: question.question }] },
  ];

  // Category-specific tool subset — fewer tools = model can't default to wrong one
  const questionTools = selectToolsForQuestionType(question.question_type);

  const toolCallLog: GeminiAgentLoopResult["toolCallLog"] = [];
  const captureBuffer: CapturePair[] = [];
  const start = performance.now();
  let iterations = 0;

  while (iterations < maxIterations) {
    iterations++;

    const response = await callGeminiWithTools(
      apiKey, model, contents, systemInstruction, questionTools, vertexClient
    );

    // Check for function calls in the response
    const functionCalls = response.parts.filter(p => p.functionCall);
    const textParts = response.parts.filter(p => p.text);

    // No function calls — model is done, extract text answer
    if (functionCalls.length === 0 || response.finishReason === "STOP" && functionCalls.length === 0) {
      const answer = textParts.map(p => p.text).join("\n").trim() || "Unable to determine answer.";
      // Capture the final-answer training pair against the state that produced it.
      captureBuffer.push({
        kind: "reasoning_final_answer",
        messages: contents.map((c) => ({ ...c })),
        answer,
        reasoning: null,
      });
      return {
        answer,
        latencyMs: performance.now() - start,
        iterations,
        toolCallLog,
        captureBuffer,
      };
    }

    // Snapshot state and concatenate text parts as the reasoning that
    // accompanied this batch of functionCall decisions. Snapshot BEFORE
    // mutating contents so the captured pair has the inputs that led
    // to the action, not the action itself.
    const decisionInputContents = contents.map((c) => ({ ...c }));
    const decisionReasoning =
      textParts
        .map((p) => p.text)
        .filter((t): t is string => typeof t === "string" && t.length > 0)
        .join("\n")
        .trim() || null;

    // Add model's response to conversation history
    contents.push({ role: "model", parts: response.parts });

    // Execute each function call and build response parts
    const responseParts: GeminiPart[] = [];

    for (const part of functionCalls) {
      const fc = part.functionCall!;

      // Capture (state → reasoning → action) training pair before tool execution.
      captureBuffer.push({
        kind: "reasoning_tool_call",
        messages: decisionInputContents,
        toolCall: { name: fc.name, args: fc.args },
        reasoning: decisionReasoning,
      });

      const result = await executeTool(fc.name, fc.args, question, ingested);

      toolCallLog.push({
        tool: fc.name,
        args: fc.args,
        resultLength: result.length,
      });

      responseParts.push({
        functionResponse: {
          name: fc.name,
          id: fc.id,
          response: { result },
        },
      });
    }

    // Add function responses to conversation
    contents.push({ role: "user", parts: responseParts });
  }

  // Max iterations — force a final answer
  contents.push({
    role: "user",
    parts: [{ text: "You have reached the search limit. State your best answer now based on everything you found." }],
  });

  // Force final answer — keep tools available but the prompt forces a text response
  const finalResponse = await callGeminiWithTools(
    apiKey, model, contents, systemInstruction, questionTools, vertexClient
  );

  const answer = finalResponse.parts
    .filter(p => p.text)
    .map(p => p.text)
    .join("\n")
    .trim() || "Unable to determine answer.";

  // Capture the forced-final-answer training pair.
  captureBuffer.push({
    kind: "reasoning_final_answer",
    messages: contents.map((c) => ({ ...c })),
    answer,
    reasoning: null,
  });

  return {
    answer,
    latencyMs: performance.now() - start,
    iterations: maxIterations + 1,
    toolCallLog,
    captureBuffer,
  };
}
