/**
 * LongMemEval Answer Generation
 *
 * Given a question and retrieved context from Strata, generates an answer
 * using an LLM. Supports multiple prompt variants:
 *
 * - "original" -- Verbatim LongMemEval prompt from xiaowu0162/LongMemEval
 *   src/generation/run_generation.py. Methodologically identical to the
 *   benchmark's reference implementation.
 *
 * - "enhanced" -- Optimized using official provider guidance from Anthropic,
 *   OpenAI, and Google. Adds grounding constraints, abstention instructions,
 *   knowledge-update handling, temporal reasoning, and XML session structure.
 *   See ENHANCED_PROMPT_TEMPLATE JSDoc for sourced rationale per change.
 *
 * - "chain-of-note" -- Auto-selects the best provider-specific CoN variant
 *   based on the active LLM provider. Falls back to generic JSON format.
 *
 * - "chain-of-note-anthropic" -- XML documents, system/user split, quote-first extraction.
 * - "chain-of-note-openai" -- Triple-quote delimiters, bookend ordering, system/user split.
 * - "chain-of-note-gemini" -- Markdown headers, single message, few-shot example.
 */

import type { LlmProvider } from "../../src/extensions/llm-extraction/llm-provider.js";
import { LlmError } from "../../src/extensions/llm-extraction/llm-provider.js";
import type { SearchResult } from "../../src/search/sqlite-search-engine.js";

/**
 * Official LongMemEval answer prompt template (non-CoT variant).
 * Source: xiaowu0162/LongMemEval/src/generation/run_generation.py
 *
 * Placeholders:
 *   {history} -- formatted session blocks
 *   {date}    -- current question date
 *   {question} -- the question text
 */
const ORIGINAL_PROMPT_TEMPLATE =
  "I will give you several history chats between you and a user. Please answer the question based on the relevant chat history.\n\n\nHistory Chats:\n\n{history}\n\nCurrent Date: {date}\nQuestion: {question}\nAnswer:";

/**
 * Enhanced answer prompt template -- optimized using official provider guidance.
 *
 * Improvements over the original LongMemEval template:
 *
 * 1. GROUNDING CONSTRAINT -- "only use information from the provided sessions"
 *    Source: All three providers recommend explicit grounding for RAG tasks.
 *    - Anthropic: quote-first grounding pattern (docs/prompt-engineering)
 *    - OpenAI: "Use the below articles to answer" (embeddings cookbook)
 *    - Gemini: "strictly grounded assistant" pattern (prompting-strategies)
 *
 * 2. ABSTENTION INSTRUCTION -- tells the model what to do when info is missing
 *    Source: All three providers recommend explicit abstention phrasing.
 *    - OpenAI: "If the answer cannot be found, write 'I could not find an answer'"
 *    - Gemini: "If insufficient information exists, write: 'Insufficient information'"
 *    - LongMemEval judge accepts: "information is incomplete" or equivalent
 *
 * 3. KNOWLEDGE UPDATE -- prefer the most recent session when facts conflict
 *    Source: LongMemEval judge criteria for knowledge-update questions accepts
 *    "previous information along with an updated answer" as correct. Instructing
 *    recency preference aligns the answer model with the judge's expectations.
 *
 * 4. TEMPORAL REASONING -- explicit instruction to use session dates
 *    Source: Gemini docs specifically recommend injecting current date and
 *    instructing models to use provided dates for time-based reasoning.
 *
 * 5. XML SESSION STRUCTURE -- structured document tags per Anthropic guidance
 *    Source: Anthropic recommends <document index="N"> with <source> and
 *    <document_content> subtags. Adapted to <session> with date attribute.
 *    "Queries at the end can improve response quality by up to 30%."
 *
 * 6. CONCISENESS -- "Answer directly without preamble"
 *    Source: Anthropic docs recommend suppressing "Here is..." / "Based on..."
 *    prefixes. Critical for judge accuracy -- the judge checks if the response
 *    "contains the correct answer", so concise answers reduce noise.
 */
const ENHANCED_PROMPT_TEMPLATE = `You are a memory assistant. You have access to retrieved conversation sessions between a user and an AI assistant. Answer questions accurately based only on these sessions.

Rules:
- Use ONLY information explicitly stated in the provided sessions. Do not use outside knowledge.
- If the answer cannot be determined from the sessions, say "The provided conversations do not contain this information."
- When sessions contain conflicting information about the same topic, prefer the most recent session by date.
- Use session dates for time-based reasoning. The current date is provided below.
- Answer concisely and directly without preamble.

<sessions>
{history}
</sessions>

Current date: {date}

Question: {question}`;

/**
 * Chain-of-Note prompt template (generic JSON format -- fallback).
 *
 * Research basis:
 * - LongMemEval paper Section 5.3: CoN + JSON = +10 absolute points
 * - OMEGA (83.5% multi-session): list-then-count for counting questions
 * - Emergence AI (82.4%): two-stage extract-then-answer identical to CoN
 *
 * Two-step reading:
 *   Step 1: Extract relevant notes from each session (structured extraction)
 *   Step 2: Synthesize answer from notes (with list-then-count for counting Qs)
 */
const CHAIN_OF_NOTE_TEMPLATE = `You are answering a question based on the user's conversation history.

Retrieved conversation sessions (JSON format):
{history}

Current date: {date}

Step 1: For each session above, extract any information relevant to the question below.
Write a brief note for each session. Include:
- Specific names, places, items mentioned
- Exact quantities and numbers
- Dates and time references
- Preferences or opinions expressed
If a session contains no relevant information, write "No relevant info."

Step 2: Based ONLY on your notes above, answer the question.
Answer concisely and directly.

{counting_instruction}
Question: {question}`;

