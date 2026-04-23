import { describe, expect, test } from "vitest";
import { ExtractionWorker } from "../../../src/extensions/extraction-queue/extraction-worker.js";
import { ExtractionQueueStore } from "../../../src/extensions/extraction-queue/queue-store.js";
import type { TenantDbResolver } from "../../../src/extensions/extraction-queue/tenant-db-resolver.js";
import type { LlmProvider } from "../../../src/extensions/llm-extraction/llm-provider.js";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

type Written = { text: string; tags: string[]; importance: number };

function makeResolver(written: Written[]): TenantDbResolver {
  return {
    async withTenantDb(_tenant, _agent, fn) {
      await fn({
        kind: "legacy",
        agentId: _agent,
        async addEntry(text: string, tags: string[], importance: number) {
          written.push({ text, tags, importance });
          return `${written.length}`;
        },
      });
    },
  } as unknown as TenantDbResolver;
}

function stubProvider(jsonResponse: string): LlmProvider {
  return {
    name: "stub",
    async complete() { return jsonResponse; },
  };
}

describe("ExtractionWorker narrative integrity", () => {
  test("hedged source → stored fact has hearsay tag and importance ≤ 40", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "extract-test-"));
    const queue = new ExtractionQueueStore(join(tmpDir, "q.db"));
    try {
      const written: Written[] = [];
      const provider = stubProvider(JSON.stringify({
        facts: [{ text: "bandits near Blackwood", type: "semantic", importance: 70 }],
      }));
      const worker = new ExtractionWorker({ queue, provider, tenantResolver: makeResolver(written) });
      queue.enqueue({
        tenantId: "legacy:p1", agentId: "brynn",
        memoryId: "1", text: "There's talk of bandits near Blackwood.",
        userTags: ["dialogue"],
      });
      expect(await worker.runOnce()).toBe(true);
      expect(written).toHaveLength(1);
      expect(written[0].tags).toContain("hearsay");
      expect(written[0].importance).toBeLessThanOrEqual(40);
      expect(written[0].text.toLowerCase()).toMatch(/rumor|heard/);
    } finally {
      queue.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("self-tagged source → stored fact has self-utterance tag and importance halved", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "extract-test-"));
    const queue = new ExtractionQueueStore(join(tmpDir, "q.db"));
    try {
      const written: Written[] = [];
      const provider = stubProvider(JSON.stringify({
        facts: [{ text: "goran has a daughter", type: "semantic", importance: 80 }],
      }));
      const worker = new ExtractionWorker({ queue, provider, tenantResolver: makeResolver(written) });
      queue.enqueue({
        tenantId: "legacy:p1", agentId: "goran",
        memoryId: "1", text: "I said: 'My daughter passed ten years ago.'",
        userTags: ["dialogue", "self"],
      });
      expect(await worker.runOnce()).toBe(true);
      expect(written[0].tags).toContain("self-utterance");
      expect(written[0].importance).toBe(40); // 80 * 0.5
    } finally {
      queue.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("hedged AND self-tagged → both tags + stacked penalty", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "extract-test-"));
    const queue = new ExtractionQueueStore(join(tmpDir, "q.db"));
    try {
      const written: Written[] = [];
      const provider = stubProvider(JSON.stringify({
        facts: [{ text: "bandits near Blackwood", type: "semantic", importance: 80 }],
      }));
      const worker = new ExtractionWorker({ queue, provider, tenantResolver: makeResolver(written) });
      queue.enqueue({
        tenantId: "legacy:p1", agentId: "brynn",
        memoryId: "1", text: "I said: 'There's talk of bandits, but no reports.'",
        userTags: ["dialogue", "self"],
      });
      expect(await worker.runOnce()).toBe(true);
      expect(written[0].tags).toContain("hearsay");
      expect(written[0].tags).toContain("self-utterance");
      // hedge ceil=40, then * 0.5 = 20
      expect(written[0].importance).toBe(20);
    } finally {
      queue.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("plain player-stated fact is unchanged", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "extract-test-"));
    const queue = new ExtractionQueueStore(join(tmpDir, "q.db"));
    try {
      const written: Written[] = [];
      const provider = stubProvider(JSON.stringify({
        facts: [{ text: "player is named Mike", type: "semantic", importance: 70 }],
      }));
      const worker = new ExtractionWorker({ queue, provider, tenantResolver: makeResolver(written) });
      queue.enqueue({
        tenantId: "legacy:p1", agentId: "goran",
        memoryId: "1", text: "My name is Mike.", userTags: ["dialogue"],
      });
      expect(await worker.runOnce()).toBe(true);
      expect(written[0].tags).not.toContain("hearsay");
      expect(written[0].tags).not.toContain("self-utterance");
      expect(written[0].importance).toBe(70);
    } finally {
      queue.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("STRATA_HEDGE_FILTER_ENABLED=false restores pre-fix behavior", async () => {
    process.env.STRATA_HEDGE_FILTER_ENABLED = "false";
    const tmpDir = mkdtempSync(join(tmpdir(), "extract-test-"));
    const queue = new ExtractionQueueStore(join(tmpDir, "q.db"));
    try {
      const written: Written[] = [];
      const provider = stubProvider(JSON.stringify({
        facts: [{ text: "bandits near Blackwood", type: "semantic", importance: 70 }],
      }));
      const worker = new ExtractionWorker({ queue, provider, tenantResolver: makeResolver(written) });
      queue.enqueue({
        tenantId: "legacy:p1", agentId: "brynn",
        memoryId: "1", text: "There's talk of bandits.", userTags: ["dialogue"],
      });
      expect(await worker.runOnce()).toBe(true);
      expect(written[0].tags).not.toContain("hearsay");
      expect(written[0].importance).toBe(70);
    } finally {
      delete process.env.STRATA_HEDGE_FILTER_ENABLED;
      queue.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("STRATA_SELF_UTTERANCE_MULTIPLIER=1.0 disables Fix 3", async () => {
    process.env.STRATA_SELF_UTTERANCE_MULTIPLIER = "1.0";
    const tmpDir = mkdtempSync(join(tmpdir(), "extract-test-"));
    const queue = new ExtractionQueueStore(join(tmpDir, "q.db"));
    try {
      const written: Written[] = [];
      const provider = stubProvider(JSON.stringify({
        facts: [{ text: "goran has a daughter", type: "semantic", importance: 80 }],
      }));
      const worker = new ExtractionWorker({ queue, provider, tenantResolver: makeResolver(written) });
      queue.enqueue({
        tenantId: "legacy:p1", agentId: "goran",
        memoryId: "1", text: "I said: 'I have a daughter.'", userTags: ["dialogue", "self"],
      });
      expect(await worker.runOnce()).toBe(true);
      expect(written[0].importance).toBe(80);
    } finally {
      delete process.env.STRATA_SELF_UTTERANCE_MULTIPLIER;
      queue.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
