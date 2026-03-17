/**
 * Mem0 Retrieval Quality Benchmark (Skeleton)
 *
 * Loads the same corpus of 50 operational learnings used by the Strata benchmark
 * and runs them through Mem0's API for comparison.
 *
 * Requires MEM0_API_KEY environment variable. Skips gracefully if not set.
 *
 * Usage:
 *   MEM0_API_KEY=your-key npx tsx strata/benchmarks/mem0-benchmark.ts
 *   MEM0_API_KEY=your-key npm run benchmark:full   (from strata/)
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Learning {
  id: string;
  content: string;
  category: string;
  context: string;
  tags: string[];
}

interface TestQuery {
  id: string;
  query: string;
  relevant_ids: string[];
  description: string;
}

interface Corpus {
  learnings: Learning[];
  queries: TestQuery[];
}

interface QueryResult {
  queryId: string;
  query: string;
  relevantIds: string[];
  retrievedIds: string[];
  recall5: number;
  recall10: number;
  reciprocalRank: number;
  latencyMs: number;
}

interface BenchmarkResults {
  pipeline: string;
  numLearnings: number;
  numQueries: number;
  recall5: number;
  recall10: number;
  mrr: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  queryResults: QueryResult[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function loadCorpus(): Corpus {
  const corpusPath = join(__dirname, "operational-learnings.json");
  const raw = readFileSync(corpusPath, "utf-8");
  return JSON.parse(raw) as Corpus;
}

function computeRecall(retrieved: string[], relevant: string[], k: number): number {
  if (relevant.length === 0) return 1.0;
  const topK = retrieved.slice(0, k);
  const found = relevant.filter((id) => topK.includes(id)).length;
  return found / relevant.length;
}

function computeReciprocalRank(retrieved: string[], relevant: string[]): number {
  if (relevant.length === 0) return 1.0;
  for (let i = 0; i < retrieved.length; i++) {
    if (relevant.includes(retrieved[i])) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

/**
 * Sleep for the given number of milliseconds.
 * Used for rate-limit backoff.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Mem0 API Client
// ---------------------------------------------------------------------------

const MEM0_API_BASE = "https://api.mem0.ai/v1";

/** Mem0 add response is an array of pending events (async processing). */
type Mem0AddResponse = Array<{
  message: string;
  status: string;
  event_id: string;
}>;

/** Mem0 search response is a flat array of memory objects. */
type Mem0SearchResult = {
  id: string;
  memory: string;
  score: number;
  user_id: string;
  metadata: Record<string, string> | null;
};

/** Mem0 list response is a flat array of memory objects (no score). */
type Mem0ListResult = {
  id: string;
  memory: string;
  user_id: string;
  metadata: Record<string, string> | null;
};

class Mem0Client {
  private apiKey: string;
  private baseDelay = 500; // ms
  private maxRetries = 5;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Add a memory to Mem0.
   */
  async addMemory(
    content: string,
    metadata: Record<string, string>
  ): Promise<Mem0AddResponse> {
    return this.withRetry(async () => {
      const response = await fetch(`${MEM0_API_BASE}/memories/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Token ${this.apiKey}`,
        },
        body: JSON.stringify({
          messages: [
            {
              role: "user",
              content,
            },
          ],
          user_id: "strata-benchmark",
          metadata,
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Mem0 add failed: ${response.status} ${body}`);
      }

      return (await response.json()) as Mem0AddResponse;
    });
  }

  /**
   * Search Mem0 memories. Returns a flat array of results.
   */
  async searchMemories(
    query: string,
    limit: number = 20
  ): Promise<Mem0SearchResult[]> {
    return this.withRetry(async () => {
      const response = await fetch(`${MEM0_API_BASE}/memories/search/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Token ${this.apiKey}`,
        },
        body: JSON.stringify({
          query,
          user_id: "strata-benchmark",
          limit,
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Mem0 search failed: ${response.status} ${body}`);
      }

      return (await response.json()) as Mem0SearchResult[];
    });
  }

