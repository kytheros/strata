/**
 * Pro Pipeline for LongMemEval Benchmark
 *
 * Runs LLM-powered knowledge extraction on each haystack session,
 * stores entries in the in-memory database's knowledge table, and
 * provides search to retrieve relevant entries for the answer prompt.
 *
 * Uses the Pro extraction prompt (fact/preference/episodic types) which
 * is critical for LongMemEval — personal knowledge questions need these
 * types, not just coding patterns.
 *
 * Architecture: standalone benchmark module using community infrastructure
 * (GeminiProvider + SqliteKnowledgeStore). No strata-pro import needed.
 */

import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type Database from "better-sqlite3";
import type { LlmProvider } from "../../src/extensions/llm-extraction/llm-provider.js";
import { LlmError } from "../../src/extensions/llm-extraction/llm-provider.js";
import { GeminiProvider } from "../../src/extensions/llm-extraction/gemini-provider.js";
import { GeminiEmbedder } from "../../src/extensions/embeddings/gemini-embedder.js";
import { VectorSearch } from "../../src/extensions/embeddings/vector-search.js";
import { SqliteKnowledgeStore } from "../../src/storage/sqlite-knowledge-store.js";
import type { KnowledgeEntry } from "../../src/knowledge/knowledge-store.js";
import type { LongMemQuestion, LongMemTurn } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, "data", "extraction-cache");

// ── Extraction prompt (Pro-style with fact/preference/episodic types) ──

const EXTRACTION_PROMPT = `You are analyzing a conversation to extract knowledge entries. Find facts, preferences, decisions, solutions, and patterns — especially implicit ones that simple regex would miss.

Return ONLY valid JSON with this exact structure (no markdown, no explanation):
{
  "entries": [
    {
      "type": "decision|solution|error_fix|pattern|fact|preference|episodic",
      "summary": "Concise description (under 120 chars)",
      "details": "Optional elaboration with context",
      "tags": ["relevant", "tags"]
    }
  ]
}

Extraction rules:
- "fact": Concrete personal information — names, places, possessions, relationships, occupations, skills, hobbies, quantities. Example: "User has a Golden Retriever named Max".
- "preference": Opinions, likes, dislikes, habits, routines, or personal choices. Example: "User prefers Adobe Premiere Pro".
- "episodic": Events, activities, or experiences with temporal context. Example: "User attended an open mic night on Saturday".
- "decision": Choices between alternatives, even implicit ones.
- "solution": Problems solved, bugs fixed. Include WHAT was wrong and HOW it was fixed.
- "error_fix": Error message paired with its resolution.
- "pattern": Reusable approaches, anti-patterns, or best practices discovered.
- Maximum 10 entries total.
- Each summary under 120 characters.
- Prioritize facts, preferences, and episodic entries — these are the most commonly recalled.
- Do NOT extract trivial or generic information.

Session transcript:
`;

/** Valid extraction types (Pro superset) */
const VALID_TYPES = new Set([
  "decision", "solution", "error_fix", "pattern", "procedure",
  "fact", "preference", "episodic",
]);

/** Raw extraction output from LLM */
interface LlmExtractionOutput {
  entries: Array<{
    type: string;
    summary: string;
    details?: string;
    tags?: string[];
  }>;
}

// ── Provider management ────────────────────────────────────────────────

let _extractionProvider: LlmProvider | null = null;

function getExtractionProvider(): LlmProvider {
  if (!_extractionProvider) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY required for Pro pipeline knowledge extraction");
    }
    _extractionProvider = new GeminiProvider({ apiKey, model: "gemini-2.5-flash" });
  }
  return _extractionProvider;
}

// ── Extraction logic ───────────────────────────────────────────────────

/**
 * Convert LongMemEval turns to a compact transcript for the LLM.
 */
function turnsToTranscript(turns: LongMemTurn[]): string {
  const lines: string[] = [];
  let charBudget = 6000;

  for (const turn of turns) {
    if (charBudget <= 0) break;
    const prefix = turn.role === "user" ? "USER" : "ASSISTANT";
    const text = turn.content.slice(0, 400);
    const line = `[${prefix}] ${text}`;
    lines.push(line);
    charBudget -= line.length;
  }

  return lines.join("\n");
}

/**
 * Extract knowledge entries from a single session using Gemini.
 * Returns empty array on failure (never throws).
 */
