/**
 * Query Decomposition for LongMemEval Benchmark
 *
 * For counting/aggregation questions ("How many X?"), decomposes into
 * multiple targeted sub-queries to surface scattered evidence.
 *
 * "How many doctors did I visit?" → ["doctor appointment", "medical specialist",
 *  "clinic visit", "health checkup", "physician"]
 *
 * Each sub-query runs through searchAsync(), results are merged via simple
 * session deduplication (keep best score per session across all sub-queries).
 */

import type { LlmProvider } from "../../src/extensions/llm-extraction/llm-provider.js";
import type { SearchResult } from "../../src/search/sqlite-search-engine.js";
import type { SqliteSearchEngine } from "../../src/search/sqlite-search-engine.js";

/** Detect counting/aggregation intent */
export function isDecomposable(question: string): boolean {
  return /how many|how often|list all|total|how much/i.test(question);
}

/**
 * Generate sub-queries for a counting question using an LLM.
 */
export async function decomposeQuery(
  question: string,
  provider: LlmProvider,
  numQueries: number = 5
): Promise<string[]> {
  const prompt = `Given a question about a user's conversation history, generate ${numQueries} different search queries to find ALL instances and mentions relevant to answering this question.

The user's conversations use everyday language, not formal terms. Generate queries using:
- Synonyms and related terms
- Specific sub-types and categories
- Both formal and informal phrasings
- Individual items that might be mentioned separately

Question: ${question}

Return ONLY a JSON array of ${numQueries} query strings, no explanation.`;

  try {
    const raw = await provider.complete(prompt, {
      maxTokens: 512,
      temperature: 0,
      timeoutMs: 15000,
    });

    // Parse JSON array from response
    const cleaned = raw.trim();
    const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [question]; // fallback to original

    const queries = JSON.parse(jsonMatch[0]) as string[];
    if (!Array.isArray(queries) || queries.length === 0) return [question];

    return queries.slice(0, numQueries);
  } catch {
    return [question]; // fallback to original query on any error
  }
}

/**
 * Run decomposed search: generate sub-queries, search each, merge results.
 * Returns merged SearchResult[] with best score per session across all sub-queries.
 */
export async function decomposedSearch(
  question: string,
  searchEngine: SqliteSearchEngine,
  provider: LlmProvider,
  options?: { numQueries?: number; limit?: number }
): Promise<SearchResult[]> {
  const numQueries = options?.numQueries ?? 5;
  const limit = options?.limit ?? 20;

  // Generate sub-queries
  const subQueries = await decomposeQuery(question, provider, numQueries);

  // Also include the original question
  const allQueries = [question, ...subQueries];

  // Run each query
  const allResults: SearchResult[] = [];
  for (const query of allQueries) {
    const results = await searchEngine.searchAsync(query, { limit });
    allResults.push(...results);
  }

  // Merge: deduplicate by session, keep best score per session
  const bestBySession = new Map<string, SearchResult>();
  for (const r of allResults) {
    const existing = bestBySession.get(r.sessionId);
    if (!existing || r.score > existing.score) {
      bestBySession.set(r.sessionId, r);
    }
  }

  // Sort by score descending, limit results
  return [...bestBySession.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
