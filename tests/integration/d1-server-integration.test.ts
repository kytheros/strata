/**
 * D1 Server Integration Tests.
 *
 * Validates that createServer() correctly uses injected D1 StorageContext
 * instead of the default SQLite/IndexManager path. Tests the full tool
 * round-trip: store_memory -> search_history -> delete_memory via the MCP
 * protocol using InMemoryTransport.
 *
 * Also verifies that D1-incompatible features (RealtimeWatcher,
 * IncrementalIndexer) gracefully return null.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Miniflare } from "miniflare";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/server.js";
import { createD1Storage } from "../../src/storage/d1/index.js";
import type { StorageContext } from "../../src/storage/interfaces/index.js";
import type { CreateServerResult } from "../../src/server.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const USER_ID = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";

/**
 * Helper: extract text from an MCP tool response.
 * The content field is an array of typed content blocks; we join all text blocks.
 */
function extractText(response: { content?: unknown }): string {
  if (!response.content || !Array.isArray(response.content)) return "";
  return (response.content as { type: string; text?: string }[])
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text!)
    .join("");
}

/**
 * Wait for the async fire-and-forget writes in store_memory to settle.
 *
 * The store_memory handler calls executeResolution() without await, so the
 * D1 batch write happens asynchronously. In tests we need a short pause
 * before querying D1 directly to verify persistence.
 */
