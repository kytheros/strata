import type Database from "better-sqlite3";
import { CONFIG } from "../config.js";
import { resolveActiveEmbeddingModel } from "../extensions/embeddings/active-model.js";

export type CheckStatus = "ok" | "warn" | "err";

export interface HealthCheck {
  name: "embedding-coverage" | "summary-coverage" | "extraction-success" | "entity-quality" | "gap-close-rate";
  status: CheckStatus;
  value: number;
  detail: string;
}

export interface KnowledgeHealth {
  overall: { score: number; status: CheckStatus };
  checks: HealthCheck[];
}

function statusFor(value: number, ok: number, warn: number): CheckStatus {
  if (value >= ok) return "ok";
  if (value >= warn) return "warn";
  return "err";
}

function row1(db: Database.Database, sql: string): number {
  const r = db.prepare(sql).get() as { c: number } | undefined;
  return r?.c ?? 0;
}

function embeddingCoverage(db: Database.Database): HealthCheck {
  const total = row1(db, "SELECT COUNT(*) AS c FROM knowledge");
  // Scope to the active model so switching providers shows the real coverage gap.
  // Use a parameterized query to avoid SQL injection via model name.
  const activeModel = resolveActiveEmbeddingModel().model;
  const withEmbRow = db
    .prepare("SELECT COUNT(*) AS c FROM knowledge WHERE id IN (SELECT entry_id FROM embeddings WHERE model = ?)")
    .get(activeModel) as { c: number } | undefined;
  const withEmb = withEmbRow?.c ?? 0;
  const value = total === 0 ? 1 : withEmb / total;
  const { ok, warn } = CONFIG.health.thresholds.embedding_coverage;
  return {
    name: "embedding-coverage",
    status: statusFor(value, ok, warn),
    value,
    detail: total === 0 ? "no knowledge entries" : `${withEmb} of ${total} entries vectorized (${(value * 100).toFixed(0)}%)`,
  };
}

function summaryCoverage(db: Database.Database): HealthCheck {
  const sessionsWithKnowledge = row1(db, "SELECT COUNT(DISTINCT session_id) AS c FROM knowledge WHERE session_id IS NOT NULL AND session_id != ''");
  const summarized = row1(db, "SELECT COUNT(*) AS c FROM summaries");
  const value = sessionsWithKnowledge === 0 ? 1 : summarized / sessionsWithKnowledge;
  const { ok, warn } = CONFIG.health.thresholds.summary_coverage;
  return {
    name: "summary-coverage",
    status: statusFor(value, ok, warn),
    value,
    detail: sessionsWithKnowledge === 0 ? "no sessions with knowledge" : `${summarized} of ${sessionsWithKnowledge} sessions summarized (${(value * 100).toFixed(0)}%)`,
  };
}

function extractionSuccess(db: Database.Database): HealthCheck {
  const sessionsWithMessages = row1(db, "SELECT COUNT(DISTINCT session_id) AS c FROM documents WHERE session_id IS NOT NULL AND session_id != ''");
  const sessionsWithKnowledge = row1(db, "SELECT COUNT(DISTINCT session_id) AS c FROM knowledge WHERE session_id IS NOT NULL AND session_id != ''");
  const sessionsFailed = Math.max(0, sessionsWithMessages - sessionsWithKnowledge);
  const value = sessionsWithMessages === 0 ? 1 : 1 - (sessionsFailed / sessionsWithMessages);
  const { ok, warn } = CONFIG.health.thresholds.extraction_success;
  return {
    name: "extraction-success",
    status: statusFor(value, ok, warn),
    value,
    detail: sessionsWithMessages === 0 ? "no sessions" : `${sessionsFailed} of ${sessionsWithMessages} sessions had messages but produced 0 knowledge`,
  };
}

function entityQuality(db: Database.Database): HealthCheck {
  const total = row1(db, "SELECT COUNT(*) AS c FROM entities");
  const noisy = row1(db, "SELECT COUNT(*) AS c FROM entities WHERE mention_count = 1");
  const value = total === 0 ? 1 : 1 - (noisy / total);
  const { ok, warn } = CONFIG.health.thresholds.entity_quality;
  return {
    name: "entity-quality",
    status: statusFor(value, ok, warn),
    value,
    detail: total === 0 ? "no entities" : `${noisy} of ${total} entities have only 1 mention (likely noise)`,
  };
}

function gapCloseRate(db: Database.Database): HealthCheck {
  const since = Date.now() - 30 * 86400 * 1000;
  const occurred = row1(db, `SELECT COUNT(*) AS c FROM evidence_gaps WHERE occurred_at >= ${since}`);
  const resolved = row1(db, `SELECT COUNT(*) AS c FROM evidence_gaps WHERE occurred_at >= ${since} AND resolved_at IS NOT NULL`);
  const value = occurred === 0 ? 1 : resolved / occurred;
  const { ok, warn } = CONFIG.health.thresholds.gap_close_rate;
  return {
    name: "gap-close-rate",
    status: statusFor(value, ok, warn),
    value,
    detail: occurred === 0 ? "no gaps in last 30d" : `${resolved} of ${occurred} gaps resolved within 30d`,
  };
}

export function deriveHealth(db: Database.Database): KnowledgeHealth {
  const checks: HealthCheck[] = [
    embeddingCoverage(db),
    summaryCoverage(db),
    extractionSuccess(db),
    entityQuality(db),
    gapCloseRate(db),
  ];
  const meanValue = checks.reduce((s, c) => s + c.value, 0) / checks.length;
  const score = Math.round(meanValue * 100);
  const status: CheckStatus = checks.some(c => c.status === "err") ? "err"
                            : checks.some(c => c.status === "warn") ? "warn"
                            : "ok";
  return { overall: { score, status }, checks };
}
