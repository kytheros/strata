/**
 * Search Retrieval Eval Script
 *
 * Seeds a temporary in-memory SQLite database with 30 corpus entries,
 * runs 30 queries, and scores each query (1 if expected session in top 3, else 0).
 *
 * FROZEN: Do not modify this file or the corpus/queries it encodes.
 * Run with: npx tsx autoresearch/search-retrieval/run-eval.ts
 */

import Database from "better-sqlite3";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteDocumentStore } from "../../src/storage/sqlite-document-store.js";
import { SqliteSearchEngine } from "../../src/search/sqlite-search-engine.js";
import { computeImportance } from "../../src/knowledge/importance.js";

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

interface CorpusEntry {
  sessionId: string;
  text: string;
  role: "user" | "assistant" | "mixed";
  ageDays: number;
}

const CORPUS: CorpusEntry[] = [
  // Error Fixes
  {
    sessionId: "fix-ts-strict",
    text: "Fixed TypeScript strict null check error by adding optional chaining to the property access expression",
    role: "assistant",
    ageDays: 2,
  },
  {
    sessionId: "fix-react-hook",
    text: "Fixed React hook ordering error by moving the useState call inside the component function body",
    role: "assistant",
    ageDays: 5,
  },
  {
    sessionId: "fix-cors-express",
    text: "Fixed CORS error in Express API by adding Access-Control-Allow-Origin header to the response middleware",
    role: "assistant",
    ageDays: 8,
  },
  {
    sessionId: "fix-docker-port",
    text: "Fixed Docker port conflict by updating the host port binding from 3000 to 8080 in the docker-compose file",
    role: "assistant",
    ageDays: 15,
  },
  {
    sessionId: "fix-postgres-conn",
    text: "Fixed PostgreSQL database connection refused error by updating the host address from 127.0.0.1 to localhost",
    role: "assistant",
    ageDays: 25,
  },

  // Decisions
  {
    sessionId: "dec-postgres-mongo",
    text: "Decided to use PostgreSQL over MongoDB as the main database for the billing service because it handles ACID transactions better",
    role: "user",
    ageDays: 45,
  },
  {
    sessionId: "dec-react-vue",
    text: "Decided to use React instead of Vue for the frontend application because React has better TypeScript support and ecosystem",
    role: "user",
    ageDays: 60,
  },
  {
    sessionId: "dec-supabase-auth",
    text: "Decided to use Supabase for authentication instead of building our own custom JWT authentication service from scratch",
    role: "user",
    ageDays: 75,
  },
  {
    sessionId: "dec-cloudflare-aws",
    text: "Decided to deploy on Cloudflare Workers instead of AWS Lambda because Cloudflare eliminates cold start latency completely",
    role: "user",
    ageDays: 100,
  },
  {
    sessionId: "dec-vitest-jest",
    text: "Decided to replace Jest with Vitest for all unit testing because Vitest has native ESM support and runs significantly faster",
    role: "user",
    ageDays: 120,
  },

  // Solutions
  {
    sessionId: "sol-docker-network",
    text: "Resolved Docker container networking issue by switching the network mode from bridge to host in the configuration",
    role: "assistant",
    ageDays: 3,
  },
  {
    sessionId: "sol-memory-leak",
    text: "Resolved memory leak in Node.js server by removing the uncleaned setInterval timer from the event emitter registration",
    role: "assistant",
    ageDays: 10,
  },
  {
    sessionId: "sol-slow-query",
    text: "Resolved slow database query performance by adding a composite index on user_id and created_at in PostgreSQL",
    role: "assistant",
    ageDays: 20,
  },
  {
    sessionId: "sol-ts-build",
    text: "Resolved TypeScript build failure by setting moduleResolution to bundler and enabling isolatedModules in tsconfig.json",
    role: "assistant",
    ageDays: 50,
  },
  {
    sessionId: "sol-pipeline",
    text: "Resolved GitHub Actions deployment pipeline failure by upgrading the Node.js runtime version from 16 to 20 in workflow file",
    role: "assistant",
    ageDays: 80,
  },

  // Learnings
  {
    sessionId: "learn-useeffect",
    text: "React useEffect cleanup functions must return void not a Promise otherwise the component will have a memory leak",
    role: "user",
    ageDays: 30,
  },
  {
    sessionId: "learn-async",
    text: "Async functions in JavaScript always return a Promise wrapping the return value even if the function appears synchronous",
    role: "user",
    ageDays: 45,
  },
  {
    sessionId: "learn-sqlite-wal",
    text: "SQLite WAL journal mode enables concurrent reads without blocking write operations making it ideal for multi-process access",
    role: "user",
    ageDays: 90,
  },
  {
    sessionId: "learn-jwt",
    text: "JWT tokens must validate the expiry claim and verify the signature on every single request to prevent authentication bypass attacks",
    role: "user",
    ageDays: 7,
  },
  {
    sessionId: "learn-docker-multi",
    text: "Docker multi-stage builds reduce the final image size by copying only the compiled build artifacts without dev dependencies",
    role: "user",
    ageDays: 130,
  },

  // Patterns
  {
    sessionId: "pat-auth-jwt",
    text: "Authentication failures in this codebase typically come from expired JWT tokens or misconfigured authorization header parsing",
    role: "assistant",
    ageDays: 4,
  },
  {
    sessionId: "pat-db-pool",
    text: "Database connection errors in this project are usually caused by missing connection pool limits or incorrect pool configuration",
    role: "assistant",
    ageDays: 35,
  },
  {
    sessionId: "pat-ts-types",
    text: "TypeScript compilation errors commonly originate from incorrect type definitions in the shared types directory",
    role: "assistant",
    ageDays: 65,
  },
  {
    sessionId: "pat-flaky-tests",
    text: "Test failures that appear intermittently are usually caused by async timing issues or shared state between test cases",
    role: "assistant",
    ageDays: 110,
  },
  {
    sessionId: "pat-deploy-secrets",
    text: "Deployment failures in production typically occur because environment variables or secrets are not configured correctly",
    role: "assistant",
    ageDays: 150,
  },

  // General
  {
    sessionId: "gen-auth-refactor",
    text: "Refactored the authentication middleware to extract shared validation logic into a reusable utility function for the API",
    role: "mixed",
    ageDays: 6,
  },
  {
    sessionId: "gen-rate-limit",
    text: "Added rate limiting to the REST API endpoints using express-rate-limit middleware to prevent excessive request abuse",
    role: "mixed",
    ageDays: 18,
  },
  {
    sessionId: "gen-test-coverage",
    text: "Updated test configuration to enable vitest coverage reporting using Istanbul provider for accurate branch and line coverage metrics",
    role: "mixed",
    ageDays: 40,
  },
  {
    sessionId: "gen-startup-perf",
    text: "Profiled the application startup performance and removed blocking synchronous file read operations to reduce initialization time",
    role: "mixed",
    ageDays: 85,
  },
  {
    sessionId: "gen-jsdoc",
    text: "Added JSDoc documentation comments to all exported public API functions to improve IDE autocomplete and developer experience",
    role: "mixed",
    ageDays: 160,
  },
];

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

