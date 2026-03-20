/**
 * ISummaryStore interface: async-first contract for session summary persistence.
 *
 * Extracted from SqliteSummaryStore public methods. All return types are Promise<T>
 * so that both synchronous (SQLite) and asynchronous (D1) adapters can implement them.
 */

import type { SessionSummary } from "../../knowledge/session-summarizer.js";

/** Options for paginated session listing. */
export interface SessionListOptions {
  project?: string;
  tool?: string;
  hasCodeChanges?: boolean;
  limit: number;
  offset: number;
}

export interface ISummaryStore {
  save(summary: SessionSummary, tool?: string): Promise<void>;
  get(sessionId: string): Promise<SessionSummary | null>;
  getByProject(project: string): Promise<SessionSummary[]>;
  getByTool(tool: string): Promise<SessionSummary[]>;
  getRecent(limit?: number): Promise<SessionSummary[]>;
  getAll(): Promise<SessionSummary[]>;
  remove(sessionId: string): Promise<void>;
  getCount(): Promise<number>;
  getSessions(options: SessionListOptions): Promise<{ sessions: SessionSummary[]; total: number }>;
  getSessionHeatmap(sinceMs: number): Promise<Array<{ date: string; count: number }>>;
  getProjectSessionCounts(): Promise<Record<string, number>>;
}
