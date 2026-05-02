/**
 * IKnowledgeTurnStore — interface for the `knowledge_turns` table.
 *
 * Stores raw conversation turns verbatim with FTS5 indexing. Used by the
 * Community-surface TIR (Turn Isolation Retrieval) lane. Distinct from
 * `knowledge` entries, which store extraction-derived atomic facts.
 *
 * Mirrors `NpcTurnStore` (src/transports/npc-turn-store.ts) but replaces
 * `npc_id` / `player_id` with `project` + `user_id` for multi-tenant
 * Community scoping.
 *
 * Spec: 2026-05-01-tirqdp-community-port-design.md
 * Ticket: TIRQDP-1.2
 */

/** Input shape for inserting a single turn. */
export interface KnowledgeTurnInput {
  sessionId: string;
  project?: string | null;
  userId?: string | null;
  speaker: string;           // 'user' | 'assistant' | 'system'
  content: string;           // raw turn text, verbatim
  messageIndex: number;      // ordinal within session (for ±1 expansion)
}

/** A persisted row from the `knowledge_turns` table. */
export interface KnowledgeTurnRow {
  turnId: string;
  sessionId: string;
  project: string | null;
  userId: string | null;
  speaker: string;
  content: string;
  messageIndex: number;
  createdAt: number;          // epoch ms
}

/** A search hit: the row plus its negated BM25 score (higher = more relevant). */
export interface KnowledgeTurnHit {
  row: KnowledgeTurnRow;
  score: number;              // negated FTS5 BM25: higher = more relevant
}

/** Options for `searchByQuery`. */
export interface KnowledgeTurnSearchOptions {
  /** Restrict to this user. Pass null to match rows where user_id IS NULL. */
  userId: string | null | undefined;
  /** Optional project filter; omit to search across all projects for this user. */
  project?: string | null;
  /** Maximum number of results to return. */
  limit: number;
}

export interface IKnowledgeTurnStore {
  /**
   * Insert a single turn. Returns the generated turn_id UUID.
   */
  insert(turn: KnowledgeTurnInput): Promise<string>;

  /**
   * Insert multiple turns atomically (single transaction).
   * Returns the generated turn_id UUIDs in insertion order.
   */
  bulkInsert(turns: KnowledgeTurnInput[]): Promise<string[]>;

  /**
   * FTS5 search scoped by user_id (and optionally project).
   * Returns rows ordered by relevance descending (higher score = better match).
   */
  searchByQuery(query: string, opts: KnowledgeTurnSearchOptions): Promise<KnowledgeTurnHit[]>;

  /**
   * Retrieve all turns for a session, ordered by message_index ASC.
   */
  getBySessionId(sessionId: string): Promise<KnowledgeTurnRow[]>;

  /**
   * Delete all turns belonging to a session.
   * The FTS5 delete trigger keeps `knowledge_turns_fts` consistent.
   */
  deleteBySessionId(sessionId: string): Promise<void>;

  /**
   * Total count of all turns in the store (across all users/projects).
   */
  count(): Promise<number>;
}
