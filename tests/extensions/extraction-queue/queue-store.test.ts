import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ExtractionQueueStore } from "../../../src/extensions/extraction-queue/queue-store.js";

describe("ExtractionQueueStore", () => {
  let dir: string;
  let dbPath: string;
  let store: ExtractionQueueStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "strata-queue-"));
    dbPath = join(dir, "_queue.db");
    store = new ExtractionQueueStore(dbPath);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("enqueue returns a job id and persists row", () => {
    const id = store.enqueue({
      tenantId: "v2:world-1",
      agentId: "npc-goran",
      memoryId: "mem-1",
      text: "hello world",
      userTags: ["dialogue"],
      importance: 60,
    });
    expect(id).toMatch(/[0-9a-f-]{36}/);

    const job = store.claimNext(Date.now());
    expect(job).not.toBeNull();
    expect(job!.id).toBe(id);
    expect(job!.tenantId).toBe("v2:world-1");
    expect(job!.agentId).toBe("npc-goran");
    expect(job!.status).toBe("running");
    expect(job!.attempts).toBe(1);
  });

  test("claimNext returns null when no pending rows", () => {
    expect(store.claimNext(Date.now())).toBeNull();
  });

  test("markCompleted transitions running→completed", () => {
    const id = store.enqueue({
      tenantId: "v2:w", agentId: "a", memoryId: "m", text: "t", userTags: [],
    });
    store.claimNext(Date.now());
    store.markCompleted(id, Date.now());
    expect(store.claimNext(Date.now())).toBeNull();
  });

  test("markRetry resets to pending with bumped next_attempt_at", () => {
    const id = store.enqueue({
      tenantId: "v2:w", agentId: "a", memoryId: "m", text: "t", userTags: [],
    });
    const future = Date.now() + 60_000;
    store.claimNext(Date.now());
    store.markRetry(id, "boom", future);
    expect(store.claimNext(Date.now())).toBeNull();
    const claimed = store.claimNext(future + 1);
    expect(claimed).not.toBeNull();
    expect(claimed!.attempts).toBe(2);
    expect(claimed!.lastError).toBe("boom");
  });

  test("markFailed transitions running→failed (never re-claimed)", () => {
    const id = store.enqueue({
      tenantId: "v2:w", agentId: "a", memoryId: "m", text: "t", userTags: [],
    });
    store.claimNext(Date.now());
    store.markFailed(id, "final", Date.now());
    expect(store.claimNext(Date.now() + 10_000_000)).toBeNull();
  });

  test("atomic claim: concurrent claimNext returns same row once", () => {
    store.enqueue({
      tenantId: "v2:w", agentId: "a", memoryId: "m", text: "t", userTags: [],
    });
    const a = store.claimNext(Date.now());
    const b = store.claimNext(Date.now());
    expect(a).not.toBeNull();
    expect(b).toBeNull();
  });

  test("recoverOrphaned resets running rows older than 5 min to pending", () => {
    const id = store.enqueue({
      tenantId: "v2:w", agentId: "a", memoryId: "m", text: "t", userTags: [],
    });
    const claimTime = Date.now() - 10 * 60_000;
    store.claimNext(claimTime);
    const recovered = store.recoverOrphaned(Date.now());
    expect(recovered).toBe(1);
    const claimed = store.claimNext(Date.now());
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(id);
    expect(claimed!.attempts).toBe(2);
  });

  test("enqueue emits 'enqueue' event", () => {
    let fired = 0;
    store.on("enqueue", () => fired++);
    store.enqueue({
      tenantId: "v2:w", agentId: "a", memoryId: "m", text: "t", userTags: [],
    });
    expect(fired).toBe(1);
  });
});