interface EvalQuery {
  query: string;
  expectedSession: string;
  category: "direct" | "solution" | "ranking";
  notes: string;
}

const EVAL_QUERIES: EvalQuery[] = [
  // Direct keyword matches
  { query: "TypeScript strict null optional chaining", expectedSession: "fix-ts-strict", category: "direct", notes: "All terms in entry" },
  { query: "PostgreSQL MongoDB ACID transactions billing", expectedSession: "dec-postgres-mongo", category: "direct", notes: "All terms in entry" },
  { query: "Docker bridge host network switching mode", expectedSession: "sol-docker-network", category: "direct", notes: "All terms in entry" },
  { query: "React useEffect void Promise memory leak", expectedSession: "learn-useeffect", category: "direct", notes: "All terms in entry" },
  { query: "JWT expiry claim signature authentication bypass", expectedSession: "learn-jwt", category: "direct", notes: "All terms in entry" },
  { query: "CORS Access Control Allow Origin middleware Express", expectedSession: "fix-cors-express", category: "direct", notes: "Hyphens stripped by sanitizer" },
  { query: "Cloudflare Workers cold start latency", expectedSession: "dec-cloudflare-aws", category: "direct", notes: "All terms in entry" },
  { query: "Vitest Jest ESM unit testing", expectedSession: "dec-vitest-jest", category: "direct", notes: "All terms in entry" },
  { query: "composite index user_id PostgreSQL", expectedSession: "sol-slow-query", category: "direct", notes: "Underscore → space via sanitizer" },
  { query: "GitHub Actions Node.js runtime version workflow", expectedSession: "sol-pipeline", category: "direct", notes: "Period stripped → 'Node js'" },

  // Solution-seeking
  { query: "JWT expired token authorization header", expectedSession: "pat-auth-jwt", category: "solution", notes: "'expired JWT tokens or...authorization header'" },
  { query: "React useState component function hook", expectedSession: "fix-react-hook", category: "solution", notes: "'useState call inside the component function'" },
  { query: "memory leak setInterval Node.js event emitter", expectedSession: "sol-memory-leak", category: "solution", notes: "All terms in entry" },
  { query: "database connection pool configuration limit", expectedSession: "pat-db-pool", category: "solution", notes: "'connection pool limits or incorrect pool configuration'" },
  { query: "TypeScript type definitions shared directory", expectedSession: "pat-ts-types", category: "solution", notes: "'type definitions in the shared types directory'" },
  { query: "Docker container networking configuration bridge", expectedSession: "sol-docker-network", category: "solution", notes: "All terms in entry" },
  { query: "deployment production environment variables secrets", expectedSession: "pat-deploy-secrets", category: "solution", notes: "All terms in entry" },
  { query: "PostgreSQL database connection refused localhost", expectedSession: "fix-postgres-conn", category: "solution", notes: "All terms in entry" },
  { query: "Docker port host binding docker-compose", expectedSession: "fix-docker-port", category: "solution", notes: "'host port binding...docker-compose file'" },
  { query: "async timing test failure shared state", expectedSession: "pat-flaky-tests", category: "solution", notes: "'async timing issues or shared state between test'" },

  // Ranking challenges
  { query: "error", expectedSession: "fix-ts-strict", category: "ranking", notes: "6 entries match; recency should rank 2-day-old entry first" },
  { query: "database", expectedSession: "dec-postgres-mongo", category: "ranking", notes: "5 entries match; importance must overcome recency bias for 45-day-old decision" },
  { query: "React", expectedSession: "learn-useeffect", category: "ranking", notes: "3 entries match; importance should rank learning above fix" },
  { query: "TypeScript", expectedSession: "fix-ts-strict", category: "ranking", notes: "4 entries match; recency should rank 2-day-old fix first" },
  { query: "Docker", expectedSession: "sol-docker-network", category: "ranking", notes: "3 entries match; 3-day recency should rank it first" },
  { query: "login authentication", expectedSession: "dec-supabase-auth", category: "ranking", notes: "SEMANTIC GAP: 'login' not in entry → FTS returns 0 results" },
  { query: "code coverage", expectedSession: "gen-test-coverage", category: "ranking", notes: "SEMANTIC GAP: 'code' not in entry" },
  { query: "UI framework", expectedSession: "dec-react-vue", category: "ranking", notes: "SEMANTIC GAP: 'UI' not in entry" },
  { query: "request throttle", expectedSession: "gen-rate-limit", category: "ranking", notes: "SEMANTIC GAP: 'throttle' not in entry" },
  { query: "startup slow", expectedSession: "gen-startup-perf", category: "ranking", notes: "SEMANTIC GAP: 'slow' not in entry" },
];

