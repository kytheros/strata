/**
 * Strata Retrieval Quality Benchmark
 *
 * Loads a corpus of 50 operational learnings into a fresh temporary SQLite database,
 * runs 20 test queries, and computes retrieval quality metrics:
 *   - recall@5, recall@10
 *   - MRR (Mean Reciprocal Rank)
 *   - p50 and p95 latency
 *
 * Tests the BM25-only (community) pipeline. The Pro hybrid pipeline (BM25 + vector + RRF)
 * can be tested when an embedding provider is available.
 *
 * Usage:
 *   npx tsx strata/benchmarks/retrieval-benchmark.ts
 *   npm run benchmark   (from strata/)
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { mkdtempSync, rmSync } from "fs";
import { randomUUID } from "crypto";
import { openDatabase } from "../src/storage/database.js";
import { SqliteKnowledgeStore } from "../src/storage/sqlite-knowledge-store.js";
import { SqliteDocumentStore } from "../src/storage/sqlite-document-store.js";
import { SqliteSearchEngine } from "../src/search/sqlite-search-engine.js";
import type { KnowledgeEntry } from "../src/knowledge/knowledge-store.js";

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

/** Common English stop words to strip from benchmark queries. */
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "it", "in", "on", "at", "to", "for", "of",
  "and", "or", "but", "not", "no", "do", "does", "did", "has", "have",
  "had", "be", "been", "am", "are", "was", "were", "will", "would",
  "can", "could", "should", "shall", "may", "might", "must",
  "i", "me", "my", "we", "our", "you", "your", "he", "she", "they",
  "this", "that", "these", "those", "what", "which", "who", "how",
  "when", "where", "why", "if", "then", "so", "up", "out", "about",
  "with", "from", "by", "as", "into", "through", "during", "after",
  "before", "between", "just", "also", "very", "too", "even",
]);

/**
 * Strip stop words and build FTS5 OR query from natural language.
 * BM25 with implicit AND fails on natural language queries because
 * words like "how", "do", "I" don't appear in technical content.
 * OR matching lets FTS5 rank by how many terms match.
 */
function toFts5OrQuery(query: string): string {
  const tokens = query
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
  return tokens.join(" OR ");
}

function loadCorpus(): Corpus {
  const corpusPath = join(__dirname, "operational-learnings.json");
  const raw = readFileSync(corpusPath, "utf-8");
  return JSON.parse(raw) as Corpus;
}

