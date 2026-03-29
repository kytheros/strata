import { describe, it, expect } from "vitest";
import {
  classifyQuestion,
  getProcedure,
  getToolSubset,
  isComparisonQuestion,
  type QuestionType,
} from "../../src/reasoning/procedures.js";

// ---------------------------------------------------------------------------
// classifyQuestion
// ---------------------------------------------------------------------------

describe("classifyQuestion", () => {
  describe("duration questions", () => {
    it("detects 'how many days' as duration (not counting)", () => {
      expect(classifyQuestion("How many days did you spend hiking?")).toBe(
        "duration"
      );
    });

    it("detects 'how many months' questions", () => {
      expect(classifyQuestion("How many months did the project take?")).toBe(
        "duration"
      );
    });

    it("detects 'how much time' questions", () => {
      expect(classifyQuestion("How much time cooking?")).toBe("duration");
    });

    it("detects 'how many hours' questions", () => {
      expect(classifyQuestion("How many hours did you work last week?")).toBe(
        "duration"
      );
    });
  });

  describe("counting questions", () => {
    it("detects 'how many' questions (non-duration)", () => {
      expect(classifyQuestion("How many books did you read?")).toBe("counting");
    });

    it("detects 'list all' questions", () => {
      expect(classifyQuestion("List all the restaurants")).toBe("counting");
    });

    it("detects 'how often' questions", () => {
      expect(classifyQuestion("How often did you go running?")).toBe(
        "counting"
      );
    });

    it("detects 'total' questions", () => {
      expect(classifyQuestion("What is the total number of commits?")).toBe(
        "counting"
      );
    });
  });

  describe("comparison questions", () => {
    it("detects 'which...most often' patterns", () => {
      expect(classifyQuestion("Which restaurant most often?")).toBe(
        "comparison"
      );
    });

    it("detects 'most expensive' superlatives", () => {
      expect(classifyQuestion("Most expensive purchase?")).toBe("comparison");
    });

    it("detects 'cheapest' superlatives", () => {
      expect(classifyQuestion("Cheapest option?")).toBe("comparison");
    });
  });

  describe("temporal questions", () => {
    it("detects 'when did' questions", () => {
      expect(classifyQuestion("When did you start learning piano?")).toBe(
        "temporal"
      );
    });

    it("detects 'what date' questions", () => {
      expect(classifyQuestion("What date did you visit?")).toBe("temporal");
    });

    it("detects 'how long ago' questions", () => {
      expect(classifyQuestion("How long ago did you move?")).toBe("temporal");
    });

    it("detects 'what day' questions", () => {
      expect(classifyQuestion("What day did the meeting happen?")).toBe(
        "temporal"
      );
    });
  });

  describe("factual questions (default)", () => {
    it("classifies generic fact questions as factual", () => {
      expect(classifyQuestion("What is your dog's name?")).toBe("factual");
    });

    it("classifies location questions as factual", () => {
      expect(classifyQuestion("Where do you work?")).toBe("factual");
    });

    it("classifies simple queries as factual", () => {
      expect(classifyQuestion("Tell me about your vacation")).toBe("factual");
    });
  });

  describe("priority edge cases", () => {
    it("'how many days' is duration, not counting (duration check runs first)", () => {
      // This is the key edge case: the isDurationQuestion regex matches
      // "how many days" before isCountingQuestion can match "how many"
      const result = classifyQuestion("How many days did you spend hiking?");
      expect(result).toBe("duration");
      expect(result).not.toBe("counting");
    });

    it("'how many weeks' is duration, not counting", () => {
      expect(classifyQuestion("How many weeks were you on vacation?")).toBe(
        "duration"
      );
    });
  });
});

// ---------------------------------------------------------------------------
// getProcedure
// ---------------------------------------------------------------------------

describe("getProcedure", () => {
  const allTypes: QuestionType[] = [
    "counting",
    "duration",
    "comparison",
    "temporal",
    "factual",
  ];

  for (const type of allTypes) {
    it(`returns a non-empty procedure string for "${type}" (>50 chars)`, () => {
      const procedure = getProcedure(type);
      expect(typeof procedure).toBe("string");
      expect(procedure.length).toBeGreaterThan(50);
    });
  }

  it("counting procedure mentions search_events", () => {
    expect(getProcedure("counting")).toContain("search_events");
  });

  it("factual procedure mentions get_session", () => {
    expect(getProcedure("factual")).toContain("get_session");
  });

  it("temporal procedure mentions date", () => {
    const procedure = getProcedure("temporal");
    expect(procedure.toLowerCase()).toContain("date");
  });
});

// ---------------------------------------------------------------------------
// getToolSubset
// ---------------------------------------------------------------------------

describe("getToolSubset", () => {
  it("counting includes search_events, count_sessions, search_sessions, get_session", () => {
    const tools = getToolSubset("counting");
    expect(tools).toContain("search_events");
    expect(tools).toContain("count_sessions");
    expect(tools).toContain("search_sessions");
    expect(tools).toContain("get_session");
  });

  it("duration includes search_events but NOT count_sessions", () => {
    const tools = getToolSubset("duration");
    expect(tools).toContain("search_events");
    expect(tools).not.toContain("count_sessions");
  });

  it("temporal includes search_by_date", () => {
    const tools = getToolSubset("temporal");
    expect(tools).toContain("search_by_date");
  });

  it("factual includes search_knowledge", () => {
    const tools = getToolSubset("factual");
    expect(tools).toContain("search_knowledge");
  });

  it("comparison does NOT include search_by_date", () => {
    const tools = getToolSubset("comparison");
    expect(tools).not.toContain("search_by_date");
  });
});

// ---------------------------------------------------------------------------
// isComparisonQuestion
// ---------------------------------------------------------------------------

describe("isComparisonQuestion", () => {
  describe("detects comparison patterns", () => {
    it("detects 'which...most' pattern", () => {
      expect(isComparisonQuestion("Which restaurant did you visit most?")).toBe(
        true
      );
    });

    it("detects 'which...least' pattern", () => {
      expect(
        isComparisonQuestion("Which tool did you use least?")
      ).toBe(true);
    });

    it("detects 'most expensive' superlative", () => {
      expect(isComparisonQuestion("What was the most expensive item?")).toBe(
        true
      );
    });

    it("detects 'cheapest' superlative", () => {
      expect(isComparisonQuestion("What was the cheapest option?")).toBe(true);
    });

    it("detects 'highest' superlative", () => {
      expect(isComparisonQuestion("Which had the highest score?")).toBe(true);
    });

    it("detects 'lowest' superlative", () => {
      expect(isComparisonQuestion("What was the lowest rating?")).toBe(true);
    });

    it("detects 'most often' pattern", () => {
      expect(isComparisonQuestion("What did you eat most often?")).toBe(true);
    });
  });

  describe("rejects non-comparison questions", () => {
    it("rejects simple factual questions", () => {
      expect(isComparisonQuestion("What is your dog's name?")).toBe(false);
    });

    it("rejects counting questions", () => {
      expect(isComparisonQuestion("How many books did you read?")).toBe(false);
    });

    it("rejects temporal questions", () => {
      expect(isComparisonQuestion("When did you start the project?")).toBe(
        false
      );
    });

    it("rejects generic questions about preferences", () => {
      expect(isComparisonQuestion("What do you prefer for lunch?")).toBe(false);
    });
  });
});
