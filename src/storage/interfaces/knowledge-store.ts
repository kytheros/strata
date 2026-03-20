/**
 * IKnowledgeStore interface: async-first contract for knowledge entry persistence.
 *
 * Extracted from SqliteKnowledgeStore public methods. All return types are Promise<T>
 * so that both synchronous (SQLite) and asynchronous (D1) adapters can implement them.
 */

import type { KnowledgeEntry } from "../../knowledge/knowledge-store.js";

/** Partial update fields for a knowledge entry. */
export interface KnowledgeUpdatePatch {
  summary?: string;
  details?: string;
  tags?: string[];
  type?: KnowledgeEntry["type"];
}

/** A row from the knowledge_history table. */
export interface KnowledgeHistoryRow {
  id: number;
  entry_id: string;
  old_summary: string | null;
  new_summary: string | null;
  old_details: string | null;
  new_details: string | null;
  event: "add" | "update" | "delete";
  created_at: number;
}

/** Options for paginated knowledge listing. */
export interface KnowledgeListOptions {
  type?: string;
  project?: string;
  search?: string;
  sort?: "newest" | "oldest" | "importance";
  limit: number;
  offset: number;
}

export interface IKnowledgeStore {
  addEntry(entry: KnowledgeEntry): Promise<void>;
  upsertEntry(entry: KnowledgeEntry): Promise<void>;
  getEntry(id: string): Promise<KnowledgeEntry | undefined>;
  hasEntry(id: string): Promise<boolean>;
  search(query: string, project?: string, user?: string): Promise<KnowledgeEntry[]>;
  getProjectEntries(project: string, user?: string): Promise<KnowledgeEntry[]>;
  getByType(type: KnowledgeEntry["type"], project?: string, user?: string): Promise<KnowledgeEntry[]>;
  getGlobalLearnings(project?: string, user?: string): Promise<KnowledgeEntry[]>;
  updateEntry(id: string, patch: KnowledgeUpdatePatch): Promise<boolean>;
  deleteEntry(id: string): Promise<boolean>;
  removeEntry(id: string): Promise<void>;
  mergeProcedure(entry: KnowledgeEntry): Promise<void>;
  getHistory(entryId: string, limit?: number): Promise<KnowledgeHistoryRow[]>;
  getEntryCount(): Promise<number>;
  getAllEntries(user?: string): Promise<KnowledgeEntry[]>;
  getEntries(options: KnowledgeListOptions): Promise<{ entries: KnowledgeEntry[]; total: number }>;
  getTypeDistribution(project?: string): Promise<Record<string, number>>;
}