  /**
   * List all Mem0 memories for the benchmark user. Returns a flat array.
   */
  async listMemories(): Promise<Mem0ListResult[]> {
    return this.withRetry(async () => {
      const response = await fetch(
        `${MEM0_API_BASE}/memories/?user_id=strata-benchmark`,
        {
          method: "GET",
          headers: {
            Authorization: `Token ${this.apiKey}`,
          },
        }
      );

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Mem0 list failed: ${response.status} ${body}`);
      }

      return (await response.json()) as Mem0ListResult[];
    });
  }

  /**
   * Delete all memories for the benchmark user.
   */
  async deleteAll(): Promise<void> {
    await this.withRetry(async () => {
      const response = await fetch(
        `${MEM0_API_BASE}/memories/?user_id=strata-benchmark`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Token ${this.apiKey}`,
          },
        }
      );

      if (!response.ok && response.status !== 404) {
        const body = await response.text().catch(() => "");
        throw new Error(`Mem0 delete failed: ${response.status} ${body}`);
      }
    });
  }

  /**
   * Retry with exponential backoff for rate limiting.
   */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Check if it is a rate limit error (429)
        if (lastError.message.includes("429") && attempt < this.maxRetries) {
          const delay = this.baseDelay * Math.pow(2, attempt);
          console.log(
            `  Rate limited, waiting ${delay}ms before retry ${attempt + 1}/${this.maxRetries}...`
          );
          await sleep(delay);
          continue;
        }

        throw lastError;
      }
    }

    throw lastError || new Error("Max retries exceeded");
  }
}

// ---------------------------------------------------------------------------
// Benchmark Runner
// ---------------------------------------------------------------------------

/**
 * Build a map from Mem0 memory ID → learning ID using content similarity.
 *
 * Mem0 may rephrase or merge memories, so we use a fuzzy content match:
 * for each stored Mem0 memory, find the original learning whose content
 * shares the most significant words with the stored memory text.
 */
function buildContentMap(
  mem0Memories: Mem0ListResult[],
  learnings: Learning[]
): Map<string, string> {
  const map = new Map<string, string>();

  // Pre-tokenize all learnings
  const learningTokens = learnings.map((l) => ({
    id: l.id,
    tokens: new Set(
      l.content.toLowerCase().split(/\s+/).filter((t) => t.length > 3)
    ),
  }));

  for (const mem of mem0Memories) {
    // First try metadata match (most reliable)
    if (mem.metadata?.learning_id) {
      map.set(mem.id, mem.metadata.learning_id);
      continue;
    }

    // Fall back to content similarity
    const memTokens = new Set(
      mem.memory.toLowerCase().split(/\s+/).filter((t) => t.length > 3)
    );

    let bestId = "";
    let bestOverlap = 0;

    for (const lt of learningTokens) {
      let overlap = 0;
      for (const t of memTokens) {
        if (lt.tokens.has(t)) overlap++;
      }
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestId = lt.id;
      }
    }

    if (bestId && bestOverlap >= 2) {
      map.set(mem.id, bestId);
    }
  }

  return map;
}

