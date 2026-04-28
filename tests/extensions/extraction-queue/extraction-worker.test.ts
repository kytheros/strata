import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ExtractionQueueStore } from "../../../src/extensions/extraction-queue/queue-store.js";
import { ExtractionWorker } from "../../../src/extensions/extraction-queue/extraction-worker.js";
import type { LlmProvider } from "../../../src/extensions/llm-extraction/llm-provider.js";
import type { TenantDbResolver, TenantWriteTarget } from "../../../src/extensions/extraction-queue/tenant-db-resolver.js";

function fakeProvider(factsJson: string): LlmProvider {
  return {
    name: "fake",
    complete: async () => factsJson,
  };
}

function recordingResolver(): {
  resolver: TenantDbResolver;
  writes: Array<{ tenantId: string; agentId: string; text: string; importance: number; tags: string[] }>;
} {
  const writes: Array<{ tenantId: string; agentId: string; text: string; importance: number; tags: string[] }> = [];
  const resolver: TenantDbResolver = {
    withTenantDb: async (tenantId, agentId, fn) => {
      const target: TenantWriteTarget = {
        kind: "legacy",
        agentId,
        addEntry: async (text, tags, importance) => {
          writes.push({ tenantId, agentId, text, importance, tags });
          return "id";
        },
      };
      return fn(target);
    },
  };
  return { resolver, writes };
}

describe("ExtractionWorker", () => {
  let dir: string;
  let store: ExtractionQueueStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "strata-worker-"));
    store = new ExtractionQueueStore(join(dir, "_queue.db"));
  });
  afterEach(async () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("runOnce: success writes facts and marks completed", async () => {
    store.enqueue({
      tenantId: "legacy:p1",
      agentId: "goran",
      memoryId: "m1",
      text: "Alex wants 3 axes",
      userTags: ["dialogue"],
      importance: 70,
    });
    const { resolver, writes } = recordingResolver();
    const worker = new ExtractionWorker({
      queue: store,
      provider: fakeProvider(
        `{"facts":[{"text":"player wants axes","type":"semantic","importance":60}]}`,
      ),
      tenantResolver: resolver,
    });
    const ran = await worker.runOnce();
    expect(ran).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0].text).toBe("player wants axes");
    expect(writes[0].tags).toContain("extracted");
    expect(writes[0].tags).toContain("semantic");
    expect(writes[0].importance).toBe(60);
    expect(await worker.runOnce()).toBe(false);
  });

  test("runOnce: provider throw → markRetry with 1s backoff on attempt 1", async () => {
    store.enqueue({
      tenantId: "legacy:p1", agentId: "a", memoryId: "m", text: "t", userTags: [],
    });
    const { resolver } = recordingResolver();
    const worker = new ExtractionWorker({
      queue: store,
      provider: { name: "x", complete: async () => { throw new Error("boom"); } },
      tenantResolver: resolver,
    });
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    await worker.runOnce();
    vi.restoreAllMocks();
    // Should be pending again, not claimable until now+1000.
    expect(store.claimNext(now + 500)).toBeNull();
    const retried = store.claimNext(now + 1500);
    expect(retried).not.toBeNull();
    expect(retried!.attempts).toBe(2);
    expect(retried!.lastError).toMatch(/boom/);
  });

  test("runOnce: attempt 3 failure → markFailed", async () => {
    store.enqueue({
      tenantId: "legacy:p1", agentId: "a", memoryId: "m", text: "t", userTags: [],
    });
    const { resolver } = recordingResolver();
    const worker = new ExtractionWorker({
      queue: store,
      provider: { name: "x", complete: async () => { throw new Error("boom"); } },
      tenantResolver: resolver,
      backoffMs: [0, 0, 0],
    });
    await worker.runOnce();
    await worker.runOnce();
    await worker.runOnce();
    // No more claimable (failed).
    expect(store.claimNext(Date.now() + 10_000_000)).toBeNull();
  });

  test("flushAll: drains queue deterministically", async () => {
    for (let i = 0; i < 3; i++) {
      store.enqueue({
        tenantId: "legacy:p1", agentId: "a", memoryId: `m${i}`, text: "t", userTags: [],
      });
    }
    const { resolver, writes } = recordingResolver();
    const worker = new ExtractionWorker({
      queue: store,
      provider: fakeProvider(`{"facts":[{"text":"f","type":"semantic"}]}`),
      tenantResolver: resolver,
    });
    await worker.flushAll();
    expect(writes).toHaveLength(3);
  });

  test("start/stop: EventEmitter wakeup triggers immediate pickup", async () => {
    const { resolver, writes } = recordingResolver();
    const worker = new ExtractionWorker({
      queue: store,
      provider: fakeProvider(`{"facts":[{"text":"f","type":"semantic"}]}`),
      tenantResolver: resolver,
      pollIntervalMs: 60_000,
    });
    worker.start();
    store.enqueue({
      tenantId: "legacy:p1", agentId: "a", memoryId: "m", text: "t", userTags: [],
    });
    // Wait up to 500 ms for the event-driven pickup.
    for (let i = 0; i < 50 && writes.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(writes.length).toBe(1);
    await worker.stop();
  });
});

import Database from "better-sqlite3";
import { applySchema } from "../../../src/transports/world-schema.js";
import { NpcMemoryEngine } from "../../../src/transports/npc-memory-engine.js";

