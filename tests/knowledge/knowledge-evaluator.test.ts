import { describe, it, expect } from "vitest";
import { KnowledgeEvaluator } from "../../src/knowledge/knowledge-evaluator.js";

function makeContent(content: string) {
  return content;
}

describe("KnowledgeEvaluator", () => {
  const evaluator = new KnowledgeEvaluator();

  describe("actionability", () => {
    it("should accept well-formed actionable content", () => {
      const result = evaluator.evaluate(
        makeContent(
          "Set timeout to 30000ms when calling the /api/v2/export endpoint to avoid 504 errors."
        )
      );
      expect(result.outcome).toBe("accepted");
    });

    it("should accept content with imperative verbs", () => {
      const result = evaluator.evaluate(
        makeContent(
          "Use the --no-cache flag when building Docker images in CI to avoid stale layer issues at port 8080."
        )
      );
      expect(result.outcome).toBe("accepted");
    });

    it("should accept content with conditional patterns", () => {
      const result = evaluator.evaluate(
        makeContent(
          "When the API returns a 429 status, then use exponential backoff with a 200ms base delay."
        )
      );
      expect(result.outcome).toBe("accepted");
    });

    it("should reject vague non-actionable content", () => {
      const result = evaluator.evaluate(
        makeContent("This API is tricky and complicated sometimes")
      );
      expect(result.outcome).toBe("rejected");
      expect(result.reason).toContain("actionable");
    });

    it("should reject purely observational content", () => {
      const result = evaluator.evaluate(
        makeContent("The system seemed slow yesterday afternoon")
      );
      expect(result.outcome).toBe("rejected");
    });
  });

  describe("specificity", () => {
    it("should accept content with multiple specific details", () => {
      const result = evaluator.evaluate(
        makeContent(
          "Set timeout to 30000ms when calling the /api/v2/export endpoint to avoid 504 errors."
        )
      );
      expect(result.outcome).toBe("accepted");
    });

    it("should accept content with version and URL specifics", () => {
      const result = evaluator.evaluate(
        makeContent(
          "Use v3.2.1 of the SDK, the /auth/token endpoint requires the X-API-Key header."
        )
      );
      expect(result.outcome).toBe("accepted");
    });

    it("should reject content without specific details", () => {
      const result = evaluator.evaluate(
        makeContent(
          "Always configure the system properly for best results"
        )
      );
      expect(result.outcome).toBe("rejected");
      expect(result.reason).toContain("specific");
    });

    it("should require 2+ specificity signals", () => {
      // Only has one signal (the number) - but "configure" makes it actionable
      const result = evaluator.evaluate(
        makeContent("Always configure retry to a reasonable value")
      );
      expect(result.outcome).toBe("rejected");
      expect(result.reason).toContain("specific");
    });
  });

  describe("relevance", () => {
    it("should reject off-topic content about weather", () => {
      const result = evaluator.evaluate(
        makeContent(
          "The weather today is great, around 72 degrees at the endpoint"
        )
      );
      expect(result.outcome).toBe("rejected");
      expect(result.reason).toContain("relevant");
    });

    it("should reject content about politics", () => {
      const result = evaluator.evaluate(
        makeContent(
          "Use the politics API to check for 200 status codes at the endpoint"
        )
      );
      expect(result.outcome).toBe("rejected");
    });

    it("should reject joke content", () => {
      const result = evaluator.evaluate(
        makeContent(
          "This funny joke about configuring the timeout to 500ms at port 3000"
        )
      );
      expect(result.outcome).toBe("rejected");
    });

    it("should accept technical content", () => {
      const result = evaluator.evaluate(
        makeContent(
          "Configure the retry backoff to 200ms with MAX_RETRIES set to 3."
        )
      );
      expect(result.outcome).toBe("accepted");
    });
  });

  describe("performance", () => {
    it("should evaluate in < 50ms", () => {
      const start = performance.now();
      for (let i = 0; i < 100; i++) {
        evaluator.evaluate(
          "Set timeout to 30000ms when calling /api/v2/export endpoint."
        );
      }
      const elapsed = performance.now() - start;
      // 100 evaluations should complete in well under 50ms total
      expect(elapsed).toBeLessThan(50);
    });
  });

  describe("rejection reasons", () => {
    it("should provide descriptive rejection reason for each criterion", () => {
      const vague = evaluator.evaluate("Things are complicated sometimes");
      expect(vague.reason.length).toBeGreaterThan(10);

      const generic = evaluator.evaluate(
        "Always configure the system properly for best results"
      );
      expect(generic.reason.length).toBeGreaterThan(10);
    });

    it("should include reason for accepted content", () => {
      const result = evaluator.evaluate(
        "Set timeout to 30000ms at the /api/v2/export endpoint to avoid 504 errors."
      );
      expect(result.reason).toContain("Passes");
    });
  });
});