async function extractFromSession(
  turns: LongMemTurn[],
  sessionId: string,
  sessionDate: string,
  provider: LlmProvider
): Promise<KnowledgeEntry[]> {
  try {
    const transcript = turnsToTranscript(turns);
    if (transcript.length < 50) return []; // Skip near-empty sessions

    const prompt = EXTRACTION_PROMPT + transcript;
    const raw = await provider.complete(prompt, {
      maxTokens: 4096,
      temperature: 0.1,
      timeoutMs: 30000,
    });

    const parsed = parseExtractionResponse(raw);
    return parsed.entries.map((e) => ({
      id: randomUUID(),
      type: e.type as KnowledgeEntry["type"],
      project: "longmemeval",
      sessionId,
      timestamp: new Date(sessionDate.replace(/\s*\([^)]*\)\s*/, " ").trim()).getTime() || Date.now(),
      summary: e.summary.slice(0, 120),
      details: e.details || "",
      tags: Array.isArray(e.tags) ? e.tags.slice(0, 10) : [],
      relatedFiles: [],
    }));
  } catch (err) {
    // Log but don't fail — extraction errors are non-fatal
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("timed out")) {
      console.error(`  [pro] Extraction failed for ${sessionId}: ${msg}`);
    }
    return [];
  }
}

// ── JSON parsing (same logic as enhanced-extractor.ts) ─────────────────

function parseExtractionResponse(raw: string): LlmExtractionOutput {
  const cleaned = extractJson(raw);
  const parsed = parseWithRepair(cleaned) as LlmExtractionOutput;

  if (!Array.isArray(parsed.entries)) {
    throw new Error("Invalid extraction output: missing entries array");
  }

  parsed.entries = parsed.entries
    .filter(
      (e) =>
        typeof e.type === "string" &&
        typeof e.summary === "string" &&
        VALID_TYPES.has(e.type)
    )
    .slice(0, 10);

  return parsed;
}

function extractJson(raw: string): string {
  let text = raw.trim();
  if (text.includes("```")) {
    const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenced) return fenced[1].trim();
  }
  if (text.startsWith("{") || text.startsWith("[")) return text;
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1);
  }
  return text;
}

function parseWithRepair(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    const entriesMatch = json.match(/"entries"\s*:\s*\[/);
    if (!entriesMatch) throw new Error("No entries array found in response");

    const arrayStart = json.indexOf("[", entriesMatch.index!);
    const objects: string[] = [];
    let depth = 0;
    let objStart = -1;

    for (let i = arrayStart + 1; i < json.length; i++) {
      const ch = json[i];
      if (ch === "{" && depth === 0) { objStart = i; depth = 1; }
      else if (ch === "{") { depth++; }
      else if (ch === "}" && depth > 1) { depth--; }
      else if (ch === "}" && depth === 1) { depth = 0; objects.push(json.slice(objStart, i + 1)); }
      else if (ch === '"') {
        i++;
        while (i < json.length && json[i] !== '"') {
          if (json[i] === "\\") i++;
          i++;
        }
      }
    }

    if (objects.length === 0) throw new Error("No complete entries in truncated response");
    return JSON.parse(`{"entries": [${objects.join(",")}]}`);
  }
}

// ── Public API ─────────────────────────────────────────────────────────

/** Result of running Pro extraction on a question's haystack */
export interface ProExtractionResult {
  knowledgeStore: SqliteKnowledgeStore;
  totalEntries: number;
  extractionTimeMs: number;
  /** Embedder for vector search on knowledge entries (null if no GEMINI_API_KEY) */
  embedder: GeminiEmbedder | null;
  /** Vector search instance for knowledge entries */
  vectorSearch: VectorSearch | null;
}

/**
 * Run Pro knowledge extraction on all sessions in a question's haystack.
 * Stores entries in the provided database's knowledge table.
 *
 * Caches extraction results to disk so subsequent runs skip Gemini API calls.
 * Cache key: question_id. Cache location: data/extraction-cache/{question_id}.json
 */
export async function runProExtraction(
  question: LongMemQuestion,
  db: Database.Database
): Promise<ProExtractionResult> {
  const start = performance.now();

  // Create embedder for knowledge entries so they get vector embeddings on write
  const apiKey = process.env.GEMINI_API_KEY;
  const embedder = apiKey ? new GeminiEmbedder({ apiKey }) : null;
  const vectorSearch = new VectorSearch(db);
  const knowledgeStore = new SqliteKnowledgeStore(db, embedder);

  // Try loading from cache first
  const cachedEntries = loadExtractionCache(question.question_id);
  let totalEntries = 0;

  if (cachedEntries) {
    // Cache hit — load entries directly into the knowledge store
    for (const entry of cachedEntries) {
      await knowledgeStore.addEntry(entry);
      totalEntries++;
    }
  } else {
    // Cache miss — run extraction via Gemini API
    const provider = getExtractionProvider();
    const allEntries: KnowledgeEntry[] = [];

    const sessions = question.haystack_sessions;
    const dates = question.haystack_dates;

    const BATCH_SIZE = 5;
    for (let i = 0; i < sessions.length; i += BATCH_SIZE) {
      const batch = sessions.slice(i, i + BATCH_SIZE);
      const batchPromises = batch.map((turns, j) => {
        const idx = i + j;
        const strataSessionId = `longmemeval-${idx}`;
        const dateStr = dates?.[idx] || "";
        return extractFromSession(turns, strataSessionId, dateStr, provider);
      });

      const batchResults = await Promise.all(batchPromises);

      for (const entries of batchResults) {
        for (const entry of entries) {
          allEntries.push(entry);
          await knowledgeStore.addEntry(entry);
          totalEntries++;
        }
      }

      // Rate limit padding between batches (Gemini free tier: 15 RPM)
      if (i + BATCH_SIZE < sessions.length) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    // Save to cache for future runs
    saveExtractionCache(question.question_id, allEntries);
  }

  // Wait briefly for async embeddings to flush (fire-and-forget in addEntry)
  if (embedder && totalEntries > 0) {
    await new Promise((r) => setTimeout(r, 1500));
  }

  return {
    knowledgeStore,
    totalEntries,
    extractionTimeMs: performance.now() - start,
    embedder,
    vectorSearch,
  };
}

// ── Extraction cache ───────────────────────────────────────────────────

function getCachePath(questionId: string): string {
  return join(CACHE_DIR, `${questionId}.json`);
}

function loadExtractionCache(questionId: string): KnowledgeEntry[] | null {
  const path = getCachePath(questionId);
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    if (Array.isArray(data) && data.length > 0) {
      return data as KnowledgeEntry[];
    }
    return null;
  } catch {
    return null;
  }
}

