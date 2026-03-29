/**
 * RRF Fusion Eval Script
 *
 * Evaluates hybrid search fusion quality using a frozen test corpus.
 * Seeds a test database, generates embeddings, runs 20 queries, scores results.
 *
 * FROZEN — DO NOT MODIFY THIS FILE.
 * Change only: src/config.ts (rrfK), src/search/hybrid-search.ts (fetchLimit multipliers)
 *
 * Usage: npx tsx autoresearch/rrf-fusion/run-eval.ts
 */

import Database from "better-sqlite3";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteDocumentStore } from "../../src/storage/sqlite-document-store.js";
import { VectorStore } from "../../src/extensions/vector-search/vector-store.js";
import { createEmbeddingProvider, type EmbeddingProvider } from "../../src/extensions/vector-search/embedding-provider.js";
import { HybridSearchEngine } from "../../src/search/hybrid-search.js";
import { SqliteSearchEngine } from "../../src/search/sqlite-search-engine.js";
import type { DocumentMetadata } from "../../src/indexing/document-store.js";
import { CONFIG } from "../../src/config.js";

// ── Corpus (FROZEN) ───────────────────────────────────────────────────────────

interface CorpusEntry {
  id: string;
  group: "A" | "B" | "C" | "D";
  text: string;
}

const CORPUS: CorpusEntry[] = [
  // Group A: Semantic matches (no keyword overlap with test queries)
  { id: "A1", group: "A", text: "Set up OAuth2 PKCE flow with refresh token rotation for the mobile app. Configured the authorization server endpoints and client credentials carefully to avoid leaking tokens." },
  { id: "A2", group: "A", text: "Switched from REST to gRPC for inter-service communication to reduce latency. Protocol Buffers reduced payload size by 70% compared to JSON." },
  { id: "A3", group: "A", text: "Implemented connection pooling with PgBouncer to handle 10k concurrent users. Tuned the pool_size and max_client_conn parameters for optimal throughput." },
  { id: "A4", group: "A", text: "Added rate limiting middleware using sliding window algorithm. Each IP gets 100 requests per minute with burst allowance of 150." },
  { id: "A5", group: "A", text: "Configured Terraform modules for multi-region failover. Primary region us-east-1, failover us-west-2 with 30 second RPO target." },
  { id: "A6", group: "A", text: "The React component was re-rendering excessively. Wrapped the expensive calculation in useMemo and added proper dependency arrays to useEffect hooks." },
  { id: "A7", group: "A", text: "Replaced bcrypt with Argon2id for password hashing — better resistance to GPU attacks. Salt rounds set to 3 with 65MB memory cost." },
  { id: "A8", group: "A", text: "Diagnosed memory leak in the Node.js service: event listeners were not being removed after WebSocket disconnect. Added cleanup in the close handler." },
  { id: "A9", group: "A", text: "Rewrote the image upload pipeline to stream directly to S3 instead of buffering in memory. Reduced peak RAM usage from 2GB to 150MB for large files." },
  { id: "A10", group: "A", text: "Set up Prometheus metrics and Grafana dashboards for the microservice. p99 latency alerts trigger at 500ms threshold." },

  // Group B: Keyword matches (exact words match test queries)
  { id: "B1", group: "B", text: "Fixed authentication bug where login tokens weren't refreshing properly after expiry. The access token was expiring but the refresh flow was not being triggered." },
  { id: "B2", group: "B", text: "The API performance was slow because of N+1 queries in the GraphQL resolver. Added DataLoader batching to fix the database query bottleneck." },
  { id: "B3", group: "B", text: "Database scaling bottleneck identified in the user sessions table. Added composite index on (user_id, created_at) to speed up queries." },
  { id: "B4", group: "B", text: "API abuse protection was insufficient — bots were hammering the search endpoint. Implemented IP-based rate limiting and CAPTCHA for suspicious patterns." },
  { id: "B5", group: "B", text: "Infrastructure disaster recovery drill completed. Restored from backup in 45 minutes, well within the 2-hour RTO target." },
  { id: "B6", group: "B", text: "CSS rendering performance was slow on mobile. Replaced heavy animations with CSS transforms and reduced paint areas." },
  { id: "B7", group: "B", text: "Memory leak in the frontend application was causing browser tab crashes after 2 hours of use. Found the culprit: global event listeners in a React component." },
  { id: "B8", group: "B", text: "Slow query optimization: the EXPLAIN ANALYZE showed a sequential scan on the orders table. Added a partial index on status='pending' to fix it." },

  // Group C: Both keyword AND semantic match (should rank highest)
  { id: "C1", group: "C", text: "Authentication login flow was broken because OAuth tokens expired silently. Fixed the token refresh logic and added proper error handling for 401 responses." },
  { id: "C2", group: "C", text: "API performance degraded under load — profiler showed slow database queries were the bottleneck. Optimized the hot path by adding query caching and an index." },
  { id: "C3", group: "C", text: "Database scaling was the bottleneck for our high-traffic API endpoint. Implemented read replicas and connection pooling which improved throughput 4x." },
  { id: "C4", group: "C", text: "Rate limiting and API abuse protection needed upgrading. Added Redis-backed sliding window rate limiter with per-user and per-IP limits." },
  { id: "C5", group: "C", text: "Infrastructure disaster recovery was improved by automating backup restoration. The new pipeline tests database integrity and failover automatically." },

  // Group C (continued): Combined matches for topics that lacked proper C/B entries
  { id: "C6", group: "C", text: "Password security vulnerability discovered: the hashing implementation was using SHA-1 without salt. Upgraded to bcrypt with security-hardened parameters and enforced password complexity rules." },
  { id: "C7", group: "C", text: "Monitoring system flagged anomalous latency in the metrics collector. The Prometheus scrape interval was too aggressive, causing the metrics ingestion pipeline to fall behind and report stale latency data." },
  { id: "C8", group: "C", text: "Slow query log analysis revealed missing database indexes. Added covering indexes for the three most expensive queries which reduced median query time from 800ms to 12ms." },

  // Group B (continued): Keyword matches for topics that lacked proper B entries
  { id: "B9", group: "B", text: "Completed a security review of the password hashing module. Updated the hashing algorithm parameters to meet current security best practices." },
  { id: "B10", group: "B", text: "Configured latency monitoring dashboards in Grafana with custom metrics. Each service reports request latency via StatsD for monitoring percentile trends." },

  // Group D: Distractors (15 entries)
  { id: "D1", group: "D", text: "Updated the package.json to use ESM modules instead of CommonJS. Changed all imports to use .js extensions." },
  { id: "D2", group: "D", text: "Fixed a typo in the README documentation for the installation guide." },
  { id: "D3", group: "D", text: "Configured Prettier and ESLint for consistent code style across the monorepo." },
  { id: "D4", group: "D", text: "Added dark mode support to the marketing site using CSS custom properties." },
  { id: "D5", group: "D", text: "Migrated the test suite from Jest to Vitest for faster test execution." },
  { id: "D6", group: "D", text: "Set up Dependabot for automated dependency updates on GitHub." },
  { id: "D7", group: "D", text: "Created a new Storybook component for the button variants in the design system." },
  { id: "D8", group: "D", text: "Wrote integration tests for the checkout flow using Playwright." },
  { id: "D9", group: "D", text: "Optimized the webpack bundle size by splitting vendor chunks and enabling tree shaking." },
  { id: "D10", group: "D", text: "Added TypeScript strict mode to the project and fixed all resulting type errors." },
  { id: "D11", group: "D", text: "Set up GitHub Actions for CI/CD with matrix testing on Node.js 18 and 20." },
  { id: "D12", group: "D", text: "Refactored the color token system to use CSS custom properties throughout the design system." },
  { id: "D13", group: "D", text: "Implemented infinite scroll pagination in the data table component using Intersection Observer." },
  { id: "D14", group: "D", text: "Fixed the mobile navigation menu that was not closing when clicking outside." },
  { id: "D15", group: "D", text: "Added Zod schema validation for all API request bodies in the Express router." },
];

