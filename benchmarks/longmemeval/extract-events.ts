/**
 * Event Extraction for LongMemEval Benchmark
 *
 * Pre-extracts structured events from haystack sessions using Gemini.
 * Events are cached per question to avoid re-extraction.
 *
 * The extracted events serve two purposes:
 * 1. Stored as knowledge entries → FTS5 bridges vocabulary gaps in retrieval
 * 2. Injected into answer context → GPT-4o counts structured records, not prose
 *
 * Usage:
 *   npx tsx benchmarks/longmemeval/extract-events.ts                    # extract all multi-session Qs
 *   npx tsx benchmarks/longmemeval/extract-events.ts --limit=5          # extract first 5
 *   npx tsx benchmarks/longmemeval/extract-events.ts --ids=0a995998     # extract specific questions
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { GeminiProvider } from "../../src/extensions/llm-extraction/gemini-provider.js";
import type { LongMemQuestion, LongMemTurn } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data");
const CACHE_DIR = join(DATA_DIR, "event-cache");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtractedEvent {
  /** What happened — concise, searchable */
  summary: string;
  /** When (if mentioned) */
  date?: string;
  /** Category for filtering */
  category: string;
  /** Source session index in the haystack */
  sessionIndex: number;
  /** Source LongMemEval session ID */
  sessionId: string;
}

/**
 * SVO (Subject-Verb-Object) event tuple with lexical aliases.
 * Inspired by Chronos (arxiv 2603.16862): SVO events with aliases are worth
 * -34.5pp when removed for GPT-4o. The aliases bridge vocabulary gaps that
 * kill BM25 retrieval.
 */
export interface SVOEvent {
  subject: string;
  verb: string;
  object: string;
  /** ISO 8601 datetime or descriptive date */
  startDate: string | null;
  /** ISO 8601 datetime or descriptive date */
  endDate: string | null;
  /** 2-3 rephrasings using completely different vocabulary */
  aliases: string[];
  category: string;
  sessionIndex: number;
  sessionId: string;
}

export interface QuestionEvents {
  questionId: string;
  events: ExtractedEvent[];
  /** SVO-format events (new format, may coexist with prose events) */
  svoEvents?: SVOEvent[];
  extractedAt: string;
  sessionCount: number;
  /** Format identifier: "svo" for new format, "prose" or absent for legacy */
  format?: "svo" | "prose";
}

// ---------------------------------------------------------------------------
// Extraction prompt — focused on countable personal events
// ---------------------------------------------------------------------------

const EXTRACTION_PROMPT = `Extract all concrete EVENTS, ACTIVITIES, PURCHASES, and FACTS from this conversation between a user and an assistant.

For each event, return:
- "summary": One sentence, plain language, include specific names/numbers/places. Start with "User..."
- "date": Date if mentioned (any format), or null
- "category": One of: entertainment, work, health, purchase, social, travel, hobby, food, home, finance, fitness, personal, education, pet

Rules:
- Extract ACTIONS the user took, not general discussion topics
- Include quantities and specific names (e.g., "User bought a Tamiya 1/48 Spitfire model kit" not "User discussed model kits")
- Include casual asides ("by the way, I also...") — these often contain key events
- One event per distinct action. If user mentions 3 things, extract 3 events.
- Maximum 15 events per conversation.

Return ONLY valid JSON array (no markdown, no explanation):
[
  {"summary": "User attended Austin Film Festival 48-hour challenge", "date": "March 2023", "category": "entertainment"},
  {"summary": "User bought new boots from Zara and exchanged for larger size", "date": null, "category": "purchase"}
]

If no events found, return: []

Conversation:
`;

/**
 * SVO extraction prompt — produces structured Subject-Verb-Object tuples
 * with 2-3 lexical aliases per event. Inspired by Chronos (arxiv 2603.16862).
 *
 * The aliases use COMPLETELY different vocabulary to bridge BM25 vocabulary gaps.
 * Example: "bought Fitbit" → aliases: "picked up a fitness tracker", "got a step counter"
 */