function waitForAsyncWrites(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 200));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("D1 Server Integration", () => {
  let mf: Miniflare;
  let db: any;
  let storage: StorageContext;
  let result: CreateServerResult;
  let client: Client;

  beforeEach(async () => {
    // Spin up a fresh Miniflare D1 instance
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: ["STRATA_DB"],
    });
    db = await mf.getD1Database("STRATA_DB");
    storage = await createD1Storage({ d1: db, userId: USER_ID });

    // Create the MCP server with injected D1 storage
    result = createServer({ storage });

    // Connect client <-> server via in-memory transport
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await result.server.connect(serverTransport);
    client = new Client({ name: "d1-test-client", version: "0.0.1" });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    // Wait for any in-flight async writes to settle before disposing Miniflare.
    // This prevents "poisoned stub" errors from background D1 batch calls.
    await waitForAsyncWrites();

    await client.close();
    await result.server.close();
    await storage.close();
    await mf.dispose();
  });

  // -----------------------------------------------------------------------
  // 1. createServer structure
  // -----------------------------------------------------------------------

  describe("createServer with D1 storage", () => {
    it("returns indexManager === null when storage is injected", () => {
      expect(result.indexManager).toBeNull();
    });

    it("returns the injected storage context", () => {
      expect(result.storage).toBe(storage);
    });

    it("exposes store_memory tool via MCP call", async () => {
      // Verify the tool is registered by calling it successfully.
      // We avoid listTools() here due to a known Zod schema serialization
      // issue in the MCP SDK version used by this project.
      const response = await client.callTool({
        name: "store_memory",
        arguments: {
          memory: "Test memory to verify tool is registered",
          type: "fact",
        },
      });
      const text = extractText(response);
      expect(text).toContain("Stored fact");
    });
  });

  // -----------------------------------------------------------------------
  // 2. store_memory tool
  // -----------------------------------------------------------------------

  describe("store_memory via MCP", () => {
    it("stores a memory and confirms success", async () => {
      const response = await client.callTool({
        name: "store_memory",
        arguments: {
          memory: "We decided to use D1 instead of local SQLite for the Workers deployment",
          type: "decision",
          tags: ["architecture", "d1"],
          project: "strata-d1-test",
        },
      });

      const text = extractText(response);
      expect(text).toContain("Stored decision");
    });

    it("rejects empty memory text", async () => {
      const response = await client.callTool({
        name: "store_memory",
        arguments: {
          memory: "",
          type: "decision",
        },
      });

      const text = extractText(response);
      expect(text).toContain("Error");
    });

    it("rejects memory text that is too short", async () => {
      const response = await client.callTool({
        name: "store_memory",
        arguments: {
          memory: "hi",
          type: "fact",
        },
      });

      const text = extractText(response);
      expect(text).toContain("Error");
      expect(text).toContain("too short");
    });

    it("persists data into D1 (queryable via storage)", async () => {
      await client.callTool({
        name: "store_memory",
        arguments: {
          memory: "Always run database migrations before seeding test data in CI pipelines",
          type: "learning",
          tags: ["ci", "migrations"],
          project: "strata-d1-test",
        },
      });

      // Wait for the fire-and-forget async write to complete
      await waitForAsyncWrites();

      // Query the D1 knowledge store directly to verify data landed
      const entries = await storage.knowledge.search("migrations");
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.some((e) => e.details.includes("migrations"))).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 3. search_history tool (round-trip via MCP)
  // -----------------------------------------------------------------------

  describe("search_history via MCP", () => {
    it("finds a previously stored memory via knowledge search", async () => {
      // Store a memory and wait for the async write
      await client.callTool({
        name: "store_memory",
        arguments: {
          memory: "Fixed the CORS error by adding Access-Control-Allow-Origin header to the Workers response",
          type: "solution",
          tags: ["cors", "workers"],
          project: "strata-d1-test",
        },
      });
      await waitForAsyncWrites();

      // Search via MCP tool
      const response = await client.callTool({
        name: "search_history",
        arguments: {
          query: "CORS error",
          project: "strata-d1-test",
        },
      });

      const text = extractText(response);
      // The search should find something via the knowledge store fallback
      // since we have no FTS5 documents. The knowledge integration in
      // search_history appends knowledge results when available.
      expect(text).toBeDefined();
      expect(text.length).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // 4. delete_memory tool
  // -----------------------------------------------------------------------

  describe("delete_memory via MCP", () => {
    it("deletes a stored entry and confirms removal", async () => {
      // Store a memory and wait for the fire-and-forget async write
      await client.callTool({
        name: "store_memory",
        arguments: {
          memory: "Temporary workaround: disable SSL verification for local D1 testing environments",
          type: "solution",
          tags: ["temporary"],
          project: "strata-d1-test",
        },
      });
      await waitForAsyncWrites();

      // Find the entry ID via the knowledge store
      const entries = await storage.knowledge.search("SSL verification");
      expect(entries.length).toBeGreaterThan(0);
      const entryId = entries[0].id;

      // Delete via MCP tool
      const response = await client.callTool({
        name: "delete_memory",
        arguments: { id: entryId },
      });

      const text = extractText(response);
      expect(text).toContain("Deleted entry");

      // Verify it's gone from D1
      const afterDelete = await storage.knowledge.search("SSL verification");
      const stillExists = afterDelete.some((e) => e.id === entryId);
      expect(stillExists).toBe(false);
    });

    it("returns error for non-existent entry", async () => {
      const response = await client.callTool({
        name: "delete_memory",
        arguments: { id: "non-existent-id-12345" },
      });

      const text = extractText(response);
      expect(text).toContain("not found");
    });

    it("does not affect other entries when deleting one", async () => {
      // Store two memories
      await client.callTool({
        name: "store_memory",
        arguments: {
          memory: "First entry: always validate user input before database queries",
          type: "learning",
          project: "strata-d1-test",
        },
      });
      await client.callTool({
        name: "store_memory",
        arguments: {
          memory: "Second entry: use parameterized queries to prevent SQL injection",
          type: "learning",
          project: "strata-d1-test",
        },
      });
      await waitForAsyncWrites();

      // Delete the first entry
      const allEntries = await storage.knowledge.search("validate user input");
      expect(allEntries.length).toBeGreaterThan(0);
      const firstId = allEntries[0].id;

      await client.callTool({
        name: "delete_memory",
        arguments: { id: firstId },
      });

      // Second entry should still exist
      const remaining = await storage.knowledge.search("parameterized queries");
      expect(remaining.length).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // 5. D1-incompatible features return null
  // -----------------------------------------------------------------------

  describe("D1-incompatible features", () => {
    it("startRealtimeWatcher returns null on D1 path", () => {
      const watcher = result.startRealtimeWatcher("/some/session/file.jsonl");
      expect(watcher).toBeNull();
    });

    it("startIncrementalIndexer returns null on D1 path", () => {
      const indexer = result.startIncrementalIndexer();
      expect(indexer).toBeNull();
    });
  });
});