// ---------------------------------------------------------------------------
// Provider-specific Chain-of-Note templates
// ---------------------------------------------------------------------------

/**
 * Anthropic CoN system prompt.
 * Uses system/user split per Anthropic best practices.
 * Claude handles long context uniformly -- no need for bookend ordering.
 */
const CHAIN_OF_NOTE_ANTHROPIC_SYSTEM = `You are a memory assistant. You have access to retrieved conversation sessions from a user's history with an AI assistant. Your task is to answer questions accurately based only on the provided sessions.

Rules:
- Use ONLY information explicitly stated in the provided sessions. Do not use outside knowledge.
- If the answer cannot be determined from the sessions, say exactly: "The provided conversations do not contain this information."
- When sessions contain conflicting information, prefer the most recent session by date.
- Answer concisely and directly without preamble.`;

/** Anthropic CoN user prompt template. XML documents, quote-first extraction. */
const CHAIN_OF_NOTE_ANTHROPIC_USER = `{history}

Current date: {date}

Step 1: For each document above, extract direct quotes relevant to the question below. Group by document index.

Step 2: Based only on the quotes, write a brief note summarizing what each document contributes. If a document has no relevant quotes, write "No relevant info."

Step 3: Based only on your notes, answer the question.
{counting_instruction}

Question: {question}`;

/**
 * OpenAI CoN system prompt.
 * Short system message -- OpenAI performs best with concise system instructions.
 */
const CHAIN_OF_NOTE_OPENAI_SYSTEM = `You are a memory assistant that answers questions from retrieved conversation history.`;

/**
 * OpenAI CoN user prompt template.
 * Triple-quote delimiters with bookend ordering (most relevant at start and end).
 * OpenAI's own guide: JSON "performed particularly poorly in long context testing".
 */
const CHAIN_OF_NOTE_OPENAI_USER = `Answer the question at the bottom using ONLY the conversation sessions below. If the answer is not in the sessions, write: "I could not find an answer."

{history}

Instructions:
- Extract relevant notes from each session above.
- Base your answer ONLY on those notes.
- When sessions conflict, prefer the most recent date.
- Current date: {date}
{counting_instruction}

Question: {question}
Answer:`;

/**
 * Gemini CoN template (single message, no system/user split).
 * Gemini performs best with a single message containing a few-shot example.
 * Markdown format per Google prompting guidance.
 */
const CHAIN_OF_NOTE_GEMINI = `You are a strictly grounded assistant. Answer questions using ONLY the conversation sessions provided below. Do not use any outside knowledge.

---

## Conversation Sessions

{history}

---

## How to respond

Here is an example of the correct approach:

Example question: "What programming language did the user say they prefer?"
Example notes:
- Session 1 (2023-01-10): User stated preference for Python.
Other sessions: No relevant info.
Example answer: Python

---

Based on the information above, follow these steps:

Step 1: For each session, write one note about any information relevant to the question. If a session has no relevant information, write "No relevant info."

Step 2: Synthesize your notes to answer the question.

If the information needed is not present in any session, write exactly: "Insufficient information in the provided sessions."

Current date: {date}

{counting_instruction}
Question: {question}`;

// ---------------------------------------------------------------------------
// Counting/duration instructions (generic + provider-specific)
// ---------------------------------------------------------------------------

/** Instruction appended for discrete counting questions (enumerate then count) */
const COUNTING_INSTRUCTION = `IMPORTANT: This question asks you to count discrete items.
1. First, list EVERY unique matching instance found in your notes (numbered list)
2. Count the unique items in your list
3. State the count as your final answer
Do NOT skip the enumeration step.
Remember: your final answer MUST be a specific number.`;

/** Instruction appended for duration/sum questions (add up values) */
const DURATION_INSTRUCTION = `IMPORTANT: This question asks about a duration or total amount.
1. First, list each relevant time period or amount found in your notes
2. Add them together
3. State the total as your final answer`;

/** Anthropic-specific counting instruction -- quote-first pattern */
const COUNTING_INSTRUCTION_ANTHROPIC = `IMPORTANT: This question asks you to count discrete items.
In your notes: list EVERY unique matching instance found (numbered list), then count them.
Your final answer MUST be a specific number.
Do NOT skip the enumeration step.`;

/** OpenAI-specific counting instruction -- explicit anti-skip instruction + CoVe qualifying check */
const COUNTING_INSTRUCTION_OPENAI = `IMPORTANT: This question asks you to count discrete items.
First, create a COMPLETE numbered list of every unique matching item found across all sessions.
Do NOT state a count until your numbered list is complete.
Before stating your count, re-read each item in your list and verify it satisfies the EXACT condition in the question. Remove any that don't qualify.
Your final answer MUST be a specific number.`;

/** Gemini-specific counting instruction -- concise, directive */
const COUNTING_INSTRUCTION_GEMINI = `IMPORTANT: List every unique matching item found across your notes, numbered. Count the list. State the count as your answer.`;

// ---------------------------------------------------------------------------
// Question type detection
// ---------------------------------------------------------------------------

/** Detect discrete counting intent (excludes duration/sum questions) */
export function isCountingQuestion(question: string): boolean {
  // Duration/sum questions: "how many days/weeks/hours/months/years" -> use DURATION
  if (/how (?:many|long|much)\s+(?:days?|weeks?|hours?|months?|years?|time|minutes?)/i.test(question)) {
    return false;
  }
  return /how many|how often|list all|total/i.test(question);
}