const SVO_EXTRACTION_PROMPT = `Extract all concrete EVENTS, ACTIVITIES, PURCHASES, and FACTS from this conversation as Subject-Verb-Object tuples.

For each event, return:
- "subject": Who did it (usually "User")
- "verb": The action (past tense: "bought", "attended", "visited", "cooked", "started")
- "object": What was acted upon, with specific names/numbers/places
- "startDate": When it happened (any format), or null
- "endDate": When it ended (if a period), or null (same as startDate for point events)
- "aliases": 2-3 rephrasings using COMPLETELY DIFFERENT vocabulary. Avoid repeating key nouns from the object.
  Example for "bought Fitbit": ["picked up a fitness tracker", "got a step counter", "purchased a wearable device"]
  Example for "attended concert": ["went to a live music show", "saw a band perform", "was at a gig"]
- "category": One of: entertainment, work, health, purchase, social, travel, hobby, food, home, finance, fitness, personal, education, pet

Rules:
- Extract ACTIONS the user took, not general discussion topics
- Include quantities and specific names
- Include casual asides ("by the way, I also...") — these often contain key events
- One event per distinct action
- EVERY event MUST have subject, verb, AND object — skip vague events that lack any of these
- Aliases must use DIFFERENT words, not just rearrangements
- Maximum 15 events per conversation

Return ONLY valid JSON array (no markdown, no explanation):
[
  {"subject": "User", "verb": "bought", "object": "Tamiya 1/48 Spitfire model kit from Hobbyking", "startDate": "August 2023", "endDate": null, "aliases": ["purchased a scale airplane model online", "ordered a WWII fighter plastic kit", "picked up a Tamiya aircraft model"], "category": "hobby"},
  {"subject": "User", "verb": "attended", "object": "Austin Film Festival 48-hour challenge", "startDate": "March 2023", "endDate": "March 2023", "aliases": ["went to a movie-making competition in Austin", "participated in a film contest", "was at a short film event"], "category": "entertainment"}
]

If no events found, return: []

Conversation:
`;

// ---------------------------------------------------------------------------
// Provider setup
// ---------------------------------------------------------------------------

function loadEnv(): void {
  try {
    const envPath = join(__dirname, "../../.env");
    const envContent = readFileSync(envPath, "utf-8");
    for (const line of envContent.split("\n")) {
      const match = line.match(/^(\w+)=(.+)$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].trim();
      }
    }
  } catch { /* .env not found */ }
}

function createProvider(): GeminiProvider {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY required for event extraction");
  }
  return new GeminiProvider({ apiKey, model: "gemini-2.5-flash" });
}

