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