/** Detect duration/sum intent */
export function isDurationQuestion(question: string): boolean {
  return /how (?:many|long|much)\s+(?:days?|weeks?|hours?|months?|years?|time|minutes?)/i.test(question);
}

// ---------------------------------------------------------------------------
// Prompt variant type
// ---------------------------------------------------------------------------

/** Prompt variant selector */
export type PromptVariant =
  | "original"
  | "enhanced"
  | "chain-of-note"
  | "chain-of-note-anthropic"
  | "chain-of-note-openai"
  | "chain-of-note-gemini"
  | "category";

// ---------------------------------------------------------------------------
// History formatting functions
// ---------------------------------------------------------------------------

/**
 * Format retrieved search results into the official LongMemEval session format.
 *
 * Official format (from run_generation.py, retriever_type="flat-session", history_format="nl"):
 *   ### Session 1:
 *   Session Date: 2023/05/20 (Sat) 02:21
 *   Session Content:
 *
 *   user: ...
 *
 *   assistant: ...
 */
function formatHistoryOriginal(context: SearchResult[]): string {
  // Sort chronologically so the model sees temporal ordering (TEMPORAL REASONER fix)
  const sorted = [...context].sort((a, b) => a.timestamp - b.timestamp);
  let history = "";

  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    const date = new Date(r.timestamp);
    const dateStr = isNaN(date.getTime())
      ? "Unknown date"
      : date.toISOString().split("T")[0];

    history += `\n### Session ${i + 1}:\nSession Date: ${dateStr}\nSession Content:\n${r.text}\n`;
  }

  return history;
}

/**
 * Format retrieved search results as XML-structured sessions.
 *
 * Follows Anthropic's multi-document pattern:
 *   <session index="N" date="YYYY-MM-DD">
 *     {session content}
 *   </session>
 *
 * Source: Anthropic prompt engineering docs recommend <document index="N">
 * with structured subtags. Adapted for conversation sessions.
 */
function formatHistoryXml(context: SearchResult[]): string {
  // Sort chronologically so the model sees temporal ordering (TEMPORAL REASONER fix)
  const sorted = [...context].sort((a, b) => a.timestamp - b.timestamp);
  const sessions: string[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    const date = new Date(r.timestamp);
    const dateStr = isNaN(date.getTime())
      ? "Unknown date"
      : date.toISOString().split("T")[0];

    sessions.push(`<session index="${i + 1}" date="${dateStr}">\n${r.text}\n</session>`);
  }

  return sessions.join("\n");
}

/**
 * Format retrieved search results as JSON array (for Chain-of-Note generic fallback).
 * Sessions sorted chronologically so the model sees temporal ordering.
 */
function formatHistoryJson(context: SearchResult[]): string {
  const sorted = [...context].sort((a, b) => a.timestamp - b.timestamp);
  const sessions = sorted.map((r, i) => {
    const date = new Date(r.timestamp);
    const dateStr = isNaN(date.getTime())
      ? "Unknown date"
      : date.toISOString().split("T")[0];
    return {
      session: i + 1,
      date: dateStr,
      session_id: r.sessionId,
      content: r.text,
    };
  });
  return JSON.stringify(sessions, null, 2);
}

/**
 * Format retrieved search results as XML documents for Anthropic CoN.
 * Sorted chronologically -- Claude handles long context uniformly.
 * Uses <document> tags per Anthropic's multi-document prompt pattern.
 */
export function formatHistoryXmlAnthropic(context: SearchResult[]): string {
  const sorted = [...context].sort((a, b) => a.timestamp - b.timestamp);
  const docs: string[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    const date = new Date(r.timestamp);
    const dateStr = isNaN(date.getTime())
      ? "Unknown date"
      : date.toISOString().split("T")[0];

    docs.push(`<document index="${i + 1}" date="${dateStr}">\n${r.text}\n</document>`);
  }

  return `<documents>\n${docs.join("\n")}\n</documents>`;
}

/**
 * Format retrieved search results with triple-quote delimiters for OpenAI CoN.
 * Uses bookend ordering: sort by score descending, then interleave so the
 * highest-relevance sessions appear at the start and end of the context window,
 * where GPT-4o attends most strongly ("lost in the middle" mitigation).
 *
 * Interleave pattern (by score rank):
 *   Position: 0(first) 1(last) 2(second) 3(second-to-last) ...
 */
export function formatHistoryTripleQuoteOpenAI(context: SearchResult[]): string {
  // Sort by score descending (highest relevance first)
  const byScore = [...context].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  // Bookend interleave: even indices go to front, odd indices go to back
  const ordered: SearchResult[] = new Array(byScore.length);
  let front = 0;
  let back = byScore.length - 1;

  for (let i = 0; i < byScore.length; i++) {
    if (i % 2 === 0) {
      ordered[front++] = byScore[i];
    } else {
      ordered[back--] = byScore[i];
    }
  }

  const blocks: string[] = [];

  for (let i = 0; i < ordered.length; i++) {
    const r = ordered[i];
    const date = new Date(r.timestamp);
    const dateStr = isNaN(date.getTime())
      ? "Unknown date"
      : date.toISOString().split("T")[0];

    blocks.push(`Session ${i + 1} | Date: ${dateStr}\n"""\n${r.text}\n"""`);
  }

  return blocks.join("\n\n");
}

/**
 * Format retrieved search results as Markdown headers for Gemini CoN.
 * Sorted chronologically. Uses ### headers per Google prompting guidance.
 */