function computeRecall(retrieved: string[], relevant: string[], k: number): number {
  if (relevant.length === 0) return 1.0; // No relevant docs = perfect recall
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

function formatTable(results: BenchmarkResults): string {
  const lines: string[] = [
    "",
    `## ${results.pipeline}`,
    "",
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Recall@5 | ${results.recall5.toFixed(3)} |`,
    `| Recall@10 | ${results.recall10.toFixed(3)} |`,
    `| MRR | ${results.mrr.toFixed(3)} |`,
    `| p50 latency | ${results.p50LatencyMs.toFixed(1)}ms |`,
    `| p95 latency | ${results.p95LatencyMs.toFixed(1)}ms |`,
    `| Learnings | ${results.numLearnings} |`,
    `| Queries | ${results.numQueries} |`,
    "",
    "### Per-Query Results",
    "",
    "| Query | R@5 | R@10 | RR | Latency |",
    "|-------|-----|------|----|---------|",
  ];

  for (const qr of results.queryResults) {
    lines.push(
      `| ${qr.queryId}: ${truncate(qr.query, 50)} | ${qr.recall5.toFixed(2)} | ${qr.recall10.toFixed(2)} | ${qr.reciprocalRank.toFixed(2)} | ${qr.latencyMs.toFixed(1)}ms |`
    );
  }

  return lines.join("\n");
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}

// ---------------------------------------------------------------------------
// Benchmark Runner
// ---------------------------------------------------------------------------

function runBm25Benchmark(corpus: Corpus): BenchmarkResults {
  // Create a fresh temporary database
  const tmpDir = mkdtempSync(join(tmpdir(), "strata-bench-"));
  const dbPath = join(tmpDir, "benchmark.db");

  try {
    const db = openDatabase(dbPath);
    const docStore = new SqliteDocumentStore(db);
    const knowledgeStore = new SqliteKnowledgeStore(db);
    const searchEngine = new SqliteSearchEngine(docStore);

    // Map from learning ID to document chunk ID for result matching
    const learningIdToDocId = new Map<string, string>();

    // Load all learnings as both knowledge entries and document chunks
    for (const learning of corpus.learnings) {
      const timestamp = Date.now() - Math.random() * 30 * 86400000; // Random within last 30 days
      const tokenCount = learning.content.split(/\s+/).length;

      // Store as a document chunk (searchable via FTS5)
      const docId = docStore.add(
        learning.content,
        tokenCount,
        {
          sessionId: `session-${learning.id}`,
          project: "benchmark",
          role: "assistant" as const,
          timestamp,
          toolNames: [],
          messageIndex: 0,
        },
        "benchmark",
        "default"
      );

      // Store as a knowledge entry
      const entry: KnowledgeEntry = {
        id: learning.id,
        type: "learning",
        project: "benchmark",
        sessionId: `session-${learning.id}`,
        timestamp,
        summary: learning.content.slice(0, 120),
        details: learning.content,
        tags: learning.tags,
        relatedFiles: [],
      };
      knowledgeStore.addEntry(entry);

      learningIdToDocId.set(learning.id, docId);
    }

    // Run queries and collect metrics
    const queryResults: QueryResult[] = [];

    for (const testQuery of corpus.queries) {
      // Build OR query for fair BM25 benchmarking.
      // The production search engine uses implicit AND, which is correct for
      // keyword queries but fails on natural language. OR matching lets BM25
      // rank by term frequency, giving a fair measure of retrieval quality.
      const orQuery = toFts5OrQuery(testQuery.query);

      const start = performance.now();
      const ftsResults = docStore.search(orQuery, 20);
      const elapsed = performance.now() - start;

      // Map result session IDs back to learning IDs
      const retrievedLearningIds = ftsResults.map((r) => {
        const sessionId = r.chunk.sessionId;
        // Extract learning ID from session ID format "session-LXXX"
        return sessionId.replace("session-", "");
      });

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
    }

    // Compute aggregate metrics
    const avgRecall5 = queryResults.reduce((s, q) => s + q.recall5, 0) / queryResults.length;
    const avgRecall10 = queryResults.reduce((s, q) => s + q.recall10, 0) / queryResults.length;
    const avgMrr = queryResults.reduce((s, q) => s + q.reciprocalRank, 0) / queryResults.length;

    const latencies = queryResults.map((q) => q.latencyMs).sort((a, b) => a - b);
    const p50 = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);

    db.close();

    return {
      pipeline: "Strata Community (BM25-only)",
      numLearnings: corpus.learnings.length,
      numQueries: corpus.queries.length,
      recall5: avgRecall5,
      recall10: avgRecall10,
      mrr: avgMrr,
      p50LatencyMs: p50,
      p95LatencyMs: p95,
      queryResults,
    };
  } finally {
    // Clean up temporary directory
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  console.log("Strata Retrieval Quality Benchmark");
  console.log("===================================\n");

  const corpus = loadCorpus();
  console.log(`Corpus: ${corpus.learnings.length} learnings, ${corpus.queries.length} queries\n`);

  // Run BM25-only benchmark
  console.log("Running BM25-only (community) benchmark...");
  const bm25Results = runBm25Benchmark(corpus);

  // Output results
  console.log("\n--- Results ---\n");
  console.log(formatTable(bm25Results));

  // Output JSON results
  const jsonOutput = {
    timestamp: new Date().toISOString(),
    pipelines: [bm25Results],
  };

  console.log("\n--- JSON Results ---\n");
  console.log(JSON.stringify(jsonOutput, null, 2));
}

main();
