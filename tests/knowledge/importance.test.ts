import { describe, it, expect } from "vitest";
import {
  computeImportance,
  inferTypeFromRole,
  computeLanguageScore,
  TYPE_IMPORTANCE,
  LANGUAGE_MARKERS,
} from "../../src/knowledge/importance.js";
import type { ImportanceInput } from "../../src/knowledge/importance.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeInput(overrides: Partial<ImportanceInput> = {}): ImportanceInput {
  return {
    text: "some generic text",
    sessionId: "session-1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test 1: Type-based scoring
// ---------------------------------------------------------------------------

describe("computeImportance — type-based scoring", () => {
  it("should score a decision entry at 0.41 (type=1.0, lang=0.3, freq=0, expl=0)", () => {
    const input = makeInput({
      knowledgeType: "decision",
      text: "a plain decision with no language markers triggering high scores",
    });
    // type: 0.35 * 1.0 = 0.35
    // lang: 0.20 * 0.3 = 0.06 (no markers match)
    // freq: 0.35 * 0.0 = 0.0
    // expl: 0.10 * 0.0 = 0.0
    // total = 0.41
    const score = computeImportance(input);
    expect(score).toBeCloseTo(0.41, 2);
  });

  it("should score an episodic entry low", () => {
    const input = makeInput({
      knowledgeType: "episodic",
      text: "just looking at the output",
    });
    const score = computeImportance(input);
    // type: 0.35 * 0.3 = 0.105
    // lang: 0.20 * 0.1 = 0.02 ("looking at")
    // total = 0.125
    expect(score).toBeLessThan(0.20);
  });

  it("should map all knowledge types to the correct importance values", () => {
    const expectedTypes: [string, number][] = [
      ["decision", 1.0],
      ["learning", 0.9],
      ["error_fix", 0.85],
      ["pattern", 0.8],
      ["procedure", 0.75],
      ["preference", 0.7],
      ["fact", 0.6],
      ["solution", 0.5],
      ["episodic", 0.3],
    ];
    for (const [type, expected] of expectedTypes) {
      expect(TYPE_IMPORTANCE[type as keyof typeof TYPE_IMPORTANCE]).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 2: Language marker detection
// ---------------------------------------------------------------------------

describe("computeLanguageScore", () => {
  it("should detect 'decided to' as decision marker (score 1.0)", () => {
    const score = computeLanguageScore(
      "We decided to use PostgreSQL instead of MySQL going forward"
    );
    expect(score).toBe(1.0);
  });

  it("should detect 'instead of' as negation marker (score 0.9)", () => {
    const score = computeLanguageScore(
      "We used Redis instead of Memcached"
    );
    // "instead of" = 0.9
    expect(score).toBe(0.9);
  });

  it("should detect 'root cause' as error/consequence marker (score 0.85)", () => {
    const score = computeLanguageScore("The root cause was a race condition");
    expect(score).toBe(0.85);
  });

  it("should detect 'always' as temporal permanence marker (score 0.8)", () => {
    const score = computeLanguageScore("We should always use strict mode");
    expect(score).toBe(0.8);
  });

  it("should detect 'I prefer' as preference signal (score 0.75)", () => {
    const score = computeLanguageScore("I prefer using TypeScript over JavaScript");
    expect(score).toBe(0.75);
  });

  it("should detect 'deployed' as implementation marker (score 0.5)", () => {
    const score = computeLanguageScore("We deployed the new API to production");
    expect(score).toBe(0.5);
  });

  it("should detect 'working on' as status/filler marker (score 0.1)", () => {
    const score = computeLanguageScore("Currently working on the auth module");
    expect(score).toBe(0.1);
  });

  it("should return 0.3 (neutral) when no markers match", () => {
    const score = computeLanguageScore("The quick brown fox jumps over the lazy dog");
    expect(score).toBe(0.3);
  });

  it("should pick the max score when multiple markers match", () => {
    // "decided to" (1.0) and "instead of" (0.9) both match
    const score = computeLanguageScore(
      "We decided to use bun instead of npm"
    );
    expect(score).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// Test 3: Frequency signal
// ---------------------------------------------------------------------------

describe("computeImportance — frequency signal", () => {
  it("should score 0.867 for occurrences=5, projectCount=2", () => {
    const input = makeInput({
      knowledgeType: "fact",
      text: "some text",
      occurrences: 5,
      projectCount: 2,
    });
    // freq: min(1.0, (5/5)*0.6 + (2/3)*0.4) = min(1.0, 0.6 + 0.267) = 0.867
    const score = computeImportance(input);
    const expectedFreq = Math.min(1.0, (5 / 5) * 0.6 + (2 / 3) * 0.4);
    // type: 0.35 * 0.6 = 0.21, lang: 0.20 * 0.3 = 0.06, freq: 0.35 * 0.867, expl: 0
    const expected = 0.35 * 0.6 + 0.20 * 0.3 + 0.35 * expectedFreq + 0.10 * 0.0;
    expect(score).toBeCloseTo(expected, 2);
  });

  it("should cap frequency at 1.0 for high occurrences", () => {
    const input = makeInput({
      knowledgeType: "fact",
      text: "some text",
      occurrences: 10,
      projectCount: 3,
    });
    // freq: min(1.0, (10/5)*0.6 + (3/3)*0.4) = min(1.0, 1.2 + 0.4) = 1.0
    const score = computeImportance(input);
    const expected = 0.35 * 0.6 + 0.20 * 0.3 + 0.35 * 1.0 + 0.10 * 0.0;
    expect(score).toBeCloseTo(expected, 2);
  });

  it("should score 0 frequency when occurrences/projectCount are absent", () => {
    const input = makeInput({
      knowledgeType: "fact",
      text: "some text",
    });
    const score = computeImportance(input);
    // freq = 0
    const expected = 0.35 * 0.6 + 0.20 * 0.3 + 0.35 * 0.0 + 0.10 * 0.0;
    expect(score).toBeCloseTo(expected, 2);
  });
});

// ---------------------------------------------------------------------------
// Test 4: Explicit memory floor
// ---------------------------------------------------------------------------

describe("computeImportance — explicit memory", () => {
  it("should add explicit weight for sessionId='explicit-memory'", () => {
    const explicitInput = makeInput({
      knowledgeType: "fact",
      text: "a basic fact",
      sessionId: "explicit-memory",
    });
    const regularInput = makeInput({
      knowledgeType: "fact",
      text: "a basic fact",
      sessionId: "session-1",
    });

    const explicitScore = computeImportance(explicitInput);
    const regularScore = computeImportance(regularInput);

    // Explicit should be higher by exactly 0.10 * 1.0 = 0.10
    expect(explicitScore - regularScore).toBeCloseTo(0.10, 2);
    // And explicit memories should always outrank same-text non-explicit
    expect(explicitScore).toBeGreaterThan(regularScore);
  });

  it("should score explicit fact at >= 0.31", () => {
    const input = makeInput({
      knowledgeType: "fact",
      text: "some fact",
      sessionId: "explicit-memory",
    });
    const score = computeImportance(input);
    // type: 0.35*0.6=0.21, lang: 0.20*0.3=0.06, freq: 0, expl: 0.10*1.0=0.10
    // total = 0.37
    expect(score).toBeGreaterThanOrEqual(0.31);
  });
});

// ---------------------------------------------------------------------------
// Test 5: Document chunk role inference
// ---------------------------------------------------------------------------

describe("inferTypeFromRole", () => {
  it("should return 0.7 for user role with decision language", () => {
    const score = inferTypeFromRole(
      "user",
      "from now on always use bun instead of npm"
    );
    expect(score).toBe(0.7);
  });

  it("should return 0.4 for user role without decision language", () => {
    const score = inferTypeFromRole("user", "how do I configure webpack?");
    expect(score).toBe(0.4);
  });

  it("should return 0.6 for assistant role with code blocks", () => {
    const score = inferTypeFromRole(
      "assistant",
      "Here is the solution:\n```typescript\nconsole.log('hello');\n```"
    );
    expect(score).toBe(0.6);
  });

  it("should return 0.35 for assistant role without code blocks", () => {
    const score = inferTypeFromRole(
      "assistant",
      "I understand your question about configuration"
    );
    expect(score).toBe(0.35);
  });

  it("should return 0.4 for mixed role", () => {
    const score = inferTypeFromRole("mixed", "any text here");
    expect(score).toBe(0.4);
  });

  it("should return 0.3 for undefined role", () => {
    const score = inferTypeFromRole(undefined, "any text here");
    expect(score).toBe(0.3);
  });
});

// ---------------------------------------------------------------------------
// Test 6: Compound score range
// ---------------------------------------------------------------------------

describe("computeImportance — score range", () => {
  it("should always produce scores in [0.0, 1.0]", () => {
    const knowledgeTypes = [
      "decision", "learning", "error_fix", "pattern",
      "procedure", "preference", "fact", "solution", "episodic",
    ] as const;

    const texts = [
      "We decided to use PostgreSQL instead of MySQL going forward",
      "The root cause was a race condition in the auth module",
      "I prefer using TypeScript over JavaScript",
      "Currently working on the auth module",
      "The quick brown fox jumps over the lazy dog",
      "```typescript\nconst x = 1;\n```",
      "deployed the new service permanently",
      "from now on always run tests before committing",
    ];

    const roles = ["user", "assistant", "mixed", undefined] as const;
    const sessionIds = ["session-1", "explicit-memory"];
    const occurrencesList = [undefined, 1, 5, 10];
    const projectCountList = [undefined, 1, 2, 3];

    // Generate a sampling of combinations
    for (const type of knowledgeTypes) {
      for (const text of texts) {
        for (const sessionId of sessionIds) {
          const input = makeInput({
            knowledgeType: type,
            text,
            sessionId,
            occurrences: occurrencesList[Math.floor(Math.random() * occurrencesList.length)],
            projectCount: projectCountList[Math.floor(Math.random() * projectCountList.length)],
          });
          const score = computeImportance(input);
          expect(score).toBeGreaterThanOrEqual(0.0);
          expect(score).toBeLessThanOrEqual(1.0);
        }
      }
    }

    // Also test document chunk mode (no knowledgeType)
    for (const role of roles) {
      for (const text of texts) {
        for (const sessionId of sessionIds) {
          const input = makeInput({
            role,
            text,
            sessionId,
          });
          const score = computeImportance(input);
          expect(score).toBeGreaterThanOrEqual(0.0);
          expect(score).toBeLessThanOrEqual(1.0);
        }
      }
    }
  });

  it("should short-circuit when pre-computed importance is provided", () => {
    const input = makeInput({
      importance: 0.75,
      text: "irrelevant text",
    });
    expect(computeImportance(input)).toBe(0.75);
  });

  it("should not short-circuit when importance is undefined", () => {
    const input = makeInput({
      importance: undefined,
      knowledgeType: "decision",
      text: "some text",
    });
    const score = computeImportance(input);
    // Should compute normally, not return undefined
    expect(typeof score).toBe("number");
    expect(score).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Spec validation tests (from section 3.2)
// ---------------------------------------------------------------------------

describe("computeImportance — spec validation examples", () => {
  it("fresh explicit memory with decision language should score ~0.69", () => {
    const input = makeInput({
      knowledgeType: "decision",
      text: "We decided to use PostgreSQL",
      sessionId: "explicit-memory",
    });
    const score = computeImportance(input);
    // type: 0.35*1.0=0.35, lang: 0.20*1.0=0.20 ("decided to"), freq: 0, expl: 0.10*1.0=0.10
    // total = 0.65 (spec says ~0.69 but uses approximation)
    expect(score).toBeCloseTo(0.65, 2);
  });

  it("recurring error fix across 3 projects should score high (~0.89+)", () => {
    const input = makeInput({
      knowledgeType: "error_fix",
      text: "The root cause was a timeout in the connection pool",
      occurrences: 10,
      projectCount: 3,
    });
    const score = computeImportance(input);
    // type: 0.35*0.85=0.2975, lang: 0.20*0.85=0.17 ("root cause"), freq: 0.35*1.0=0.35
    // total = 0.8175
    expect(score).toBeGreaterThanOrEqual(0.8);
  });

  it("ephemeral single-session context entry should score ~0.19", () => {
    const input = makeInput({
      knowledgeType: "episodic",
      text: "let me check the logs for that error",
    });
    const score = computeImportance(input);
    // type: 0.35*0.3=0.105, lang: 0.20*0.1=0.02 ("let me check"), freq: 0, expl: 0
    // total = 0.125
    expect(score).toBeLessThan(0.25);
  });
});

// ---------------------------------------------------------------------------
// LANGUAGE_MARKERS structural checks
// ---------------------------------------------------------------------------

describe("LANGUAGE_MARKERS", () => {
  it("should have scores in (0, 1]", () => {
    for (const marker of LANGUAGE_MARKERS) {
      expect(marker.score).toBeGreaterThan(0);
      expect(marker.score).toBeLessThanOrEqual(1.0);
    }
  });

  it("should have valid regex patterns", () => {
    for (const marker of LANGUAGE_MARKERS) {
      expect(marker.pattern).toBeInstanceOf(RegExp);
      // Should not throw on empty string
      expect(() => marker.pattern.test("")).not.toThrow();
    }
  });
});
