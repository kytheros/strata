/**
 * Planned Search for LongMemEval Benchmark
 *
 * Three-phase architecture inspired by Chronos (92.60% GPT-4o) and OMEGA (95.4%):
 *
 *   Phase 1: Query Planning — cheap LLM call (GPT-4o-mini) analyzes the question
 *            and outputs a search plan (query variants, question type, time constraints)
 *
 *   Phase 2: Deterministic Multi-Search — code executes the plan against Strata's
 *            search engine. No LLM decides which tools to call. Multiple searches
 *            with vocabulary variants, results compiled and deduplicated.
 *
 *   Phase 3: Final Answer — GPT-4o reads the compiled context and answers.
 *            Pre-populated with relevant sessions (Chronos: -16.4pp without this).
 *
 * This replaces the agent loop where GPT-4o chose tools unreliably.
 * The key insight from Chronos: "the model needs pre-populated context, not just tools."
 *
 * Usage:
 *   npx tsx benchmarks/longmemeval/run-benchmark.ts --planned-search \
 *     --skip=70 --limit=31 --session-scoring --reranker=onnx --events --event-top-k=9999
 */

import type { LongMemQuestion, LongMemTurn } from "./types.js";
import type { IngestedQuestion } from "./ingest.js";
import { strataSessionIdToIndex } from "./ingest.js";
import { loadCachedEvents, filterEventsByRelevance, loadSVOEvents, type ExtractedEvent, type SVOEvent } from "./extract-events.js";
import { searchEventsFts } from "./benchmark-schema.js";
import { deduplicateToSessions, isCountingQuestion, isDurationQuestion } from "./answer.js";
import type { SearchResult } from "../../src/search/sqlite-search-engine.js";
import { LlmError } from "../../src/extensions/llm-extraction/llm-provider.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SearchPlan {
  questionType: "counting" | "duration" | "comparison" | "temporal" | "factual";
  searchQueries: string[];
  eventQuery: string;
  expectedItems?: number;
  guidance: string;
}

export interface PlannedSearchOptions {
  plannerModel?: string;
  answerModel?: string;
}

export interface PlannedSearchResult {
  answer: string;
  latencyMs: number;
  plan: SearchPlan;
  sessionsUsed: number;
  eventsUsed: number;
  tokenUsage: { promptTokens: number; completionTokens: number };
}

// ---------------------------------------------------------------------------
// Phase 1: Query Planning (cheap LLM call)
// ---------------------------------------------------------------------------

const PLANNER_PROMPT = `You are a search query planner. Given a question about a user's conversation history, output a JSON search plan.

Analyze the question and produce:
1. questionType: one of "counting", "duration", "comparison", "temporal", "factual"
2. searchQueries: 3-5 different search queries using DIFFERENT vocabulary to find all relevant sessions.
   Think about synonyms and related terms the user might have used in conversation.
   Example for "How many books did I buy?": ["books bought purchased", "ordered book novel", "reading new book", "bookstore amazon kindle"]
3. eventQuery: a short keyword query for the structured event calendar
4. guidance: 1-2 sentences telling the answer model what to focus on

Output ONLY valid JSON, no other text:
{"questionType": "counting", "searchQueries": ["query1", "query2", "query3"], "eventQuery": "short keywords", "guidance": "Focus on X and Y"}`;

