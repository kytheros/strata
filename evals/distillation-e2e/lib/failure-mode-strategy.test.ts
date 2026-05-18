import { describe, expect, test } from "vitest";
import { failureModeToStrategy } from "./failure-mode-strategy.js";

describe("failureModeToStrategy", () => {
  test("returns the spec §4.2 default for every failure_mode", () => {
    expect(failureModeToStrategy("compound", null)).toBe("turns");
    expect(failureModeToStrategy("code_identifier", null)).toBe("turns");
    expect(failureModeToStrategy("coreference", null)).toBe("rrf-both");
    expect(failureModeToStrategy("hedge", null)).toBe("entries");
    expect(failureModeToStrategy("long_context", null)).toBe("tirqdp");
    expect(failureModeToStrategy("negation", null)).toBe("entries");
    expect(failureModeToStrategy("temporal", null)).toBe("legacy");
    expect(failureModeToStrategy("tool_output_buried", null)).toBe("turns");
  });

  test("returns the spec §4.2 default for every longmemeval_task_type when failure_mode is null", () => {
    expect(failureModeToStrategy(null, "ie")).toBe("rrf-both");
    expect(failureModeToStrategy(null, "ku")).toBe("tirqdp");
    expect(failureModeToStrategy(null, "temporal")).toBe("legacy");
    expect(failureModeToStrategy(null, "multi_session")).toBe("tirqdp");
  });

  test("failure_mode takes precedence over task_type when both are set", () => {
    expect(failureModeToStrategy("compound", "ie")).toBe("turns");
  });

  test("falls back to 'rrf-both' when neither is set", () => {
    // Per spec §9 (circular dependency mitigation): rrf-both is the
    // least-bad default before the ablation sweep tunes the table.
    expect(failureModeToStrategy(null, null)).toBe("rrf-both");
  });
});