// ── Queries (FROZEN) ──────────────────────────────────────────────────────────

interface QuerySpec {
  q: string;
  /** corpus ID expected in top 3 for 1 point (null = no C match) */
  cId: string | null;
  /** corpus ID expected in top 5 for 1 point (null = skip B point) */
  bId: string | null;
  /** corpus ID expected in top 10 for 1 point */
  aId: string;
}

const QUERIES: QuerySpec[] = [
  { q: "authentication login",        cId: "C1", bId: "B1", aId: "A1" },
  { q: "API performance slow",        cId: "C2", bId: "B2", aId: "A4" },
  { q: "database scaling bottleneck", cId: "C3", bId: "B3", aId: "A3" },
  { q: "API abuse protection",        cId: "C4", bId: "B4", aId: "A4" },
  { q: "infrastructure disaster recovery", cId: "C5", bId: "B5", aId: "A5" },
  { q: "component rendering performance", cId: "B6", bId: "B6", aId: "A6" }, // B6 as C substitute
  { q: "password security hashing",   cId: "C6", bId: "B9", aId: "A7" },
  { q: "memory leak debugging",       cId: "B7", bId: "B7", aId: "A8" }, // B7 as C substitute
  { q: "file upload optimization",    cId: null, bId: null, aId: "A9" }, // A-only query
  { q: "monitoring metrics latency",  cId: "C7", bId: "B10", aId: "A10" },
  { q: "token refresh expired",       cId: "C1", bId: "B1", aId: "A1" },
  { q: "slow query database index",   cId: "C8", bId: "B8", aId: "A3" },
  { q: "connection pool database",    cId: "C3", bId: "B3", aId: "A3" },
  { q: "rate limit requests",         cId: "C4", bId: "B4", aId: "A4" },
  { q: "multi region failover backup", cId: "C5", bId: "B5", aId: "A5" },
  { q: "OAuth authorization flow",    cId: "C1", bId: "B1", aId: "A1" },
  { q: "GraphQL N+1 query",           cId: "C2", bId: "B2", aId: "A2" },
  { q: "bot protection spam",         cId: "C4", bId: "B4", aId: "A4" },
  { q: "security vulnerability password", cId: "C6", bId: "B9", aId: "A7" },
  { q: "high traffic throughput scaling", cId: "C3", bId: "B3", aId: "A3" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMetadata(sessionId: string, idx: number): DocumentMetadata {
  return {
    sessionId,
    project: "rrf-eval",
    role: "mixed",
    timestamp: Date.now() - idx * 60000, // spread timestamps
    toolNames: [],
    messageIndex: idx,
  };
}

function rankOf(docIds: string[], targetDocId: string): number | null {
  const idx = docIds.indexOf(targetDocId);
  return idx === -1 ? null : idx + 1; // 1-indexed
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║        RRF Fusion Eval — Strata Hybrid Search            ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`\nCurrent rrfK: ${CONFIG.search.rrfK}`);
  console.log(`Corpus: ${CORPUS.length} entries | Queries: ${QUERIES.length}\n`);

  // Open in-memory database
  const db = openDatabase(":memory:");
  const docStore = new SqliteDocumentStore(db);

  // Try to create embedding provider for hybrid search
  let embedder: EmbeddingProvider | null = null;
  let vectorStore: VectorStore | null = null;
  let hybridEngine: HybridSearchEngine | null = null;
  let isHybrid = false;

  try {
    embedder = createEmbeddingProvider();
    vectorStore = new VectorStore(db, embedder.dimensions, embedder.modelName);
    hybridEngine = new HybridSearchEngine(docStore, vectorStore, embedder);
    isHybrid = true;
    console.log(`✓ Hybrid search enabled (${embedder.modelName}, dim=${embedder.dimensions})`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`⚠ Semantic search unavailable: ${msg}`);
    console.log("  Running FTS5-only eval (semantic score points will be 0)\n");
  }

  // Seed corpus — track docId ↔ corpusId mapping
  const docIdMap = new Map<string, string>(); // corpusId → docId
  const docIdReverse = new Map<string, string>(); // docId → corpusId

  console.log("Seeding corpus...");
  for (let i = 0; i < CORPUS.length; i++) {
    const entry = CORPUS[i];
    const sessionId = `rrf-eval-${entry.id}`;
    const docId = await docStore.add(
      entry.text,
      Math.ceil(entry.text.length / 4),
      makeMetadata(sessionId, i)
    );
    docIdMap.set(entry.id, docId);
    docIdReverse.set(docId, entry.id);
  }
  console.log(`  Inserted ${CORPUS.length} documents into FTS5\n`);

  // Generate vector embeddings if hybrid search is available
  if (isHybrid && embedder && vectorStore) {
    console.log("Generating embeddings (this may take a moment)...");
    const texts = CORPUS.map(e => e.text);
    try {
      const embeddings = await embedder.embedBatch(texts, "RETRIEVAL_DOCUMENT");
      for (let i = 0; i < CORPUS.length; i++) {
        const docId = docIdMap.get(CORPUS[i].id)!;
        vectorStore.addVector(docId, embeddings[i]);
      }
      console.log(`  Generated ${embeddings.length} embeddings\n`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`  ⚠ Batch embedding failed: ${msg}`);
      console.log("  Trying one-by-one...");
      let successCount = 0;
      for (let i = 0; i < CORPUS.length; i++) {
        try {
          const vec = await embedder.embed(CORPUS[i].text, "RETRIEVAL_DOCUMENT");
          const docId = docIdMap.get(CORPUS[i].id)!;
          vectorStore.addVector(docId, vec);
          successCount++;
        } catch {
          // skip this entry
        }
      }
      if (successCount === 0) {
        console.log("  ⚠ All embeddings failed — falling back to FTS5 only\n");
        isHybrid = false;
      } else {
        console.log(`  Generated ${successCount}/${CORPUS.length} embeddings\n`);
      }
    }
  }

  // ── Run eval queries ────────────────────────────────────────────────────────

  const ftsEngine = new SqliteSearchEngine(docStore);

  let totalScore = 0;
  let maxScore = 0;
  const results: Array<{
    q: string;
    cScore: number; bScore: number; aScore: number;
    cRank: number | null; bRank: number | null; aRank: number | null;
    topDocIds: string[];
  }> = [];

  console.log("Running eval queries...\n");
  console.log("─".repeat(80));

  for (const spec of QUERIES) {
    // Determine max possible score for this query
    const possibleC = spec.cId !== null ? 1 : 0;
    const possibleB = spec.bId !== null ? 1 : 0;
    const possibleA = 1;
    maxScore += possibleC + possibleB + possibleA;

    let topDocIds: string[];

    if (isHybrid && hybridEngine) {
      const hybridResults = await hybridEngine.search(spec.q, { limit: 20 });
      topDocIds = hybridResults.map(r => {
        // Map sessionId back to docId via sessionId → corpusId
        const sessionId = r.sessionId;
        const corpusId = sessionId.replace("rrf-eval-", "");
        return docIdMap.get(corpusId) ?? "";
      }).filter(Boolean);
    } else {
      const ftsResults = await ftsEngine.search(spec.q, { limit: 20 });
      topDocIds = ftsResults.map(r => {
        // Find docId by matching sessionId pattern
        for (const [corpusId, docId] of docIdMap.entries()) {
          const sessionId = `rrf-eval-${corpusId}`;
          if (r.sessionId === sessionId) return docId;
        }
        return "";
      }).filter(Boolean);
    }

    // Score this query
    let cScore = 0, bScore = 0, aScore = 0;
    let cRank: number | null = null, bRank: number | null = null, aRank: number | null = null;

    if (spec.cId !== null) {
      const cDocId = docIdMap.get(spec.cId) ?? "";
      cRank = rankOf(topDocIds, cDocId);
      cScore = (cRank !== null && cRank <= 3) ? 1 : 0;
    }

    if (spec.bId !== null) {
      const bDocId = docIdMap.get(spec.bId) ?? "";
      bRank = rankOf(topDocIds, bDocId);
      bScore = (bRank !== null && bRank <= 5) ? 1 : 0;
    }

    const aDocId = docIdMap.get(spec.aId) ?? "";
    aRank = rankOf(topDocIds, aDocId);
    aScore = (aRank !== null && aRank <= 10) ? 1 : 0;

    const queryScore = cScore + bScore + aScore;
    totalScore += queryScore;

    results.push({ q: spec.q, cScore, bScore, aScore, cRank, bRank, aRank, topDocIds });

    // Print per-query breakdown
    const cLabel = spec.cId ? `${spec.cId}@${cRank ?? "—"}` : "n/a";
    const bLabel = spec.bId ? `${spec.bId}@${bRank ?? "—"}` : "n/a";
    const aLabel = `${spec.aId}@${aRank ?? "—"}`;

    console.log(`Q: "${spec.q}"`);
    console.log(
      `  C(top3): ${cScore ? "✓" : "✗"} ${cLabel}  ` +
      `B(top5): ${bScore ? "✓" : "✗"} ${bLabel}  ` +
      `A(top10): ${aScore ? "✓" : "✗"} ${aLabel}  ` +
      `→ ${queryScore}/${possibleC + possibleB + possibleA}pts`
    );

    // Show top 5 results with corpus labels
    const top5Labels = topDocIds.slice(0, 5).map((docId, i) => {
      const corpusId = docIdReverse.get(docId) ?? "?";
      return `${i + 1}.${corpusId}`;
    }).join(" ");
    console.log(`  Top5: ${top5Labels}`);
    console.log();
  }

  console.log("─".repeat(80));
  console.log(`\n▶ TOTAL SCORE: ${totalScore} / ${maxScore}`);
  console.log(`  Mode: ${isHybrid ? "hybrid (FTS5 + vector)" : "FTS5 only"}`);
  console.log(`  rrfK: ${CONFIG.search.rrfK}`);
  console.log(`  fetchLimit multiplier: 3x (limit*3)`);

  // Per-category breakdown
  const cTotal = results.reduce((s, r) => s + r.cScore, 0);
  const bTotal = results.reduce((s, r) => s + r.bScore, 0);
  const aTotal = results.reduce((s, r) => s + r.aScore, 0);
  const cMax = results.filter((_, i) => QUERIES[i].cId !== null).length;
  const bMax = results.filter((_, i) => QUERIES[i].bId !== null).length;
  const aMax = QUERIES.length;

  console.log(`\n  C (combined, top3): ${cTotal}/${cMax}`);
  console.log(`  B (keyword,  top5): ${bTotal}/${bMax}`);
  console.log(`  A (semantic, top10): ${aTotal}/${aMax}`);

  db.close();
  return totalScore;
}

main().then((score) => {
  process.exit(0);
}).catch((err) => {
  console.error("Eval failed:", err);
  process.exit(1);
});