function parsePlan(raw: string): SearchPlan | null {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    cleaned = cleaned.slice(start, end + 1);
  }
  try {
    const parsed = JSON.parse(cleaned);
    return {
      questionType: parsed.questionType || "factual",
      searchQueries: Array.isArray(parsed.searchQueries) ? parsed.searchQueries : [parsed.searchQueries || ""],
      eventQuery: parsed.eventQuery || "",
      guidance: parsed.guidance || "",
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Phase 2: Deterministic Multi-Search
// ---------------------------------------------------------------------------

function turnsToText(turns: LongMemTurn[]): string {
  return turns
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`)
    .join("\n\n");
}

interface CompiledContext {
  sessions: Array<{
    index: number;
    date: string;
    text: string;
    score: number;
  }>;
  events: ExtractedEvent[];
  svoEvents: SVOEvent[];
}

async function executeSearchPlan(
  plan: SearchPlan,
  question: LongMemQuestion,
  ingested: IngestedQuestion
): Promise<CompiledContext> {
  const sessionMap = new Map<string, { index: number; date: string; text: string; score: number }>();

  // Run each search query and collect unique sessions
  for (const query of plan.searchQueries) {
    if (!query.trim()) continue;
    try {
      const results = await ingested.searchEngine.searchSessionLevel(
        query,
        { limit: 60, sessionK: 10 }
      );
      const deduped = deduplicateToSessions(results);

      for (const r of deduped.slice(0, 10)) {
        const idx = strataSessionIdToIndex(r.sessionId);
        if (idx < 0) continue;
        const existing = sessionMap.get(r.sessionId);
        if (!existing || r.score > existing.score) {
          const date = new Date(r.timestamp);
          const dateStr = isNaN(date.getTime()) ? "Unknown date" : date.toISOString().split("T")[0];
          sessionMap.set(r.sessionId, {
            index: idx,
            date: dateStr,
            text: r.text,
            score: r.score,
          });
        }
      }
    } catch (err) {
      // Search failed — continue with other queries
    }
  }

  // For top sessions, read full text if we only have chunk previews
  const sessions = [...sessionMap.values()];
  sessions.sort((a, b) => b.score - a.score);

  // Read full session text for top results
  const topN = plan.questionType === "factual" ? 5 : 15;
  for (let i = 0; i < Math.min(topN, sessions.length); i++) {
    const s = sessions[i];
    if (s.index >= 0 && s.index < question.haystack_sessions.length) {
      const fullText = turnsToText(question.haystack_sessions[s.index]);
      // Only replace if full text is substantially longer (indicates we had a chunk)
      if (fullText.length > s.text.length * 1.5) {
        sessions[i].text = fullText.length > 8000
          ? fullText.slice(0, 8000) + "\n[...truncated]"
          : fullText;
      }
    }
  }

  // Search events via FTS5 (preferred) or legacy cache fallback
  let events: ExtractedEvent[] = [];
  let svoEvents: SVOEvent[] = [];

  if (plan.eventQuery) {
    // Try FTS5 event search first (searches subject, verb, object, AND aliases)
    if (ingested.eventCount > 0) {
      svoEvents = searchEventsFts(ingested.db, plan.eventQuery, 30);
      // Also try each search query as an event query for broader coverage
      for (const q of plan.searchQueries) {
        const moreEvents = searchEventsFts(ingested.db, q, 15);
        for (const e of moreEvents) {
          if (!svoEvents.some(existing =>
            existing.sessionIndex === e.sessionIndex && existing.verb === e.verb && existing.object === e.object
          )) {
            svoEvents.push(e);
          }
        }
      }
    }

    // Fallback to legacy cache if no FTS5 events
    if (svoEvents.length === 0) {
      const cached = loadCachedEvents(ingested.questionId);
      if (cached && cached.events.length > 0) {
        events = filterEventsByRelevance(cached.events, plan.eventQuery, 30);
      }
    }
  }

  // Limit sessions per category (adapted from OMEGA's _CATEGORY_CONFIG):
  // Single-session/factual: 3-12 results (tight — less noise)
  // Multi-session/counting: 4-20 results (broad coverage)
  // Temporal: 5-20 results (need date range coverage)
  const sessionLimits: Record<string, number> = {
    factual: 12,
    counting: 20,
    duration: 20,
    comparison: 15,
    temporal: 20,
  };
  const sessionLimit = sessionLimits[plan.questionType] || 12;
  return { sessions: sessions.slice(0, sessionLimit), events, svoEvents };
}

// ---------------------------------------------------------------------------
// Phase 3: Final Answer (GPT-4o with pre-populated context)
// ---------------------------------------------------------------------------

/**
 * Category-specific RAG prompts adapted from OMEGA's longmemeval_official.py.
 * OMEGA empirically determined the best prompt per category across 4 benchmark runs.
 * Key differences from a one-size-fits-all prompt:
 * - Factual: minimal instructions, let the model find the answer
 * - Multi-session: explicit dedup, enumerate with source citations, verify each item
 * - Temporal: convert relative dates to absolute, recollection ≠ action
 * - Comparison: find BOTH values, compute difference explicitly
 */
function buildAnswerPrompt(
  question: LongMemQuestion,
  plan: SearchPlan,
  context: CompiledContext
): { system: string; user: string } {
  const system = "You are a memory assistant that answers questions from retrieved conversation history.";

  // Format sessions as numbered notes (OMEGA format: chronological, numbered)
  const sessions = [...context.sessions].sort((a, b) => {
    const da = new Date(a.date).getTime();
    const db = new Date(b.date).getTime();
    return (isNaN(da) ? 0 : da) - (isNaN(db) ? 0 : db);
  });

  let notesBlock = "";
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    notesBlock += `Note ${i + 1} (${s.date}):\n${s.text}\n\n`;
  }

  // Add events as additional structured notes if available
  if (context.svoEvents.length > 0) {
    notesBlock += `Structured Events (each is one distinct event):\n`;
    for (const e of context.svoEvents) {
      const dateTag = e.startDate ? ` [${e.startDate}]` : "";
      notesBlock += `- ${e.subject} ${e.verb} ${e.object}${dateTag}\n`;
    }
    notesBlock += "\n";
  } else if (context.events.length > 0) {
    notesBlock += `Extracted Events:\n`;
    for (const e of context.events) {
      const dateTag = e.date ? ` (${e.date})` : "";
      notesBlock += `- ${e.summary}${dateTag}\n`;
    }
    notesBlock += "\n";
  }

  let user: string;

  switch (plan.questionType) {
    case "counting":
    case "duration":
    case "comparison":
      // OMEGA's multi-session prompt — best for counting (69.9%)
      user = `I will give you several notes from past conversations between you and a user, ordered from oldest to newest. Please answer the question based on the relevant notes. If the question cannot be answered based on the provided notes, say so.

Important:
- Notes are in chronological order. When the same fact appears in multiple notes with different values, always use the value from the MOST RECENT note.
- If the question asks "how many", for a count, or for a total:
  1. You MUST list EVERY matching item individually, citing its source as [Note #].
  2. VERIFY each item: re-read the question and confirm each item EXACTLY matches what was asked. If the question asks about "types of citrus fruits", only count distinct fruit types the user actually used, not every mention of citrus.
  3. REMOVE items that don't strictly match the question's criteria. But NEVER dismiss something the USER claims they did (bought, attended, downloaded, etc.) just because the assistant questioned whether it's real. The user's statement is ground truth.
  4. After filtering, count the remaining items and state the total clearly.
  5. For "how much total" questions: list each amount with its source [Note #], then sum them and state the total.
- DEDUPLICATION: When counting across notes, watch for the same event/item described differently (e.g., "cousin's wedding" and "Rachel's wedding at a vineyard" may be the same event). If two items could be the same, count them as ONE.
- For questions about an "increase", "decrease", or "change" in a quantity: you MUST find BOTH the starting value AND the ending value, then compute the DIFFERENCE. Do NOT report the final total as the increase.
- Do NOT skip notes. Scan every note for potential matches before answering.
- Give a direct, concise answer. Do not hedge if the evidence is clear.

Notes from past conversations:

${notesBlock}

Current Date: ${question.question_date}
Question: ${question.question}
Answer:`;
      break;

    case "temporal":
      // OMEGA's temporal prompt — date conversion and ordering
      user = `I will give you several notes from past conversations between you and a user, ordered from oldest to newest. Each note has a date stamp. Please answer the question based on the relevant notes. If the question cannot be answered based on the provided notes, say so.

You MUST follow these steps:

STEP 1 — Convert every relative date to an ABSOLUTE date using the note's own date stamp:
  - "last Saturday" = the most recent Saturday BEFORE the note's date
  - "yesterday" = the day before the note's date
  - "two weeks ago" = 14 days before the note's date

STEP 2 — Find ALL candidate events, not just the first match.

STEP 3 — Select the best match by verifying BOTH date AND description.

STEP 4 — Compute the answer using ONLY the absolute dates.

CRITICAL: RECOLLECTION ≠ ACTION. When a note says "I was thinking about X" or "I remembered X", the event X did NOT happen on that note's date.
- Notes are in chronological order. When the same fact appears in multiple notes with different values, use the MOST RECENT note.
- Show your date arithmetic briefly before giving the final answer.

Notes from past conversations:

${notesBlock}

Current Date: ${question.question_date}
Question: ${question.question}
Answer:`;
      break;

    case "factual":
    default:
      // OMEGA's vanilla prompt — minimal, best for single-session (97-100%)
      user = `I will give you several notes from past conversations between you and a user. Please answer the question based on the relevant notes. If the question cannot be answered based on the provided notes, say so.

Notes from past conversations:

${notesBlock}

Current Date: ${question.question_date}
Question: ${question.question}
Answer:`;
      break;
  }

  return { system, user };
}

// ---------------------------------------------------------------------------
// OpenAI API helper
// ---------------------------------------------------------------------------

async function callOpenAI(
  apiKey: string,
  model: string,
  system: string,
  user: string,
  maxTokens: number = 2048
): Promise<{ content: string; usage?: { promptTokens: number; completionTokens: number } }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0,
        max_tokens: maxTokens,
      }),
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
      content: choice?.message?.content?.trim() || "",
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
// Main: Planned Search
// ---------------------------------------------------------------------------

export async function runPlannedSearch(
  apiKey: string,
  answerModel: string,
  question: LongMemQuestion,
  ingested: IngestedQuestion,
  options: PlannedSearchOptions = {}
): Promise<PlannedSearchResult> {
  const plannerModel = options.plannerModel || "gpt-4o-mini";
  const start = performance.now();
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  // --- Phase 1: Query Planning ---
  const plannerResult = await callOpenAI(
    apiKey,
    plannerModel,
    PLANNER_PROMPT,
    `Question: ${question.question}\nQuestion date: ${question.question_date}`,
    512
  );
  totalPromptTokens += plannerResult.usage?.promptTokens ?? 0;
  totalCompletionTokens += plannerResult.usage?.completionTokens ?? 0;

  let plan = parsePlan(plannerResult.content);
  if (!plan) {
    // Fallback: use the question itself as the only search query
    plan = {
      questionType: isCountingQuestion(question.question) ? "counting"
        : isDurationQuestion(question.question) ? "duration" : "factual",
      searchQueries: [question.question],
      eventQuery: question.question.replace(/how many|what|where|when|which|who|did i|have i|do i/gi, "").trim(),
      guidance: "",
    };
  }

  // --- Phase 2: Deterministic Multi-Search ---
  const context = await executeSearchPlan(plan, question, ingested);

  // --- Phase 3: Final Answer ---
  const { system, user } = buildAnswerPrompt(question, plan, context);

  const answerResult = await callOpenAI(apiKey, answerModel, system, user, 2048);
  totalPromptTokens += answerResult.usage?.promptTokens ?? 0;
  totalCompletionTokens += answerResult.usage?.completionTokens ?? 0;

  return {
    answer: answerResult.content,
    latencyMs: performance.now() - start,
    plan,
    sessionsUsed: context.sessions.length,
    eventsUsed: context.svoEvents.length || context.events.length,
    tokenUsage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens },
  };
}