function turnsToText(turns: LongMemTurn[]): string {
  return turns
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`)
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

async function extractEventsFromSession(
  provider: GeminiProvider,
  turns: LongMemTurn[],
  sessionIndex: number,
  sessionId: string
): Promise<ExtractedEvent[]> {
  const text = turnsToText(turns);
  // Truncate very long sessions to stay within context limits
  const truncated = text.slice(0, 12000);

  const prompt = EXTRACTION_PROMPT + truncated;

  try {
    const response = await provider.complete(prompt, {
      maxTokens: 2000,
      temperature: 0,
      timeoutMs: 30000,
    });

    // Parse JSON response — handle markdown wrapping
    let cleaned = response.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }

    const parsed = JSON.parse(cleaned);
    const events: ExtractedEvent[] = (Array.isArray(parsed) ? parsed : []).map(
      (e: any) => ({
        summary: String(e.summary || "").slice(0, 200),
        date: e.date || undefined,
        category: String(e.category || "personal"),
        sessionIndex,
        sessionId,
      })
    );

    return events;
  } catch (err) {
    console.error(
      `    [WARN] Extraction failed for session ${sessionIndex}:`,
      err instanceof Error ? err.message : err
    );
    return [];
  }
}

/**
 * Extract SVO event tuples with lexical aliases from a single session.
 * Uses the SVO_EXTRACTION_PROMPT for structured output.
 */
async function extractSVOFromSession(
  provider: GeminiProvider,
  turns: LongMemTurn[],
  sessionIndex: number,
  sessionId: string
): Promise<SVOEvent[]> {
  const text = turnsToText(turns);
  const truncated = text.slice(0, 12000);
  const prompt = SVO_EXTRACTION_PROMPT + truncated;

  try {
    const response = await provider.complete(prompt, {
      maxTokens: 8000, // SVO + aliases needs more tokens than prose summaries
      temperature: 0,
      timeoutMs: 60000,
      jsonMode: true, // Gemini responseMimeType: "application/json" — eliminates JSON format errors
    });

    let cleaned = response.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }

    const parsed = JSON.parse(cleaned);
    const events: SVOEvent[] = (Array.isArray(parsed) ? parsed : [])
      .filter((e: any) => e.subject && e.verb && e.object) // Chronos: skip incomplete tuples
      .map((e: any) => ({
        subject: String(e.subject || "User").slice(0, 100),
        verb: String(e.verb || "").slice(0, 100),
        object: String(e.object || "").slice(0, 300),
        startDate: e.startDate || e.start_date || null,
        endDate: e.endDate || e.end_date || null,
        aliases: Array.isArray(e.aliases) ? e.aliases.map((a: any) => String(a).slice(0, 200)) : [],
        category: String(e.category || "personal"),
        sessionIndex,
        sessionId,
      }));

    return events;
  } catch (err) {
    console.error(
      `    [WARN] SVO extraction failed for session ${sessionIndex}:`,
      err instanceof Error ? err.message : err
    );
    return [];
  }
}

/**
 * Extract SVO events for a full question's haystack.
 * Caches results in data/event-cache/svo-events-{questionId}.json
 */
export async function extractSVOForQuestion(
  provider: GeminiProvider,
  question: LongMemQuestion
): Promise<QuestionEvents> {
  const cachePath = join(CACHE_DIR, `svo-events-${question.question_id}.json`);

  // Check cache
  if (existsSync(cachePath)) {
    const cached = JSON.parse(readFileSync(cachePath, "utf8")) as QuestionEvents;
    return cached;
  }

  const allSVO: SVOEvent[] = [];
  const allEvents: ExtractedEvent[] = [];
  const sessions = question.haystack_sessions;
  const sessionIds = question.haystack_session_ids;

  for (let idx = 0; idx < sessions.length; idx++) {
    const svoEvents = await extractSVOFromSession(
      provider,
      sessions[idx],
      idx,
      sessionIds[idx]
    );
    allSVO.push(...svoEvents);

    // Also create legacy ExtractedEvent for backward compatibility
    for (const svo of svoEvents) {
      allEvents.push({
        summary: `${svo.subject} ${svo.verb} ${svo.object}`,
        date: svo.startDate || undefined,
        category: svo.category,
        sessionIndex: svo.sessionIndex,
        sessionId: svo.sessionId,
      });
    }

    if ((idx + 1) % 10 === 0) {
      process.stdout.write(` ${idx + 1}/${sessions.length}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  const result: QuestionEvents = {
    questionId: question.question_id,
    events: allEvents,
    svoEvents: allSVO,
    extractedAt: new Date().toISOString(),
    sessionCount: sessions.length,
    format: "svo",
  };

  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
  writeFileSync(cachePath, JSON.stringify(result, null, 2));

  return result;
}

/**
 * Load SVO events from cache, falling back to legacy prose events.
 * Legacy events are promoted to minimal SVO format for consistent typing.
 */
export function loadSVOEvents(questionId: string): SVOEvent[] {
  // Check SVO cache first
  const svoCachePath = join(CACHE_DIR, `svo-events-${questionId}.json`);
  if (existsSync(svoCachePath)) {
    const cached = JSON.parse(readFileSync(svoCachePath, "utf8")) as QuestionEvents;
    if (cached.svoEvents && cached.svoEvents.length > 0) return cached.svoEvents;
  }

  // Fall back to legacy event cache → promote to minimal SVO
  const cached = loadCachedEvents(questionId);
  if (!cached || cached.events.length === 0) return [];

  return cached.events.map((e) => ({
    subject: "User",
    verb: "did",
    object: e.summary.replace(/^User\s+/i, ""),
    startDate: e.date || null,
    endDate: null,
    aliases: [], // no aliases for legacy events
    category: e.category,
    sessionIndex: e.sessionIndex,
    sessionId: e.sessionId,
  }));
}

