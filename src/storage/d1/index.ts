/**
 * D1 storage factory.
 *
 * Creates a StorageContext backed by Cloudflare D1. This is the alternative
 * storage backend for Cloudflare Workers deployments.
 *
 * SECURITY: In production, always configure authentication before exposing
 * the MCP server over HTTP. Set the MCP_GATEWAY_TOKEN environment variable
 * and validate it in your Worker's fetch handler before routing to the MCP
 * transport. Without auth, any client can read/write any user's data.
 *
 * Usage:
 *   import { createD1Storage } from "strata-mcp/d1";
 *   const storage = await createD1Storage({ d1: env.STRATA_DB, userId: "user-123" });
 */

import type { StorageContext, StorageOptions } from "../interfaces/index.js";
import type { D1Database } from "./d1-types.js";
import { D1_SCHEMA, D1_SCHEMA_VERSION } from "./schema.js";
import { D1KnowledgeStore } from "./d1-knowledge-store.js";
import { D1DocumentStore } from "./d1-document-store.js";
import { D1EntityStore } from "./d1-entity-store.js";
import { D1SummaryStore } from "./d1-summary-store.js";
import { D1MetaStore } from "./d1-meta-store.js";

/** Options for creating a D1-backed StorageContext. */
export interface D1StorageOptions {
  d1: D1Database;
  userId: string;
  embedder?: { embed(text: string, taskType: string): Promise<Float32Array> } | null;
}

/**
 * Create a StorageContext backed by Cloudflare D1.
 *
 * Accepts either D1StorageOptions directly or a StorageOptions from the factory.
 * Initializes the schema if needed (checks index_meta for schema version),
 * then constructs all 5 D1 store classes.
 */
export async function createD1Storage(options: D1StorageOptions | StorageOptions): Promise<StorageContext> {
  let db: D1Database;
  let userId: string;
  let embedder: { embed(text: string, taskType: string): Promise<Float32Array> } | null | undefined;

  if ("d1" in options) {
    // Direct D1StorageOptions
    db = options.d1;
    userId = options.userId;
    embedder = options.embedder;
  } else {
    // StorageOptions from factory
    if (!options.d1Binding) {
      throw new Error("D1 adapter requires a d1Binding (D1Database instance) in StorageOptions.");
    }
    db = options.d1Binding as D1Database;
    userId = options.userId ?? "default";
    embedder = options.embedder;
  }

  // Initialize schema if needed
  await initD1Schema(db);

  const meta = new D1MetaStore(db);

  return {
    knowledge: new D1KnowledgeStore(db, userId, embedder),
    documents: new D1DocumentStore(db, userId),
    entities: new D1EntityStore(db, userId),
    summaries: new D1SummaryStore(db, userId),
    meta,
    close: async () => {
      // D1 bindings are managed by the Workers runtime — no explicit close needed.
    },
  };
}

/**
 * Initialize the D1 schema if it hasn't been applied yet.
 * Checks the index_meta table for a schema_version key.
 */
async function initD1Schema(db: D1Database): Promise<void> {
  try {
    const versionRow = await db
      .prepare("SELECT value FROM index_meta WHERE key = 'schema_version'")
      .first<{ value: string }>();

    if (versionRow && versionRow.value === D1_SCHEMA_VERSION) {
      return; // Schema is up to date
    }
  } catch {
    // Table doesn't exist yet — proceed with schema creation
  }

  // D1's exec() can fail on multi-line statements and SQL comments.
  // Split the schema into individual statements and execute each via
  // prepare().run() for maximum compatibility across D1 implementations.
  const statements = splitSchemaStatements(D1_SCHEMA);
  for (const stmt of statements) {
    await db.exec(stmt);
  }

  // Record the schema version
  await db
    .prepare("INSERT OR REPLACE INTO index_meta (key, value) VALUES ('schema_version', ?)")
    .bind(D1_SCHEMA_VERSION)
    .run();
}

/**
 * Split a multi-statement SQL string into individual executable statements.
 * Strips SQL line comments (--) and handles BEGIN...END blocks in triggers
 * (which contain internal semicolons that are not statement terminators).
 * Each returned string is a complete, single statement ready for exec().
 */
function splitSchemaStatements(schema: string): string[] {
  // Remove line comments
  const noComments = schema
    .split("\n")
    .map((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("--")) return "";
      const commentIdx = line.indexOf("--");
      if (commentIdx > 0) return line.slice(0, commentIdx);
      return line;
    })
    .join(" ");

  // Parse into statements, respecting BEGIN...END trigger blocks
  const statements: string[] = [];
  let current = "";
  let depth = 0; // Track BEGIN...END nesting

  // Tokenize by splitting on word boundaries around BEGIN/END and semicolons
  const tokens = noComments.split(/(\bBEGIN\b|\bEND\b|;)/i);

  for (const token of tokens) {
    const upper = token.trim().toUpperCase();

    if (upper === "BEGIN") {
      depth++;
      current += token;
    } else if (upper === "END") {
      depth--;
      current += token;
    } else if (token === ";") {
      current += ";";
      if (depth <= 0) {
        const trimmed = current.replace(/\s+/g, " ").trim();
        if (trimmed.length > 1) { // More than just ";"
          statements.push(trimmed);
        }
        current = "";
        depth = 0;
      }
    } else {
      current += token;
    }
  }

  // Handle any trailing statement without semicolon
  const trailing = current.replace(/\s+/g, " ").trim();
  if (trailing.length > 0) {
    statements.push(trailing.endsWith(";") ? trailing : trailing + ";");
  }

  return statements;
}

// Re-export types for consumer convenience
export type { D1Database, D1PreparedStatement, D1Result } from "./d1-types.js";
export { D1VectorSearch } from "./d1-vector-search.js";
export type { D1VectorSearchResult } from "./d1-vector-search.js";
