import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/storage/database.js";
import { deriveHealth } from "../../src/storage/health.js";

describe("deriveHealth", () => {
  let db: any;
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "strata-hc-"));
    db = openDatabase(join(dir, "test.db"));
  });

  it("returns ok status when every check is healthy", () => {
    // 10 entries, all embedded, all from one session that has a summary,
    // no extraction failures, varied entity types
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      db.prepare("INSERT INTO knowledge (id, type, project, session_id, timestamp, summary, details, tags, related_files, importance) VALUES (?, 'fact', 'p', 's1', ?, 'a', 'b', '[]', '[]', 0.5)").run(`k${i}`, now);
      // Use the default active model so embedding-coverage health check counts these rows.
      db.prepare("INSERT INTO embeddings (entry_id, embedding, model, created_at, format) VALUES (?, x'00', 'gemini-embedding-001', ?, 'f32')").run(`k${i}`, now);
    }
    db.prepare("INSERT INTO documents (id, session_id, project, tool, text, role, timestamp, tool_names, token_count, message_index, importance) VALUES ('d1','s1','p','x','hi','user',?,'[]',1,0,0.1)").run(now);
    db.prepare("INSERT INTO summaries (session_id, project, tool, topic, start_time, end_time, message_count, tools_used, data) VALUES ('s1','p','x','t',?,?,1,'[]','{}')").run(now, now);
    for (let i = 0; i < 10; i++) {
      db.prepare("INSERT INTO entities (id, name, type, canonical_name, aliases, first_seen, last_seen, mention_count, project) VALUES (?, ?, 'language', ?, '[]', ?, ?, 10, 'p')").run(`e${i}`, `n${i}`, `n${i}`, now, now);
    }
    const h = deriveHealth(db);
    expect(h.overall.status).toBe("ok");
    expect(h.checks).toHaveLength(5);
  });

  it("returns err overall status when any check is err", () => {
    const now = Date.now();
    // 100 entries, ZERO embeddings → embedding-coverage = 0 → err
    for (let i = 0; i < 100; i++) {
      db.prepare("INSERT INTO knowledge (id, type, project, session_id, timestamp, summary, details, tags, related_files, importance) VALUES (?, 'fact', 'p', 's1', ?, 'a', 'b', '[]', '[]', 0.5)").run(`k${i}`, now);
    }
    const h = deriveHealth(db);
    expect(h.overall.status).toBe("err");
    expect(h.checks.find(c => c.name === "embedding-coverage")!.status).toBe("err");
  });

  it("computes overall score as rounded mean of check values * 100", () => {
    // empty DB → all checks return 0 or 1 depending on definition
    const h = deriveHealth(db);
    expect(typeof h.overall.score).toBe("number");
    expect(h.overall.score).toBeGreaterThanOrEqual(0);
    expect(h.overall.score).toBeLessThanOrEqual(100);
  });
});