async function runMem0Benchmark(corpus: Corpus): Promise<BenchmarkResults> {
  const apiKey = process.env.MEM0_API_KEY;
  if (!apiKey) {
    throw new Error("MEM0_API_KEY environment variable is not set");
  }

  const client = new Mem0Client(apiKey);

  // Clean up any existing benchmark data
  console.log("  Cleaning up existing Mem0 benchmark data...");
  await client.deleteAll();
  await sleep(2000);

  // Load all learnings into Mem0 (adds are async — Mem0 processes them in the background)
  console.log("  Loading learnings into Mem0...");
  for (let i = 0; i < corpus.learnings.length; i++) {
    const learning = corpus.learnings[i];
    await client.addMemory(learning.content, {
      learning_id: learning.id,
      category: learning.category,
    });

    if ((i + 1) % 10 === 0) {
      console.log(`  Loaded ${i + 1}/${corpus.learnings.length} learnings`);
    }

    // Small delay between adds to avoid rate limiting
    await sleep(300);
  }

  console.log(`  All ${corpus.learnings.length} learnings submitted.`);

  // Wait for Mem0's async processing to complete
  console.log("  Waiting for Mem0 async processing (30s)...");
  await sleep(30000);

  // List all stored memories and build content-based ID mapping
  console.log("  Building Mem0 ID → learning ID mapping...");
  const allMemories = await client.listMemories();
  console.log(`  Mem0 stored ${allMemories.length} memories from ${corpus.learnings.length} learnings`);

  const mem0IdToLearningId = buildContentMap(allMemories, corpus.learnings);
  console.log(`  Mapped ${mem0IdToLearningId.size} Mem0 memories to learning IDs`);

  // Run queries and collect metrics
  console.log("  Running queries...");
  const queryResults: QueryResult[] = [];

  for (const testQuery of corpus.queries) {
    const start = performance.now();
    const results = await client.searchMemories(testQuery.query, 20);
    const elapsed = performance.now() - start;

    // Map Mem0 result IDs back to learning IDs
    const retrievedLearningIds = results
      .map((r) => mem0IdToLearningId.get(r.id))
      .filter((id): id is string => id !== undefined);

    const recall5 = computeRecall(retrievedLearningIds, testQuery.relevant_ids, 5);
    const recall10 = computeRecall(retrievedLearningIds, testQuery.relevant_ids, 10);
    const rr = computeReciprocalRank(retrievedLearningIds, testQuery.relevant_ids);

    queryResults.push({
      queryId: testQuery.id,
      query: testQuery.query,
      relevantIds: testQuery.relevant_ids,
      retrievedIds: retrievedLearningIds.slice(0, 10),
      recall5,
      recall10,
      reciprocalRank: rr,
      latencyMs: elapsed,
    });

    // Small delay between queries
    await sleep(200);
  }

  // Compute aggregate metrics
  const avgRecall5 = queryResults.reduce((s, q) => s + q.recall5, 0) / queryResults.length;
  const avgRecall10 = queryResults.reduce((s, q) => s + q.recall10, 0) / queryResults.length;
  const avgMrr = queryResults.reduce((s, q) => s + q.reciprocalRank, 0) / queryResults.length;

  const latencies = queryResults.map((q) => q.latencyMs).sort((a, b) => a - b);
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);

  // Clean up
  console.log("  Cleaning up Mem0 benchmark data...");
  await client.deleteAll();

  return {
    pipeline: "Mem0 (hosted API)",
    numLearnings: corpus.learnings.length,
    numQueries: corpus.queries.length,
    recall5: avgRecall5,
    recall10: avgRecall10,
    mrr: avgMrr,
    p50LatencyMs: p50,
    p95LatencyMs: p95,
    queryResults,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("Mem0 Retrieval Quality Benchmark");
  console.log("================================\n");

  // Check for API key
  if (!process.env.MEM0_API_KEY) {
    console.log(
      "MEM0_API_KEY environment variable is not set. Skipping Mem0 benchmark.\n" +
        "To run the Mem0 comparison, set the MEM0_API_KEY env var:\n" +
        "  MEM0_API_KEY=your-key npx tsx strata/benchmarks/mem0-benchmark.ts\n"
    );
    process.exit(0);
  }

  const corpus = loadCorpus();
  console.log(`Corpus: ${corpus.learnings.length} learnings, ${corpus.queries.length} queries\n`);

  console.log("Running Mem0 benchmark...");
  try {
    const results = await runMem0Benchmark(corpus);

    console.log("\n--- Results ---\n");

    const lines = [
      `## ${results.pipeline}`,
      "",
      "| Metric | Value |",
      "|--------|-------|",
      `| Recall@5 | ${results.recall5.toFixed(3)} |`,
      `| Recall@10 | ${results.recall10.toFixed(3)} |`,
      `| MRR | ${results.mrr.toFixed(3)} |`,
      `| p50 latency | ${results.p50LatencyMs.toFixed(1)}ms |`,
      `| p95 latency | ${results.p95LatencyMs.toFixed(1)}ms |`,
    ];

    console.log(lines.join("\n"));

    console.log("\n--- JSON Results ---\n");
    console.log(JSON.stringify(results, null, 2));
  } catch (err) {
    console.error(
      "Mem0 benchmark failed:",
      err instanceof Error ? err.message : String(err)
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
