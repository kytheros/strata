import { describe, expect, test } from "vitest";
import { loadFixtures, validateFixture } from "./fixture-loader.js";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("fixture-loader", () => {
  test("loads valid fixtures and rejects malformed ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "fixture-test-"));
    mkdirSync(join(dir, "hand-annotated"));
    const valid = {
      id: "compound-001",
      source: "hand-annotated",
      failure_mode: "compound",
      longmemeval_task_type: null,
      sessions: [{ id: "s1", turns: [{ role: "user", content: "hi" }] }],
      query: "?",
      expected_answer: "yes",
      expected_evidence_turns: [{ session_id: "s1", turn_index: 0 }],
      min_recall_at_k: 1,
    };
    writeFileSync(join(dir, "hand-annotated", "compound-001.json"), JSON.stringify(valid));

    const fixtures = loadFixtures(dir);
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0].id).toBe("compound-001");
  });

  test("validateFixture rejects missing required fields", () => {
    expect(() => validateFixture({ id: "x" })).toThrow(/sessions/);
  });
});
