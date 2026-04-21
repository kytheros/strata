import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ExtractionQueueStore } from "../../../src/extensions/extraction-queue/queue-store.js";
import { ExtractionWorker } from "../../../src/extensions/extraction-queue/extraction-worker.js";
import { CompositeTenantResolver, type TenantWriteTarget } from "../../../src/extensions/extraction-queue/tenant-db-resolver.js";
import type { LlmProvider } from "../../../src/extensions/llm-extraction/llm-provider.js";

describe("extraction queue — tenant isolation", () => {
  let dir: string;
  let store: ExtractionQueueStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "strata-iso-"));
    store = new ExtractionQueueStore(join(dir, "_queue.db"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("jobs for tenant A do not leak into tenant B", async () => {
    const provider: LlmProvider = {
      name: "fake",
      complete: async () =>
        JSON.stringify({ facts: [{ text: "some fact", type: "semantic" }] }),
    };

    const writesByTenant = new Map<string, string[]>();
    const resolver = new CompositeTenantResolver({
      v2: async () => {
        throw new Error("not used in this test");
      },
      legacy: async (playerId, agentId, fn) => {
        const target: TenantWriteTarget = {
          kind: "legacy",
          agentId,
          addEntry: async (text) => {
            const key = `legacy:${playerId}`;
            const list = writesByTenant.get(key) ?? [];
            list.push(text);
            writesByTenant.set(key, list);
            return "id";
          },
        };
        return fn(target);
      },
    });

    const worker = new ExtractionWorker({ queue: store, provider, tenantResolver: resolver });

    store.enqueue({
      tenantId: "legacy:player-A", agentId: "goran", memoryId: "m1",
      text: "player A utterance", userTags: ["dialogue"],
    });
    store.enqueue({
      tenantId: "legacy:player-B", agentId: "goran", memoryId: "m2",
      text: "player B utterance", userTags: ["dialogue"],
    });

    await worker.flushAll();

    expect(writesByTenant.get("legacy:player-A")).toHaveLength(1);
    expect(writesByTenant.get("legacy:player-B")).toHaveLength(1);
    // Critical: A and B tenant buckets never share a single write.
    expect(writesByTenant.size).toBe(2);
  });
});