export function formatHistoryMarkdownGemini(context: SearchResult[]): string {
  const sorted = [...context].sort((a, b) => a.timestamp - b.timestamp);
  const blocks: string[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    const date = new Date(r.timestamp);
    const dateStr = isNaN(date.getTime())
      ? "Unknown date"
      : date.toISOString().split("T")[0];

    blocks.push(`### Session ${i + 1} — ${dateStr}\n\n${r.text}`);
  }

  return blocks.join("\n\n");
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/** Structured prompt with optional system/user split */
export interface StructuredPrompt {
  /** System message (sent as separate system role when provider supports it) */
  system?: string;
  /** User message (always present) */
  user: string;
}

/**
 * Build the answer prompt. Supports original, enhanced, and chain-of-note variants.
 *
 * Returns a StructuredPrompt with optional system/user split for providers
 * that benefit from it (Anthropic, OpenAI). Gemini and generic variants
 * return only the `user` field.
 *
 * When knowledgeContext is provided (Pro pipeline), it's inserted between
 * the instructions and the session history so the model sees extracted
 * knowledge first, then raw sessions for grounding.
 */
export function buildAnswerPrompt(
  question: string,
  questionDate: string,
  context: SearchResult[],
  variant: PromptVariant = "original",
  knowledgeContext?: string,
  questionType?: string
): StructuredPrompt {

  // -- Category-specific prompts (adapted from OMEGA's longmemeval_official.py) --
  // Route by LongMemEval question_type. Each prompt is empirically optimized for its category.

  if (variant === "category" && questionType) {
    // Sort chronologically and format as numbered notes (OMEGA format)
    const sorted = [...deduplicateToSessions(context)].sort((a, b) => a.timestamp - b.timestamp);
    let notes = "";
    for (let i = 0; i < sorted.length; i++) {
      const r = sorted[i];
      const date = new Date(r.timestamp);
      const dateStr = isNaN(date.getTime()) ? "Unknown date" : date.toISOString().split("T")[0];
      notes += `Note ${i + 1} (${dateStr}):\n${r.text}\n\n`;
    }

    // Prepend events if available
    if (knowledgeContext) {
      notes = knowledgeContext + "\n\n" + notes;
    }

    const system = "You are a memory assistant that answers questions from retrieved conversation history.";

    if (questionType === "multi-session") {
      return { system, user: `I will give you several notes from past conversations between you and a user, ordered from oldest to newest. Please answer the question based on the relevant notes. If the question cannot be answered based on the provided notes, say so.

Important:
- Notes are in chronological order. When the same fact appears in multiple notes with different values, always use the value from the MOST RECENT note.
- If the question asks "how many", for a count, or for a total:
  1. You MUST list EVERY matching item individually, citing its source as [Note #].
  2. VERIFY each item: re-read the question and confirm each item EXACTLY matches what was asked.
  3. REMOVE items that don't strictly match the question's criteria. But NEVER dismiss something the USER claims they did just because the assistant questioned whether it's real. The user's statement is ground truth.
  4. After filtering, count the remaining items and state the total clearly.
  5. For "how much total" questions: list each amount with its source [Note #], then sum them.
- DEDUPLICATION: Watch for the same event/item described differently. If two items could be the same, count them as ONE.
- For questions about an "increase" or "change": find BOTH the starting AND ending value, then compute the DIFFERENCE.
- Do NOT skip notes. Scan every note for potential matches before answering.
- Give a direct, concise answer.

Notes from past conversations:

${notes}

Current Date: ${questionDate}
Question: ${question}
Answer:` };
    }

    if (questionType === "temporal-reasoning") {
      // Simplified temporal prompt — no numbered STEPs (Gemini Flash echoes them).
      // Same content as OMEGA's temporal prompt but in flowing prose.
      return { system, user: `I will give you several notes from past conversations between you and a user, ordered from oldest to newest. Each note has a date stamp. Please answer the question based on the relevant notes. If the question cannot be answered based on the provided notes, say so.

For time-based questions, convert ALL relative dates ("last Saturday", "3 weeks ago", "yesterday") to absolute dates using the note's own date stamp. Find every event that could match both the time reference AND the description — do not stop at the first match. When a note says "I was thinking about X" or "I remembered X", the event X did NOT happen on that note's date — only use notes where the user describes actually performing an action.

For "how many days/weeks" questions, show the two absolute dates and the arithmetic briefly before your answer. For ordering questions, list each event with its absolute date, then sort by date. Notes are in chronological order — use the most recent note when values conflict.

Notes from past conversations:

${notes}

Current Date: ${questionDate}
Question: ${question}
Answer:` };
    }

    if (questionType === "knowledge-update") {
      // Use the vanilla prompt for KU — the step-by-step OMEGA prompt causes Gemini Flash
      // to echo the instructions. CoN scored 94.7% on KU vs 85% with OMEGA prompt.
      return { system, user: `I will give you several notes from past conversations between you and a user, ordered from oldest to newest. Please answer the question based on the relevant notes. If the question cannot be answered based on the provided notes, say so.

When the same topic appears in multiple notes with different values, always use the value from the MOST RECENT note (the highest note number). Earlier values are superseded.

Notes from past conversations:

${notes}

Current Date: ${questionDate}
Question: ${question}
Answer:` };
    }

    if (questionType === "single-session-preference") {
      return { system, user: `I will give you several notes from past conversations between you and a user. Please answer the question based on the user's stated preferences, habits, and personal information found in these notes. If the question cannot be answered based on the provided notes, say so.

- Focus on what the user explicitly said about their preferences, likes, dislikes, habits, and personal details.
- When the same preference appears in multiple notes, use the MOST RECENT note.
- If asked for a recommendation, USE the user's stated preferences. Do NOT say you lack information if the notes contain ANY relevant preferences.
- Look for RELATED preferences even if the notes don't mention the exact topic.
- Your answer MUST reference at least one specific detail from the notes. Generic advice is WRONG.

Notes from past conversations:

${notes}

Current Date: ${questionDate}
Question: ${question}
Answer:` };
    }

    // Default: vanilla (best for single-session-user, single-session-assistant, abstention)
    return { system, user: `I will give you several notes from past conversations between you and a user. Please answer the question based on the relevant notes. If the question cannot be answered based on the provided notes, say so.

Notes from past conversations:

${notes}

Current Date: ${questionDate}
Question: ${question}
Answer:` };
  }

  // -- Provider-specific Chain-of-Note variants --

  if (variant === "chain-of-note-anthropic") {
    const history = formatHistoryXmlAnthropic(context);
    const countingInstruction = isCountingQuestion(question)
      ? COUNTING_INSTRUCTION_ANTHROPIC
      : isDurationQuestion(question)
        ? DURATION_INSTRUCTION
        : "";

    let user = CHAIN_OF_NOTE_ANTHROPIC_USER
      .replace("{history}", history)
      .replace("{date}", questionDate)
      .replace("{counting_instruction}", countingInstruction)
      .replace("{question}", question);

    if (knowledgeContext) {
      user = `${knowledgeContext}\n\n${user}`;
    }

    return { system: CHAIN_OF_NOTE_ANTHROPIC_SYSTEM, user };
  }

  if (variant === "chain-of-note-openai") {
    const history = formatHistoryTripleQuoteOpenAI(context);
    const countingInstruction = isCountingQuestion(question)
      ? COUNTING_INSTRUCTION_OPENAI
      : isDurationQuestion(question)
        ? DURATION_INSTRUCTION
        : "";

    let user = CHAIN_OF_NOTE_OPENAI_USER
      .replace("{history}", history)
      .replace("{date}", questionDate)
      .replace("{counting_instruction}", countingInstruction)
      .replace("{question}", question);

    if (knowledgeContext) {
      user = `${knowledgeContext}\n\n${user}`;
    }

    return { system: CHAIN_OF_NOTE_OPENAI_SYSTEM, user };
  }

  if (variant === "chain-of-note-gemini") {
    const history = formatHistoryMarkdownGemini(context);
    const countingInstruction = isCountingQuestion(question)
      ? COUNTING_INSTRUCTION_GEMINI
      : isDurationQuestion(question)
        ? DURATION_INSTRUCTION
        : "";

    let user = CHAIN_OF_NOTE_GEMINI
      .replace("{history}", history)
      .replace("{date}", questionDate)
      .replace("{counting_instruction}", countingInstruction)
      .replace("{question}", question);

    if (knowledgeContext) {
      user = user.replace(
        "## Conversation Sessions",
        `${knowledgeContext}\n\n## Conversation Sessions`
      );
    }

    return { user };
  }

  // -- Generic Chain-of-Note (JSON format fallback) --

  if (variant === "chain-of-note") {
    const history = formatHistoryJson(context);
    const countingInstruction = isCountingQuestion(question)
      ? COUNTING_INSTRUCTION
      : isDurationQuestion(question)
        ? DURATION_INSTRUCTION
        : "If the answer cannot be determined from the sessions, say \"The provided conversations do not contain this information.\"";

    let prompt = CHAIN_OF_NOTE_TEMPLATE
      .replace("{history}", history)
      .replace("{date}", questionDate)
      .replace("{counting_instruction}", countingInstruction)
      .replace("{question}", question);

    if (knowledgeContext) {
      prompt = prompt.replace(
        "Retrieved conversation sessions (JSON format):",
        `${knowledgeContext}\n\nRetrieved conversation sessions (JSON format):`
      );
    }
    return { user: prompt };
  }

  // -- Enhanced variant --

  if (variant === "enhanced") {
    const history = formatHistoryXml(context);
    let prompt = ENHANCED_PROMPT_TEMPLATE
      .replace("{history}", history)
      .replace("{date}", questionDate)
      .replace("{question}", question);

    // Insert knowledge before <sessions> block
    if (knowledgeContext) {
      prompt = prompt.replace(
        "<sessions>",
        `${knowledgeContext}\n\n<sessions>`
      );
    }
    return { user: prompt };
  }

  // -- Original variant (default) --

  const history = formatHistoryOriginal(context);
  let prompt = ORIGINAL_PROMPT_TEMPLATE
    .replace("{history}", history)
    .replace("{date}", questionDate)
    .replace("{question}", question);

  // Insert knowledge before history
  if (knowledgeContext) {
    prompt = prompt.replace(
      "History Chats:",
      `${knowledgeContext}\n\nHistory Chats:`
    );
  }
  return { user: prompt };
}

/**
 * Resolve the effective prompt variant: when user passes "chain-of-note",
 * auto-select the provider-specific variant based on the active provider.
 *
 * Extended for spec 2026-05-27 multi-model-provider:
 *   - ollama          → chain-of-note-gemini (markdown headers + few-shot;
 *                       empirically works well with most instruct-tuned open models)
 *   - oai-compatible  → chain-of-note-openai (most platform-agnostic; triple-quote
 *                       blocks tolerated by every endpoint we ship support for)
 *
 * LONGMEMEVAL_COT_VARIANT env var overrides the default per-provider mapping.
 * Accepts: claude / openai / gemini / none.
 */
function resolveVariant(variant: PromptVariant, providerName: string): PromptVariant {
  if (variant !== "chain-of-note") return variant;

  const envOverride = process.env.LONGMEMEVAL_COT_VARIANT;
  if (envOverride) {
    switch (envOverride) {
      case "claude":  return "chain-of-note-anthropic";
      case "openai":  return "chain-of-note-openai";
      case "gemini":  return "chain-of-note-gemini";
      case "none":    return "chain-of-note";
    }
    // unknown override falls through to default mapping
  }

  switch (providerName) {
    case "anthropic":       return "chain-of-note-anthropic";
    case "openai":          return "chain-of-note-openai";
    case "gemini":          return "chain-of-note-gemini";
    case "ollama":          return "chain-of-note-gemini";
    case "oai-compatible":  return "chain-of-note-openai";
    default:                return "chain-of-note"; // generic fallback
  }
}

// Test-only export so tests can target the pure function without standing up
// a full provider. Underscore-prefix marks it as internal-but-exposed-for-tests.
export const _resolveVariantForTest = resolveVariant;

/** Options for answer generation */
export interface AnswerOptions {
  /** Number of search results to include as context (default: 10) */
  topK?: number;
  /** Prompt variant to use (default: "chain-of-note") */
  promptVariant?: PromptVariant;
  /** Optional extracted knowledge to prepend to context (Pro pipeline) */
  knowledgeContext?: string;
  /** LongMemEval question type — used for "category" prompt variant routing */
  questionType?: string;
}

/**
 * Deduplicate SearchResult[] by sessionId → one entry per session.
 *
 * When the search pipeline returns chunk-level results, the same session can
 * appear as multiple SearchResult entries (each a different chunk). This causes
 * the answer model to see "Session 3" and "Session 7" that are actually the same
 * conversation — leading to double-counting on aggregate questions.
 *
 * Groups by sessionId, concatenates texts with "\n\n" separator (preserving chunk
 * order by assuming the search pipeline returns chunks in score order — the first
 * chunk seen per session is the highest-scored), keeps the best score and earliest
 * timestamp. Returns results sorted by score descending.
 */
export function deduplicateToSessions(results: SearchResult[]): SearchResult[] {
  const sessions = new Map<string, SearchResult & { texts: string[] }>();

  for (const r of results) {
    const existing = sessions.get(r.sessionId);
    if (!existing) {
      sessions.set(r.sessionId, {
        ...r,
        texts: [r.text],
      });
    } else {
      existing.texts.push(r.text);
      // Keep the best score
      if (r.score > existing.score) {
        existing.score = r.score;
      }
      // Keep the earliest timestamp
      if (r.timestamp < existing.timestamp) {
        existing.timestamp = r.timestamp;
      }
      // Merge tool names
      for (const t of r.toolNames) {
        if (!existing.toolNames.includes(t)) {
          existing.toolNames.push(t);
        }
      }
    }
  }

  // Concatenate texts and strip the temporary field
  const deduped: SearchResult[] = [];
  for (const entry of sessions.values()) {
    const { texts, ...rest } = entry;
    deduped.push({
      ...rest,
      text: texts.join("\n\n"),
    });
  }

  // Sort by score descending (preserve ranking)
  deduped.sort((a, b) => b.score - a.score);
  return deduped;
}

/**
 * Generate an answer for a single question using retrieved context.
 *
 * Temperature is provider-aware:
 * - Anthropic/OpenAI: 0 (standard for factual QA)
 * - Gemini: 1.0 (Gemini docs explicitly warn against <1.0:
 *   "Reducing temperature below 1.0 may lead to unexpected behavior,
 *    such as looping or degraded performance in complex reasoning tasks.")
 *   Source: https://ai.google.dev/gemini-api/docs/prompting-strategies
 *
 * For provider-specific CoN variants (anthropic, openai), the system prompt
 * is passed via the `systemPrompt` option to the benchmark providers.
 * The production LlmProvider interface is not modified -- system prompt
 * support is additive on the benchmark provider implementations only.
 */
export async function generateAnswer(
  provider: LlmProvider,
  question: string,
  questionDate: string,
  context: SearchResult[],
  options?: AnswerOptions
): Promise<{ answer: string; latencyMs: number }> {
  const topK = options?.topK ?? 20;
  const rawVariant = options?.promptVariant ?? "chain-of-note";
  const knowledgeContext = options?.knowledgeContext;

  // Deduplicate chunks → full sessions before formatting.
  // Multiple chunks from the same session appear as separate SearchResult entries.
  // Without dedup, the answer model sees "Session 3" and "Session 7" that are actually
  // the same conversation, causing double-counting on aggregate questions.
  // Group by sessionId, concatenate texts in order, keep best score/timestamp.
  const deduped = deduplicateToSessions(context);
  const trimmedContext = deduped.slice(0, topK);

  // Auto-select provider-specific variant from generic "chain-of-note"
  const effectiveVariant = resolveVariant(rawVariant, provider.name);

  const structured = buildAnswerPrompt(question, questionDate, trimmedContext, effectiveVariant, knowledgeContext, options?.questionType);

  // Temperature: Gemini always gets 1.0 per their docs ("Reducing temperature
  // below 1.0 may lead to unexpected behavior"). All others get 0 for factual QA.
  const temperature = provider.name === "gemini" ? 1.0 : 0;

  // Token budget: CoN two-step extraction needs more than 500 tokens.
  // 2048 is sufficient for notes + answer on most questions.
  // Gemini reasoning models need 8192 for internal thinking + visible output.
  const maxTokens = provider.name === "gemini" ? 8192 : 2048;

  // Build completion options. For providers that support system/user split
  // (benchmark OpenAI/Anthropic providers), pass the system prompt via options.
  // The production LlmProvider.complete() ignores unknown options gracefully.
  //
  // Timeout is provider-aware: local Ollama models (and some OAI-compat
  // endpoints like vLLM/LMStudio) need significantly more time than
  // frontier APIs. A 14B model cold-start + 20-40k input tokens + 500
  // output tokens can run 2-5 minutes on Q1. Frontier providers respond
  // in <30s even on long contexts.
  const isLocalOrCompat = provider.name === "ollama" || provider.name === "oai-compatible";
  const completionOptions: Record<string, unknown> = {
    maxTokens,
    temperature,
    timeoutMs: isLocalOrCompat ? 600000 : 60000,
  };

  if (structured.system) {
    completionOptions.systemPrompt = structured.system;
  }

  const start = performance.now();
  const answer = await provider.complete(structured.user, completionOptions as any);
  const latencyMs = performance.now() - start;

  return { answer: answer.trim(), latencyMs };
}

// ---------------------------------------------------------------------------
// Two-pass structured extraction (Lever F)
// ---------------------------------------------------------------------------

/**
 * Two-Pass Structured Extraction for counting/duration questions.
 *
 * Single-pass CoN asks GPT-4o to extract, qualify, deduplicate, AND count
 * simultaneously — and it fails at the qualifying step 50% of the time.
 * Two-pass separates the cognitive load:
 *
 *   Pass 1: Extract structured JSON items with per-item qualifying decisions.
 *           Forces explicit scope checking via `qualifies` and cross-session
 *           deduplication via `duplicate_of`. GPT-4o is much better at
 *           per-item binary classification than holistic qualify-during-extraction.
 *
 *   Pass 2: Count from the structured list. Trivially correct — just counting
 *           records where qualifies=true and duplicate_of=null.
 */

/** Pass 1 system prompt — extraction-focused */
const TWO_PASS_EXTRACT_SYSTEM = `You are an extraction assistant. Your job is to find all items in conversation sessions that could be relevant to a question. Output ONLY valid JSON — no markdown, no explanation.`;

/**
 * Pass 1 user prompt — produces JSON array with qualifying decisions.
 *
 * The schema forces GPT-4o to:
 * 1. `qualifies: true/false` — explicit scope check per item
 *    ("acquired" vs "already owned", "last month" vs "3 months ago")
 * 2. `duplicate_of: null | "item_N"` — cross-session entity identity
 *    (F-15 Eagle in Session 3 = F-15 Eagle in Session 5)
 * 3. `session_index: N` — traceability for debugging
 */
const TWO_PASS_EXTRACT_USER = `Below are conversation sessions from a user's history. The question asks:

"{question}"

Current date: {date}

For each item in the sessions that is even REMOTELY related to the question's topic, extract it into the JSON array below. Include borderline items — we will filter later.

For each item, decide:
- "qualifies": Does this item satisfy the EXACT condition in the question? Apply verb scope strictly (e.g., "acquired/bought" excludes items merely owned or mentioned; "attended" excludes events only discussed). Apply time scope strictly if the question specifies a time window.
- "duplicate_of": If this is the SAME real-world item/event as an earlier entry (same book, same kit, same person, same trip — just mentioned in a different session), set this to that entry's id (e.g., "item_1"). Otherwise null.

Output format — ONLY valid JSON array, no other text:
[
  {"id": "item_1", "description": "brief description", "session_index": 3, "qualifies": true, "duplicate_of": null, "reason": "why it qualifies or not"},
  {"id": "item_2", "description": "brief description", "session_index": 5, "qualifies": false, "duplicate_of": null, "reason": "mentioned but not acquired"},
  {"id": "item_3", "description": "brief description", "session_index": 7, "qualifies": true, "duplicate_of": "item_1", "reason": "same item as item_1, mentioned again"}
]

If no relevant items found, output: []

Sessions:

{history}`;

/** Pass 1 user prompt for duration/sum questions */
const TWO_PASS_EXTRACT_DURATION_USER = `Below are conversation sessions from a user's history. The question asks:

"{question}"

Current date: {date}

Extract every time period, amount, or quantity mentioned in the sessions that could be relevant to the question. Include the specific numeric value.

For each item, decide:
- "qualifies": Does this time period / amount satisfy the EXACT condition in the question? Apply any time scope or activity scope strictly.
- "duplicate_of": If this is the same period as an earlier entry (just mentioned in a different session), set to that entry's id. Otherwise null.
- "value": The numeric value (hours, days, dollars, etc.)

Output format — ONLY valid JSON array, no other text:
[
  {"id": "item_1", "description": "brief description", "session_index": 3, "qualifies": true, "duplicate_of": null, "value": 25, "unit": "hours", "reason": "played TLOU II for 25 hours"},
  {"id": "item_2", "description": "brief description", "session_index": 5, "qualifies": true, "duplicate_of": null, "value": 10, "unit": "hours", "reason": "played Celeste for 10 hours"}
]

If no relevant items found, output: []

Sessions:

{history}`;

/** Pass 2 prompt — count from structured extraction */
const TWO_PASS_COUNT_USER = `You extracted these items from conversation sessions in response to the question:

"{question}"

Extracted items:
{items_json}

Now answer the question. Count ONLY items where:
- "qualifies" is true
- "duplicate_of" is null (skip duplicates)

List the qualifying, non-duplicate items, then state the count.
Your final answer MUST be a specific number.`;

/** Pass 2 prompt for duration questions — sum values */
const TWO_PASS_SUM_USER = `You extracted these amounts from conversation sessions in response to the question:

"{question}"

Extracted items:
{items_json}

Now answer the question. Sum ONLY items where:
- "qualifies" is true
- "duplicate_of" is null (skip duplicates)

List the qualifying, non-duplicate items with their values, then sum them.
Your final answer MUST be a specific number with units.`;

/** Pass 2 prompt for comparison/superlative questions */
const TWO_PASS_COMPARE_USER = `You extracted these items from conversation sessions in response to the question:

"{question}"

Extracted items:
{items_json}

Now answer the question. Consider ONLY items where:
- "qualifies" is true
- "duplicate_of" is null (skip duplicates)

Compare the qualifying items and select the one that best answers the question.
Answer concisely and directly.`;

/**
 * Parse the JSON array from Pass 1 output.
 * Handles markdown code fences and common LLM formatting issues.
 */
function parseExtractionJson(raw: string): Array<{
  id: string;
  description: string;
  session_index: number;
  qualifies: boolean;
  duplicate_of: string | null;
  reason?: string;
  value?: number;
  unit?: string;
}> {
  let cleaned = raw.trim();
  // Strip markdown code fences
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }
  // Find the JSON array in case there's extra text
  const arrayStart = cleaned.indexOf("[");
  const arrayEnd = cleaned.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    cleaned = cleaned.slice(arrayStart, arrayEnd + 1);
  }
  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    console.error("  [WARN] Failed to parse extraction JSON, falling back to single-pass");
    return [];
  }
}

