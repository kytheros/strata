/**
 * Test: PgSummaryStore + PgMetaStore.
 *
 * Requires Docker Postgres running on localhost:5432.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { createSchema } from "../../src/storage/pg/schema.js";
import { PgSummaryStore } from "../../src/storage/pg/pg-summary-store.js";
import { PgMetaStore } from "../../src/storage/pg/pg-meta-store.js";
import type { SessionSummary } from "../../src/knowledge/session-summarizer.js";

const PG_URL = process.env.PG_URL || "postgresql://postgres:test@localhost:5432/postgres";

function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: `session-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    project: "test-project",
    projectName: "Test Project",
    startTime: Date.now() - 3600000,
    endTime: Date.now(),
    duration: 3600000,
    messageCount: 10,
    userMessageCount: 5,
    topic: "Test session",
    keyTopics: ["testing"],
    toolsUsed: ["read", "write"],
    filesReferenced: ["file.ts"],
    hasCodeChanges: true,
    lastUserMessage: "Done!",
    ...overrides,
  };
}

describe("PgSummaryStore", () => {
  let pool: pg.Pool | undefined;
  let store: PgSummaryStore;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: PG_URL, max: 5 });
    try {
      await pool.query("SELECT 1");
    } catch {
      console.log("Postgres not available -- skipping PgSummaryStore tests");
      await pool.end();
      pool = undefined;
      return;
    }

    await createSchema(pool);
    store = new PgSummaryStore(pool, "default");
  });

  beforeEach(async () => {
    if (!pool) return;
    await pool.query("DELETE FROM summaries");
  });

  afterAll(async () => {
    if (pool) {
      await pool.end();
    }
  });

  it("should save and retrieve a summary", async () => {
    if (!pool) return;
    const summary = makeSummary({ sessionId: "s1" });
    await store.save(summary);

    const retrieved = await store.get("s1");
    expect(retrieved).toBeDefined();
    expect(retrieved!.sessionId).toBe("s1");
    expect(retrieved!.topic).toBe("Test session");
    expect(retrieved!.hasCodeChanges).toBe(true);
  });

  it("should upsert on save (update existing)", async () => {
    if (!pool) return;
    const s1 = makeSummary({ sessionId: "s-upsert", topic: "original" });
    await store.save(s1);

    const s2 = makeSummary({ sessionId: "s-upsert", topic: "updated" });
    await store.save(s2);

    const retrieved = await store.get("s-upsert");
    expect(retrieved!.topic).toBe("updated");
    expect(await store.getCount()).toBe(1);
  });

  it("should get recent summaries", async () => {
    if (!pool) return;
    for (let i = 0; i < 5; i++) {
      await store.save(makeSummary({ endTime: Date.now() - i * 1000 }));
    }

    const recent = await store.getRecent(3);
    expect(recent.length).toBe(3);
  });

  it("should get by project", async () => {
    if (!pool) return;
    await store.save(makeSummary({ project: "proj-a" }));
    await store.save(makeSummary({ project: "proj-b" }));

    const results = await store.getByProject("proj-a");
    expect(results.length).toBe(1);
    expect(results[0].project).toBe("proj-a");
  });

  it("should remove a summary", async () => {
    if (!pool) return;
    await store.save(makeSummary({ sessionId: "s-del" }));
    await store.remove("s-del");
    expect(await store.get("s-del")).toBeNull();
  });

  it("should get session heatmap", async () => {
    if (!pool) return;
    const now = Date.now();
    await store.save(makeSummary({ endTime: now }));

    const heatmap = await store.getSessionHeatmap(now - 86400000);
    expect(heatmap.length).toBeGreaterThanOrEqual(1);
    expect(heatmap[0].count).toBeGreaterThanOrEqual(1);
  });
});

describe("PgMetaStore", () => {
  let pool: pg.Pool | undefined;
  let store: PgMetaStore;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: PG_URL, max: 5 });
    try {
      await pool.query("SELECT 1");
    } catch {
      console.log("Postgres not available -- skipping PgMetaStore tests");
      await pool.end();
      pool = undefined;
      return;
    }

    await createSchema(pool);
    store = new PgMetaStore(pool);
  });

  beforeEach(async () => {
    if (!pool) return;
    // Clean up only non-schema keys
    await pool.query("DELETE FROM index_meta WHERE key != 'schema_version'");
  });

  afterAll(async () => {
    if (pool) {
      await pool.end();
    }
  });

  it("should set and get a value", async () => {
    if (!pool) return;
    await store.set("test-key", "test-value");
    expect(await store.get("test-key")).toBe("test-value");
  });

  it("should return undefined for missing key", async () => {
    if (!pool) return;
    expect(await store.get("nonexistent")).toBeUndefined();
  });

  it("should set and get JSON", async () => {
    if (!pool) return;
    await store.setJson("json-key", { foo: "bar", count: 42 });
    const value = await store.getJson<{ foo: string; count: number }>("json-key");
    expect(value).toEqual({ foo: "bar", count: 42 });
  });

  it("should upsert on set", async () => {
    if (!pool) return;
    await store.set("upsert-key", "v1");
    await store.set("upsert-key", "v2");
    expect(await store.get("upsert-key")).toBe("v2");
  });

  it("should remove a key", async () => {
    if (!pool) return;
    await store.set("rm-key", "value");
    await store.remove("rm-key");
    expect(await store.get("rm-key")).toBeUndefined();
  });

  it("should get all key-value pairs", async () => {
    if (!pool) return;
    await store.set("a", "1");
    await store.set("b", "2");

    const all = await store.getAll();
    expect(all["a"]).toBe("1");
    expect(all["b"]).toBe("2");
  });
});
