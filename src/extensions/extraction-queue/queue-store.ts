import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { EventEmitter } from "events";

export interface EnqueueInput {
  tenantId: string;
  agentId: string;
  memoryId: string;
  text: string;
  userTags: string[];
  importance?: number;
}

export interface Job extends EnqueueInput {
  id: string;
  status: "pending" | "running" | "completed" | "failed";
  attempts: number;
  lastError: string | null;
  createdAt: number;
  claimedAt: number | null;
  completedAt: number | null;
  nextAttemptAt: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS extraction_jobs (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  memory_id       TEXT NOT NULL,
  text            TEXT NOT NULL,
  user_tags       TEXT NOT NULL,
  importance      INTEGER,
  status          TEXT NOT NULL DEFAULT 'pending',
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  claimed_at      INTEGER,
  completed_at    INTEGER,
  next_attempt_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_extraction_jobs_claim
  ON extraction_jobs(status, next_attempt_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_extraction_jobs_orphan
  ON extraction_jobs(status, claimed_at)
  WHERE status = 'running';
`;

interface Row {
  id: string;
  tenant_id: string;
  agent_id: string;
  memory_id: string;
  text: string;
  user_tags: string;
  importance: number | null;
  status: Job["status"];
  attempts: number;
  last_error: string | null;
  created_at: number;
  claimed_at: number | null;
  completed_at: number | null;
  next_attempt_at: number;
}

function rowToJob(r: Row): Job {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    agentId: r.agent_id,
    memoryId: r.memory_id,
    text: r.text,
    userTags: JSON.parse(r.user_tags) as string[],
    importance: r.importance ?? undefined,
    status: r.status,
    attempts: r.attempts,
    lastError: r.last_error,
    createdAt: r.created_at,
    claimedAt: r.claimed_at,
    completedAt: r.completed_at,
    nextAttemptAt: r.next_attempt_at,
  };
}

export class ExtractionQueueStore extends EventEmitter {
  private db: Database.Database;

  constructor(dbPath: string) {
    super();
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(SCHEMA);
  }

  enqueue(input: EnqueueInput): string {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO extraction_jobs
          (id, tenant_id, agent_id, memory_id, text, user_tags, importance,
           status, attempts, created_at, next_attempt_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, 0)`,
      )
      .run(
        id,
        input.tenantId,
        input.agentId,
        input.memoryId,
        input.text,
        JSON.stringify(input.userTags),
        input.importance ?? null,
        now,
      );
    this.emit("enqueue");
    return id;
  }

  claimNext(now: number): Job | null {
    const row = this.db
      .prepare(
        `UPDATE extraction_jobs
         SET status = 'running', claimed_at = ?, attempts = attempts + 1
         WHERE id = (
           SELECT id FROM extraction_jobs
           WHERE status = 'pending' AND next_attempt_at <= ?
           ORDER BY created_at ASC
           LIMIT 1
         )
         RETURNING *`,
      )
      .get(now, now) as Row | undefined;
    return row ? rowToJob(row) : null;
  }

  markCompleted(id: string, now: number): void {
    this.db
      .prepare(
        `UPDATE extraction_jobs
         SET status = 'completed', completed_at = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(now, id);
  }

  markRetry(id: string, err: string, nextAt: number): void {
    const truncated = err.length > 500 ? err.slice(0, 500) : err;
    this.db
      .prepare(
        `UPDATE extraction_jobs
         SET status = 'pending', last_error = ?, next_attempt_at = ?, claimed_at = NULL
         WHERE id = ? AND status = 'running'`,
      )
      .run(truncated, nextAt, id);
  }

  markFailed(id: string, err: string, now: number): void {
    const truncated = err.length > 500 ? err.slice(0, 500) : err;
    this.db
      .prepare(
        `UPDATE extraction_jobs
         SET status = 'failed', last_error = ?, completed_at = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(truncated, now, id);
  }

  recoverOrphaned(now: number): number {
    const cutoff = now - 5 * 60_000;
    const result = this.db
      .prepare(
        `UPDATE extraction_jobs
         SET status = 'pending', claimed_at = NULL, next_attempt_at = ?
         WHERE status = 'running' AND claimed_at IS NOT NULL AND claimed_at < ?`,
      )
      .run(now, cutoff);
    return result.changes;
  }

  close(): void {
    this.removeAllListeners();
    this.db.close();
  }
}