/**
 * Generate an answer using two-pass structured extraction.
 *
 * Only used for counting and duration questions where single-pass CoN
 * produces noise-level results on 31Q GPT-4o.
 *
 * Pass 1: Extract structured JSON items with qualifies/duplicate_of decisions
 * Pass 2: Count/sum from the structured list
 *
 * Falls back to single-pass generateAnswer() if Pass 1 extraction fails.
 */
export async function generateAnswerTwoPass(
  provider: LlmProvider,
  question: string,
  questionDate: string,
  context: SearchResult[],
  options?: AnswerOptions
): Promise<{ answer: string; latencyMs: number; twoPassUsed: boolean; extractedItems?: unknown[] }> {
  const topK = options?.topK ?? 20;
  const knowledgeContext = options?.knowledgeContext;

  // Deduplicate chunks → full sessions
  const deduped = deduplicateToSessions(context);
  const trimmedContext = deduped.slice(0, topK);

  // Format history for extraction (use OpenAI triple-quote format)
  const history = formatHistoryTripleQuoteOpenAI(trimmedContext);

  // Prepend events context if available
  const fullHistory = knowledgeContext
    ? `${knowledgeContext}\n\n${history}`
    : history;

  const temperature = provider.name === "gemini" ? 1.0 : 0;

  const start = performance.now();

  // --- Pass 1: Structured Extraction ---
  const isDuration = isDurationQuestion(question);
  const extractTemplate = isDuration
    ? TWO_PASS_EXTRACT_DURATION_USER
    : TWO_PASS_EXTRACT_USER;

  const extractPrompt = extractTemplate
    .replace("{question}", question)
    .replace("{date}", questionDate)
    .replace("{history}", fullHistory);

  const extractionRaw = await provider.complete(extractPrompt, {
    maxTokens: 4096,
    temperature,
    timeoutMs: 90000,
    systemPrompt: TWO_PASS_EXTRACT_SYSTEM,
  } as any);

  const items = parseExtractionJson(extractionRaw);

  // If extraction failed (empty or parse error), fall back to single-pass
  if (items.length === 0) {
    const fallback = await generateAnswer(provider, question, questionDate, context, options);
    return { ...fallback, twoPassUsed: false };
  }

  // --- Pass 2: Count/Sum from structured data ---
  const isComparison = /which|what.*most|what.*least|what.*best|what.*worst|where.*most/i.test(question)
    && !isCountingQuestion(question) && !isDuration;

  let countTemplate: string;
  if (isDuration) {
    countTemplate = TWO_PASS_SUM_USER;
  } else if (isComparison) {
    countTemplate = TWO_PASS_COMPARE_USER;
  } else {
    countTemplate = TWO_PASS_COUNT_USER;
  }

  // Format items as readable JSON for Pass 2
  const qualifiedItems = items.map(item => ({
    id: item.id,
    description: item.description,
    qualifies: item.qualifies,
    duplicate_of: item.duplicate_of,
    reason: item.reason,
    ...(item.value !== undefined ? { value: item.value, unit: item.unit } : {}),
  }));

  const countPrompt = countTemplate
    .replace("{question}", question)
    .replace("{items_json}", JSON.stringify(qualifiedItems, null, 2));

  const answer = await provider.complete(countPrompt, {
    maxTokens: 1024,
    temperature,
    timeoutMs: 60000,
    systemPrompt: CHAIN_OF_NOTE_OPENAI_SYSTEM,
  } as any);

  const latencyMs = performance.now() - start;

  return {
    answer: answer.trim(),
    latencyMs,
    twoPassUsed: true,
    extractedItems: items,
  };
}

/**
 * Sleep helper for rate limiting between API calls.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry wrapper with exponential backoff for transient errors.
 * Handles 429 (rate limit) and 529 (overloaded) responses.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 7,
  baseDelayMs: number = 2000
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isRetryable =
        error instanceof LlmError &&
        (error.statusCode === 429 || error.statusCode === 500 || error.statusCode === 529);
      if (isRetryable && attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        const reason = error.statusCode === 429 ? "Rate limited" : "Overloaded";
        console.log(`  ${reason}, retrying in ${delay}ms...`);
        await sleep(delay);
        continue;
      }
      throw error;
    }
  }
  throw new Error("Unreachable");
}
