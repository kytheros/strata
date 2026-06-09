/**
 * MCP acceptance test: search_history Zod inputSchema enum gates.
 *
 * Regression pin for the bug where `.strict()` on the search_history
 * inputSchema rejected retrieval_strategy:"deep" because the enum was
 * ["auto","tirqdp","legacy"] (missing "deep").
 *
 * These tests use the live inputSchema obtained from the registered
 * search_history MCP tool via createServer(), so they catch any future
 * enum regression at the schema level — not just at the call-routing level.
 *
 * Two assertions per enum field (accept valid + reject invalid) so the
 * strict() mode is exercised for both the happy path and the guard path.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "../../src/server.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// ---------------------------------------------------------------------------
// Access the live search_history inputSchema from the MCP server.
//
// McpServer stores tools in _registeredTools (private in TS types, but
// accessible at runtime — this is the standard test-access pattern for the
// SDK's internal registry).
// ---------------------------------------------------------------------------

const dataDir = mkdtempSync(join(tmpdir(), "strata-schema-acceptance-"));
const { server } = createServer({ dataDir });

// Cast to reach the private registry.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const registeredTools = (server as unknown as { _registeredTools: Record<string, { inputSchema?: import("zod").ZodTypeAny }> })._registeredTools;
const searchHistorySchema = registeredTools["search_history"]?.inputSchema;

afterAll(() => {
  // Nothing to close — SQLite is not opened until first tool call; dataDir
  // will be cleaned by the OS temp-file reaper.
});

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("search_history MCP inputSchema — enum acceptance gate", () => {
  it("schema is registered and accessible from the live MCP server", () => {
    expect(searchHistorySchema).toBeDefined();
  });

  // ── retrieval_strategy enum ─────────────────────────────────────────────

  it('accepts retrieval_strategy:"deep" (the recommended agent pipeline strategy)', () => {
    const result = searchHistorySchema!.safeParse({
      query: "x",
      retrieval_strategy: "deep",
      format: "agent",
      max_chars: 10000,
    });
    expect(result.success).toBe(true);
  });

  it('accepts retrieval_strategy:"auto" (default)', () => {
    const result = searchHistorySchema!.safeParse({ query: "x", retrieval_strategy: "auto" });
    expect(result.success).toBe(true);
  });

  it('accepts retrieval_strategy:"tirqdp"', () => {
    const result = searchHistorySchema!.safeParse({ query: "x", retrieval_strategy: "tirqdp" });
    expect(result.success).toBe(true);
  });

  it('accepts retrieval_strategy:"legacy"', () => {
    const result = searchHistorySchema!.safeParse({ query: "x", retrieval_strategy: "legacy" });
    expect(result.success).toBe(true);
  });

  it("rejects retrieval_strategy:\"bogus\" — enum is enforced by .strict()", () => {
    const result = searchHistorySchema!.safeParse({ query: "x", retrieval_strategy: "bogus" });
    expect(result.success).toBe(false);
  });

  // ── format enum ────────────────────────────────────────────────────────

  it('accepts format:"agent" (the recommended agent pipeline output)', () => {
    const result = searchHistorySchema!.safeParse({ query: "x", format: "agent" });
    expect(result.success).toBe(true);
  });

  it("rejects format:\"unknown-format\" — enum is enforced", () => {
    const result = searchHistorySchema!.safeParse({ query: "x", format: "unknown-format" });
    expect(result.success).toBe(false);
  });

  // ── combined recommended pipeline input ────────────────────────────────

  it("accepts the full recommended agent pipeline parameters without error", () => {
    // This is the canonical form validated by LongMemEval-S N=3 canary
    // (~81% task-avg, recall@20 95.2%, max_chars=10000 required).
    const result = searchHistorySchema!.safeParse({
      query: "what database decisions did we make last sprint",
      retrieval_strategy: "deep",
      format: "agent",
      max_chars: 10000,
    });
    expect(result.success).toBe(true);
  });

  // ── .strict() rejects unknown fields ───────────────────────────────────

  it("rejects an unknown field — .strict() is still active", () => {
    const result = searchHistorySchema!.safeParse({
      query: "x",
      nonexistent_param: true,
    });
    expect(result.success).toBe(false);
  });
});