async function extractEventsForQuestion(
  provider: GeminiProvider,
  question: LongMemQuestion
): Promise<QuestionEvents> {
  const cachePath = join(CACHE_DIR, `events-${question.question_id}.json`);

  // Check cache
  if (existsSync(cachePath)) {
    const cached = JSON.parse(readFileSync(cachePath, "utf8")) as QuestionEvents;
    return cached;
  }

  const allEvents: ExtractedEvent[] = [];
  const sessions = question.haystack_sessions;
  const sessionIds = question.haystack_session_ids;

  // Extract from all sessions (batch with rate limiting)
  for (let idx = 0; idx < sessions.length; idx++) {
    const events = await extractEventsFromSession(
      provider,
      sessions[idx],
      idx,
      sessionIds[idx]
    );
    allEvents.push(...events);

    // Rate limit: ~15 RPM for free tier
    if ((idx + 1) % 10 === 0) {
      process.stdout.write(` ${idx + 1}/${sessions.length}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  const result: QuestionEvents = {
    questionId: question.question_id,
    events: allEvents,
    extractedAt: new Date().toISOString(),
    sessionCount: sessions.length,
  };

  // Cache
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
  writeFileSync(cachePath, JSON.stringify(result, null, 2));

  return result;
}

// ---------------------------------------------------------------------------
// Query-relevant event filtering
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "i", "me", "my", "the", "a", "an", "is", "was", "were", "are", "been",
  "be", "have", "has", "had", "do", "did", "does", "will", "would", "could",
  "should", "can", "may", "might", "shall", "to", "of", "in", "for", "on",
  "with", "at", "by", "from", "as", "into", "about", "that", "this", "it",
  "not", "but", "or", "and", "if", "so", "than", "too", "very", "just",
  "how", "many", "much", "what", "which", "who", "when", "where", "all",
  "each", "every", "any", "some", "no", "there", "here",
]);

/** Naive suffix stemmer — handles common English inflections for token matching */
function stem(word: string): string {
  if (word.length <= 3) return word;
  // Past tense: watched → watch, attended → attend
  if (word.endsWith("ed")) {
    const base = word.slice(0, -2);
    if (base.length > 2) return base;
    return word.slice(0, -1); // e.g. "used" → "use"
  }
  // Gerund: watching → watch
  if (word.endsWith("ing") && word.length > 5) return word.slice(0, -3);
  // Plural: movies → movie, exercises → exercise
  if (word.endsWith("ies") && word.length > 4) return word.slice(0, -3) + "y";
  if (word.endsWith("es") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 3) return word.slice(0, -1);
  return word;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1 && !STOPWORDS.has(t))
      .map(stem),
  );
}

/**
 * Filter events by relevance to the question using token overlap scoring.
 * Returns the top-K events sorted by coverage of question tokens.
 */
export function filterEventsByRelevance(
  events: ExtractedEvent[],
  question: string,
  topK: number = 10,
): ExtractedEvent[] {
  if (events.length <= topK) return events;

  const questionTokens = tokenize(question);
  if (questionTokens.size === 0) return events.slice(0, topK);

  const scored = events.map((event) => {
    const eventTokens = tokenize(event.summary);
    const overlap = [...questionTokens].filter((t) => eventTokens.has(t)).length;
    const coverage = overlap / questionTokens.size;
    return { event, score: coverage };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map((s) => s.event);
}

// ---------------------------------------------------------------------------
// Format events for answer prompt
// ---------------------------------------------------------------------------

/**
 * Format extracted events as a structured preamble for the answer prompt.
 * This gives GPT-4o a checklist of countable events instead of raw prose.
 */
export function formatEventsForPrompt(events: ExtractedEvent[], question: string): string {
  if (events.length === 0) return "";

  // Group by category
  const byCategory = new Map<string, ExtractedEvent[]>();
  for (const e of events) {
    const cat = e.category || "other";
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(e);
  }

  let output = "## Extracted Facts & Events from User's History\n";
  output += "(Use these as a checklist — each entry is a distinct event. Count carefully.)\n\n";

  for (const [category, catEvents] of byCategory) {
    output += `### ${category.charAt(0).toUpperCase() + category.slice(1)}\n`;
    for (const e of catEvents) {
      const dateTag = e.date ? ` (${e.date})` : "";
      output += `- ${e.summary}${dateTag}\n`;
    }
    output += "\n";
  }

  return output;
}

/**
 * Load cached events for a question.
 *
 * Checks two caches in order:
 * 1. Event cache (data/event-cache/) — our new extraction format
 * 2. Pro extraction cache (data/extraction-cache/) — existing LLM extractions from prior sessions
 *
 * The Pro cache contains KnowledgeEntry[] with fact/preference/episodic types.
 * We convert these to ExtractedEvent[] for consistent formatting.
 */
export function loadCachedEvents(questionId: string): QuestionEvents | null {
  // Check new event cache first
  const eventCachePath = join(CACHE_DIR, `events-${questionId}.json`);
  if (existsSync(eventCachePath)) {
    const cached = JSON.parse(readFileSync(eventCachePath, "utf8")) as QuestionEvents;
    if (cached.events.length > 0) return cached;
  }

  // Fall back to existing Pro extraction cache
  const proCachePath = join(DATA_DIR, "extraction-cache", `${questionId}.json`);
  if (existsSync(proCachePath)) {
    const entries = JSON.parse(readFileSync(proCachePath, "utf8")) as Array<{
      type: string;
      summary: string;
      sessionId: string;
      tags?: string[];
    }>;

    // Convert KnowledgeEntry[] to ExtractedEvent[]
    // Include episodic events AND facts (facts contain quantities like "70h gaming"
    // that are critical for counting/duration questions). Exclude preferences.
    const events: ExtractedEvent[] = entries
      .filter((e) => e.type === "episodic" || e.type === "fact")
      .map((e) => ({
        summary: e.summary,
        category: e.type === "episodic" ? "personal" : "fact",
        sessionIndex: parseInt(e.sessionId?.replace("longmemeval-", "") || "0", 10),
        sessionId: e.sessionId || "",
      }));

    if (events.length > 0) {
      return {
        questionId,
        events,
        extractedAt: "pro-cache",
        sessionCount: 0,
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// CLI: Pre-extract events
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);

  const skipArg = args.find((a) => a.startsWith("--skip="));
  const skip = skipArg ? parseInt(skipArg.split("=")[1], 10) : 70;

  const limitArg = args.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : 31;

  const idsArg = args.find((a) => a.startsWith("--ids="));
  const filterIds = idsArg ? new Set(idsArg.split("=")[1].split(",")) : null;

  const svo = args.includes("--svo");

  return { skip, limit, filterIds, svo };
}

async function main() {
  loadEnv();
  const { skip, limit, filterIds, svo } = parseArgs();

  const raw = readFileSync(join(DATA_DIR, "longmemeval_s_cleaned.json"), "utf8");
  const all: LongMemQuestion[] = JSON.parse(raw);
  let questions = all.slice(skip, skip + limit);
  if (filterIds) {
    questions = questions.filter((q) => filterIds.has(q.question_id));
  }

  const mode = svo ? "SVO" : "Prose";
  console.log(`${mode} Event Extraction: ${questions.length} questions\n`);

  const provider = createProvider();
  let totalEvents = 0;
  let cached = 0;

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];

    if (svo) {
      // SVO extraction mode
      const cachePath = join(CACHE_DIR, `svo-events-${q.question_id}.json`);
      const isCached = existsSync(cachePath);

      process.stdout.write(
        `  [${i + 1}/${questions.length}] Q${q.question_id} (${q.haystack_sessions.length} sessions)${isCached ? " [cached]" : ""}`
      );

      const result = await extractSVOForQuestion(provider, q);
      totalEvents += (result.svoEvents?.length || result.events.length);
      if (isCached) cached++;

      console.log(` → ${result.svoEvents?.length || 0} SVO events`);
    } else {
      // Legacy prose extraction mode
      const cachePath = join(CACHE_DIR, `events-${q.question_id}.json`);
      const isCached = existsSync(cachePath);

      process.stdout.write(
        `  [${i + 1}/${questions.length}] Q${q.question_id} (${q.haystack_sessions.length} sessions)${isCached ? " [cached]" : ""}`
      );

      const result = await extractEventsForQuestion(provider, q);
      totalEvents += result.events.length;
      if (isCached) cached++;

      console.log(` → ${result.events.length} events`);
    }
  }

  console.log(
    `\nDone: ${totalEvents} total events extracted, ${cached} from cache`
  );
}

// Only run main if executed directly (not imported)
const isMain = process.argv[1]?.includes("extract-events");
if (isMain) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
