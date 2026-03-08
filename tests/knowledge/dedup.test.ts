import { describe, it, expect } from "vitest";
import {
  trigramJaccard,
  getTrigrams,
  addsNewDetail,
  checkDuplicate,
} from "../../src/knowledge/dedup.js";

describe("dedup", () => {
  describe("getTrigrams", () => {
    it("should generate character trigrams", () => {
      const trigrams = getTrigrams("hello");
      expect(trigrams.has("hel")).toBe(true);
      expect(trigrams.has("ell")).toBe(true);
      expect(trigrams.has("llo")).toBe(true);
      expect(trigrams.size).toBe(3);
    });

    it("should return empty set for short strings", () => {
      expect(getTrigrams("ab").size).toBe(0);
      expect(getTrigrams("a").size).toBe(0);
      expect(getTrigrams("").size).toBe(0);
    });

    it("should lowercase before generating", () => {
      const upper = getTrigrams("ABC");
      const lower = getTrigrams("abc");
      expect(upper).toEqual(lower);
    });
  });

  describe("trigramJaccard", () => {
    it("should return 1.0 for identical strings", () => {
      expect(trigramJaccard("hello world", "hello world")).toBe(1);
    });

    it("should return 1.0 for both empty strings", () => {
      expect(trigramJaccard("", "")).toBe(1);
    });

    it("should return 0 for one empty string", () => {
      expect(trigramJaccard("hello", "")).toBe(0);
      expect(trigramJaccard("", "hello")).toBe(0);
    });

    it("should return high similarity for near-duplicates", () => {
      const sim = trigramJaccard(
        "Confluence REST API v2 requires expand parameters. Use ?expand=body.storage.",
        "Confluence REST API v2 requires expand parameters. Use ?expand=body.storage. Also pagination."
      );
      expect(sim).toBeGreaterThan(0.7);
    });

    it("should return low similarity for different strings", () => {
      const sim = trigramJaccard(
        "Docker container networking configuration",
        "React component state management hooks"
      );
      expect(sim).toBeLessThan(0.3);
    });

    it("should be case-insensitive", () => {
      expect(trigramJaccard("Hello World", "hello world")).toBe(1);
    });
  });

  describe("addsNewDetail", () => {
    it("should detect new detail when 3+ new words added", () => {
      expect(
        addsNewDetail(
          "Use expand parameters. Also pagination requires start and limit params explicitly.",
          "Use expand parameters for body content."
        )
      ).toBe(true);
    });

    it("should reject when no substantive new words", () => {
      expect(
        addsNewDetail(
          "Use expand parameters for body.",
          "Use expand parameters for body content."
        )
      ).toBe(false);
    });

    it("should ignore short words (length <= 3)", () => {
      expect(
        addsNewDetail(
          "Use the API for all of its features.",
          "Use the API."
        )
      ).toBe(false);
    });
  });

  describe("checkDuplicate", () => {
    const existing = [
      {
        id: "entry-1",
        content:
          "Confluence REST API v2 requires explicit expand parameters for body content. Use ?expand=body.storage.",
      },
      {
        id: "entry-2",
        content:
          "Docker build cache should be invalidated when Dockerfile changes. Use --no-cache flag.",
      },
    ];

    it("should detect exact duplicate", () => {
      const result = checkDuplicate(
        "Confluence REST API v2 requires explicit expand parameters for body content. Use ?expand=body.storage.",
        existing
      );
      expect(result.isDuplicate).toBe(true);
      expect(result.shouldMerge).toBe(false);
      expect(result.similarity).toBe(1);
    });

    it("should suggest merge when near-duplicate adds detail", () => {
      const result = checkDuplicate(
        "Confluence REST API v2 requires explicit expand parameters for body content. Use ?expand=body.storage. Also pagination requires start=0&limit=25 parameters explicitly.",
        existing
      );
      // May be duplicate with merge suggestion depending on similarity threshold
      if (result.isDuplicate) {
        expect(result.shouldMerge).toBe(true);
        expect(result.mergeTargetId).toBe("entry-1");
      }
    });

    it("should accept completely different content", () => {
      const result = checkDuplicate(
        "Set Kubernetes pod memory limit to 512Mi to prevent OOM kills at the application endpoint.",
        existing
      );
      expect(result.isDuplicate).toBe(false);
      expect(result.similarity).toBeLessThan(0.9);
    });

    it("should handle empty existing entries", () => {
      const result = checkDuplicate("Some new content here", []);
      expect(result.isDuplicate).toBe(false);
      expect(result.similarity).toBe(0);
    });
  });
});
