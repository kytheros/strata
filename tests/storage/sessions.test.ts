import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/storage/database.js";
import { listCanonicalSessions } from "../../src/storage/sessions.js";

describe("listCanonicalSessions", () => {
  let db: any;
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "strata-sess-"));
    db = openDatabase(join(dir, "test.db"));
    // s1: knowledge + documents (no summary, no events)
    db.prepare("INSERT INTO knowledge (id, type, project, session_id, timestamp, summary, details, tags, related_files, importance) VALUES ('k1', 'fact', 'E:/strata', 's1', 1000, 'a', 'b', '[]', '[]', 0.5)").run();
    db.prepare("INSERT INTO documents (id, session_id, project, tool, text, role, timestamp, tool_names, token_count, message_index, importance) VALUES ('d1', 's1', 'E:/strata', 'claude-code', 'hi', 'user', 900, '[]', 1, 0, 0.1)").run();
    // s2: documents only — the failed-extraction signal
    db.prepare("INSERT INTO documents (id, session_id, project, tool, text, role, timestamp, tool_names, token_count, message_index, importance) VALUES ('d2', 's2', 'E:/strata', 'claude-code', 'hi', 'user', 2000, '[]', 1, 0, 0.1)").run();
    // s3: knowledge in a different project
    db.prepare("INSERT INTO knowledge (id, type, project, session_id, timestamp, summary, details, tags, related_files, importance) VALUES ('k3', 'fact', 'other', 's3', 3000, 'a', 'b', '[]', '[]', 0.5)").run();
  });

  it("returns one row per distinct session across union of sources", () => {
    const result = listCanonicalSessions(db, {});
    expect(result.total).toBe(3);
    const ids = result.rows.map(r => r.sessionId).sort();
    expect(ids).toEqual(["s1", "s2", "s3"]);
  });

  it("enriches rows with messageCount, knowledgeCount, eventCount", () => {
    const result = listCanonicalSessions(db, {});
    const s1 = result.rows.find(r => r.sessionId === "s1")!;
    expect(s1.messageCount).toBe(1);
    expect(s1.knowledgeCount).toBe(1);
    expect(s1.eventCount).toBe(0);
    const s2 = result.rows.find(r => r.sessionId === "s2")!;
    expect(s2.messageCount).toBe(1);
    expect(s2.knowledgeCount).toBe(0);
  });

  it("filters by project (canonical match)", () => {
    const result = listCanonicalSessions(db, { project: "E:/strata" });
    expect(result.total).toBe(2);
    expect(result.rows.map(r => r.sessionId).sort()).toEqual(["s1", "s2"]);
  });

  it("filters by sinceMs", () => {
    const result = listCanonicalSessions(db, { sinceMs: 1500 });
    expect(result.total).toBe(2);
    expect(result.rows.map(r => r.sessionId).sort()).toEqual(["s2", "s3"]);
  });
});
