/**
 * Storage interfaces barrel export.
 *
 * Re-exports all store interfaces, associated types, and the composite StorageContext.
 */

// -- Interfaces --
export type { IKnowledgeStore } from "./knowledge-store.js";
export type { IDocumentStore } from "./document-store.js";
export type { IEntityStore } from "./entity-store.js";
export type { ISummaryStore } from "./summary-store.js";
export type { IMetaStore } from "./meta-store.js";
export type { IEventStore, SVOEvent } from "./event-store.js";
export type { ITrainingStore } from "./training-store.js";
export type { IEvidenceGapStore } from "./evidence-gap-store.js";
export type { IQuantizationStore, QuantizationMigrationState, EmbeddingRowForMigration } from "./quantization-store.js";

// -- Types used by interfaces --
export type { KnowledgeUpdatePatch, KnowledgeHistoryRow, KnowledgeListOptions } from "./knowledge-store.js";
export type { FtsSearchResult } from "./document-store.js";
export type { EntityRow, EntityInput, EntityRelationRow, RelationInput, EntityListOptions, EntityGraph } from "./entity-store.js";
export type { SessionListOptions } from "./summary-store.js";

// -- Composite context --
import type { IKnowledgeStore } from "./knowledge-store.js";
import type { IDocumentStore } from "./document-store.js";
import type { IEntityStore } from "./entity-store.js";
import type { ISummaryStore } from "./summary-store.js";
import type { IMetaStore } from "./meta-store.js";
import type { GeminiEmbedder } from "../../extensions/embeddings/gemini-embedder.js";

/**
 * StorageContext bundles all five store interfaces into a single object
 * that can be passed to createServer() and tool handlers.
 */
export interface StorageContext {
  knowledge: IKnowledgeStore;
  documents: IDocumentStore;
  entities: IEntityStore;
  summaries: ISummaryStore;
  meta: IMetaStore;
  close(): Promise<void>;
}

/** Options for the storage factory. */
export interface StorageOptions {
  adapter: "sqlite" | "d1" | "pg";

  // SQLite-specific
  dbPath?: string;

  // D1-specific
  d1Binding?: unknown; // D1Database type from @cloudflare/workers-types
  userId?: string; // Row-scoping key for multi-tenant D1 and Postgres

  // Postgres-specific
  pgConnectionString?: string;
  pgMaxConnections?: number;

  // Shared
  embedder?: GeminiEmbedder | null;
}
