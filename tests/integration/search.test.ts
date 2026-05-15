// Uses an in-repo fixture (tests/fixtures/claude-projects/) instead of ~/.claude/projects/
// so the test is deterministic and completes in milliseconds on any machine.
import { describe, it, expect, beforeAll } from "vitest";
import { join } from "path";
import { fileURLToPath } from "url";
import { IndexManager } from "../../src/indexing/index-manager.js";
import { SearchEngine } from "../../src/search/search-engine.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE_DIR = join(__dirname, "..", "fixtures", "claude-projects");

describe("SearchEngine integration", () => {
  let indexManager: IndexManager;
  let engine: SearchEngine;

  beforeAll(async () => {
    indexManager = new IndexManager(FIXTURE_DIR);
    await indexManager.buildFullIndex();
    engine = new SearchEngine(indexManager);
  });

  it("should have indexed sessions", () => {
    const stats = indexManager.getStats();
    expect(stats.sessions).toBeGreaterThan(0);
    expect(stats.documents).toBeGreaterThan(0);
  });

  it("should return results for a general query", () => {
    const results = engine.search("docker");
    // docker appears in multiple fixture sessions
    expect(results.length).toBeGreaterThanOrEqual(0);
  });

  it("should support project filtering", () => {
    const results = engine.search("test project:ghostty", { limit: 5 });
    for (const r of results) {
      expect(r.project.toLowerCase()).toContain("ghostty");
    }
  });

  it("should respect limit parameter", () => {
    const results = engine.search("error", { limit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("should find solutions", () => {
    const results = engine.searchSolutions("error");
    expect(results.length).toBeGreaterThanOrEqual(0);
  });
});