function saveExtractionCache(questionId: string, entries: KnowledgeEntry[]): void {
  try {
    if (!existsSync(CACHE_DIR)) {
      mkdirSync(CACHE_DIR, { recursive: true });
    }
    writeFileSync(getCachePath(questionId), JSON.stringify(entries));
  } catch (err) {
    // Cache write failure is non-fatal
    console.warn(`[cache] Failed to save extraction cache for ${questionId}:`, err);
  }
}

/**
 * Search knowledge store for entries relevant to a question.
 *
 * Primary: vector cosine similarity (bridges vocabulary gaps like "Tamiya Spitfire" → "model kits")
 * Fallback: LIKE keyword matching (when embeddings unavailable)
 *
 * This fixes the Critical finding from 4/5 review agents: LIKE search has
 * near-zero semantic recall on extracted knowledge entries.
 */
export async function searchKnowledge(
  knowledgeStore: SqliteKnowledgeStore,
  question: string,
  limit: number,
  embedder?: GeminiEmbedder | null,
  vectorSearch?: VectorSearch | null
): Promise<KnowledgeEntry[]> {
  // Primary path: vector cosine similarity search
  if (embedder && vectorSearch) {
    try {
      const queryVec = await embedder.embed(question, "RETRIEVAL_QUERY");
      const vectorResults = vectorSearch.searchAll(queryVec, limit * 2);

      if (vectorResults.length > 0) {
        // Map vector results back to KnowledgeEntry objects
        const entries: KnowledgeEntry[] = [];
        for (const vr of vectorResults) {
          if (entries.length >= limit) break;
          const entry = await knowledgeStore.getEntry(vr.entryId);
          if (entry) entries.push(entry);
        }
        if (entries.length > 0) return entries;
      }
    } catch (err) {
      // Vector search failed — fall through to LIKE
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("timed out")) {
        console.error(`  [pro] Vector knowledge search failed: ${msg}`);
      }
    }
  }

  // Fallback: LIKE keyword matching (original implementation)
  const directResults = await knowledgeStore.search(question);
  if (directResults.length >= limit) {
    return directResults.slice(0, limit);
  }

  const STOP_WORDS = new Set([
    "i", "me", "my", "we", "our", "you", "your", "he", "she", "it", "they",
    "a", "an", "the", "is", "was", "are", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "can", "shall", "to", "of", "in", "for",
    "on", "with", "at", "by", "from", "as", "into", "through", "about",
    "and", "but", "or", "nor", "not", "so", "if", "when", "what", "which",
    "who", "how", "many", "much", "that", "this", "these", "those",
    "there", "here", "all", "each", "every", "both", "few", "more",
    "most", "other", "some", "such", "no", "than", "too", "very",
  ]);

  const words = question.toLowerCase()
    .replace(/[?.,!'"]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  const seen = new Set<string>();
  const results: KnowledgeEntry[] = [];

  for (const entry of directResults) {
    if (!seen.has(entry.id)) { seen.add(entry.id); results.push(entry); }
  }

  for (const word of words) {
    if (results.length >= limit) break;
    const wordResults = await knowledgeStore.search(word);
    for (const entry of wordResults) {
      if (!seen.has(entry.id)) { seen.add(entry.id); results.push(entry); }
    }
  }

  return results.slice(0, limit);
}

/**
 * Format knowledge entries for inclusion in the answer prompt.
 */
export function formatKnowledgeForPrompt(entries: KnowledgeEntry[]): string {
  if (entries.length === 0) return "";

  const lines: string[] = ["Extracted knowledge from previous conversations:"];

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const details = e.details ? ` — ${e.details}` : "";
    lines.push(`${i + 1}. [${e.type}] ${e.summary}${details}`);
  }

  return lines.join("\n");
}