// ---------------------------------------------------------------------------
// Infrastructure
// ---------------------------------------------------------------------------

async function seedDatabase(
  db: Database.Database,
  store: SqliteDocumentStore
): Promise<void> {
  const now = Date.now();
  const MS_PER_DAY = 86_400_000;

  for (let i = 0; i < CORPUS.length; i++) {
    const entry = CORPUS[i];
    const timestamp = now - entry.ageDays * MS_PER_DAY;

    const id = await store.add(
      entry.text,
      entry.text.split(/\s+/).length,
      {
        sessionId: entry.sessionId,
        project: "strata",
        role: entry.role,
        timestamp,
        toolNames: ["claude-code"],
        messageIndex: i,
      }
    );

    // Pre-compute and store importance
    const importance = computeImportance({
      text: entry.text,
      role: entry.role,
      sessionId: entry.sessionId,
    });
    db.prepare("UPDATE documents SET importance = ? WHERE id = ?").run(importance, id);
  }
}

async function findRank(
  engine: SqliteSearchEngine,
  query: string,
  expectedSession: string
): Promise<number> {
  const results = await engine.search(query, { limit: 50 });
  for (let i = 0; i < results.length; i++) {
    if (results[i].sessionId === expectedSession) {
      return i + 1; // 1-based
    }
  }
  return 0; // not found
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface QueryResult {
  index: number;
  query: string;
  expectedSession: string;
  category: string;
  notes: string;
  rank: number;
  inTop3: boolean;
}

export async function runEval(): Promise<{ score: number; total: number; results: QueryResult[] }> {
  const db = openDatabase(":memory:");
  const store = new SqliteDocumentStore(db);
  const engine = new SqliteSearchEngine(store);

  await seedDatabase(db, store);

  const results: QueryResult[] = [];

  for (let i = 0; i < EVAL_QUERIES.length; i++) {
    const q = EVAL_QUERIES[i];
    const rank = await findRank(engine, q.query, q.expectedSession);
    results.push({
      index: i + 1,
      query: q.query,
      expectedSession: q.expectedSession,
      category: q.category,
      notes: q.notes,
      rank,
      inTop3: rank > 0 && rank <= 3,
    });
  }

  db.close();

  const score = results.filter((r) => r.inTop3).length;
  return { score, total: EVAL_QUERIES.length, results };
}

// Run if executed directly
const { score, total, results } = await runEval();

console.log(`\n=== Search Retrieval Eval Results ===`);
console.log(`Score: ${score}/${total}\n`);

// Summary by category
const categories = ["direct", "solution", "ranking"] as const;
for (const cat of categories) {
  const catResults = results.filter((r) => r.category === cat);
  const catScore = catResults.filter((r) => r.inTop3).length;
  console.log(`${cat.padEnd(10)}: ${catScore}/${catResults.length}`);
}

console.log("\n--- Per-Query Results ---");
console.log("# | Query | Expected | Rank | Pass?");
console.log("--|-------|----------|------|------");
for (const r of results) {
  const pass = r.inTop3 ? "✅" : "❌";
  const rankStr = r.rank === 0 ? "NOT FOUND" : `#${r.rank}`;
  const queryShort = r.query.length > 40 ? r.query.slice(0, 37) + "..." : r.query;
  console.log(`${String(r.index).padStart(2)} | ${queryShort.padEnd(41)} | ${r.expectedSession.padEnd(20)} | ${rankStr.padEnd(9)} | ${pass}`);
}

console.log(`\nFinal Score: ${score}/${total}`);