function v2Resolver(db: Database.Database): TenantDbResolver {
  return {
    withTenantDb: async (_tenantId, agentId, fn) => {
      const target: TenantWriteTarget = {
        kind: "v2", agentId, worldDb: db,
      } as unknown as TenantWriteTarget;
      return fn(target);
    },
  };
}

describe("ExtractionWorker — conflict resolution (Spec 2026-04-28)", () => {
  let db: Database.Database;
  let dir: string;
  let store: ExtractionQueueStore;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    dir = mkdtempSync(join(tmpdir(), "strata-worker-cr-"));
    store = new ExtractionQueueStore(join(dir, "_queue.db"));
  });
  afterEach(async () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    db.close();
  });

  test("supersedes prior fact with same (subject, predicate) on v2 path", async () => {
    const engine = new NpcMemoryEngine(db, "goran");
    const priorId = engine.add({
      content: "current horse is Silvermist",
      tags: [], importance: 70,
      subjectKey: "player", predicateKey: "current_hors",
    });

    store.enqueue({
      tenantId: "v2:test", agentId: "goran", memoryId: "raw-1",
      text: "My new horse is Shadowfax", userTags: [],
    });
    const worker = new ExtractionWorker({
      queue: store,
      provider: fakeProvider(`{"facts":[{"text":"player's current horse is Shadowfax","type":"semantic","subject":"player","predicate":"current horse"}]}`),
      tenantResolver: v2Resolver(db),
    });
    await worker.runOnce();

    const priorRow = db.prepare("SELECT superseded_by FROM npc_memories WHERE memory_id=?").get(priorId) as Record<string, unknown>;
    expect(priorRow.superseded_by).toBeTruthy();

    const newRow = db.prepare("SELECT content FROM npc_memories WHERE subject_key='player' AND predicate_key='current_hors' AND superseded_by IS NULL").get() as Record<string, unknown>;
    expect((newRow.content as string)).toContain("Shadowfax");
  });

  test("does NOT supersede when conflictDetection === 'off'", async () => {
    const { CONFIG } = await import("../../../src/config.js");
    const original = CONFIG.extraction.conflictDetection;
    CONFIG.extraction.conflictDetection = "off";
    try {
      const engine = new NpcMemoryEngine(db, "goran");
      const priorId = engine.add({
        content: "horse is Silvermist", tags: [], importance: 70,
        subjectKey: "player", predicateKey: "current_hors",
      });
      store.enqueue({
        tenantId: "v2:test", agentId: "goran", memoryId: "raw-1",
        text: "horse is Shadowfax", userTags: [],
      });
      const worker = new ExtractionWorker({
        queue: store,
        provider: fakeProvider(`{"facts":[{"text":"horse is Shadowfax","type":"semantic","subject":"player","predicate":"current horse"}]}`),
        tenantResolver: v2Resolver(db),
      });
      await worker.runOnce();
      const priorRow = db.prepare("SELECT superseded_by FROM npc_memories WHERE memory_id=?").get(priorId) as Record<string, unknown>;
      expect(priorRow.superseded_by).toBeNull();
    } finally {
      CONFIG.extraction.conflictDetection = original;
    }
  });

  test("does not supersede when extracted fact has no subject/predicate", async () => {
    const engine = new NpcMemoryEngine(db, "goran");
    const priorId = engine.add({
      content: "horse is Silvermist", tags: [], importance: 70,
      subjectKey: "player", predicateKey: "current_hors",
    });
    store.enqueue({
      tenantId: "v2:test", agentId: "goran", memoryId: "raw-1",
      text: "weather", userTags: [],
    });
    const worker = new ExtractionWorker({
      queue: store,
      provider: fakeProvider(`{"facts":[{"text":"the weather is fine","type":"episodic"}]}`),
      tenantResolver: v2Resolver(db),
    });
    await worker.runOnce();
    const priorRow = db.prepare("SELECT superseded_by FROM npc_memories WHERE memory_id=?").get(priorId) as Record<string, unknown>;
    expect(priorRow.superseded_by).toBeNull();
  });

  test("multiple atomic facts: only same-predicate triggers supersede", async () => {
    const engine = new NpcMemoryEngine(db, "goran");
    const priorHorse = engine.add({ content: "horse Silvermist", tags: [], importance: 70, subjectKey: "player", predicateKey: "current_hors" });
    const priorOccup = engine.add({ content: "occupation farmer", tags: [], importance: 70, subjectKey: "player", predicateKey: "occup" });
    store.enqueue({
      tenantId: "v2:test", agentId: "goran", memoryId: "raw-1",
      text: "Silvermist died, my new horse is Shadowfax", userTags: [],
    });
    const worker = new ExtractionWorker({
      queue: store,
      provider: fakeProvider(`{"facts":[
        {"text":"horse Silvermist died","type":"episodic","subject":"silvermist","predicate":"died"},
        {"text":"current horse is Shadowfax","type":"semantic","subject":"player","predicate":"current horse"}
      ]}`),
      tenantResolver: v2Resolver(db),
    });
    await worker.runOnce();
    const horseRow = db.prepare("SELECT superseded_by FROM npc_memories WHERE memory_id=?").get(priorHorse) as Record<string, unknown>;
    const occupRow = db.prepare("SELECT superseded_by FROM npc_memories WHERE memory_id=?").get(priorOccup) as Record<string, unknown>;
    expect(horseRow.superseded_by).toBeTruthy();
    expect(occupRow.superseded_by).toBeNull();
  });
});
