import { describe, it, expect } from "vitest";
import { formatProvenanceHandle } from "../../src/utils/format-provenance.js";

describe("formatProvenanceHandle", () => {
  it("emits 6-char short ids with sess + t", () => {
    const out = formatProvenanceHandle({
      id: "k_8a3fb41c-e7d0-4c2a-9b11-2e7d33a912ab",
      sessionId: "s_7d21e9b0-0000-4000-a000-000000000000",
      createdAt: 1715126400000,
      updatedAt: 1715212800000,
      editCount: 0,
    });
    expect(out).toBe("[mem:k_8a3fb4 sess:s_7d21e9 t:2024-05-08]");
  });

  it("omits sess when sessionId is null", () => {
    const out = formatProvenanceHandle({
      id: "k_abc12345-XXXX",
      sessionId: null,
      createdAt: 1715126400000,
      updatedAt: 1715126400000,
      editCount: 0,
    });
    expect(out).toBe("[mem:k_abc123 t:2024-05-08]");
  });
});
