import { describe, it, expect, vi } from "vitest";
import {
  smartSummarize,
  heuristicSmartSummary,
} from "../../../src/extensions/llm-extraction/smart-summarizer.js";
import type { LlmProvider } from "../../../src/extensions/llm-extraction/llm-provider.js";
import type { ParsedSession } from "../../../src/parsers/session-parser.js";
import { openDatabase } from "../../../src/storage/database.js";

function makeSession(overrides: Partial<ParsedSession> = {}): ParsedSession {
  return {
    sessionId: "test-session-1",
    project: "test-project",
    cwd: "/home/user/project",
    gitBranch: "main",
    startTime: Date.now() - 60000,
    endTime: Date.now(),
    messages: [
      {
        role: "user",
        text: "Help me set up TypeScript with strict mode",
        hasCode: false,
        toolNames: [],
        toolInputSnippets: [],
      },
      {
        role: "assistant",
        text: "I'll configure tsconfig.json with strict mode enabled and add the necessary dev dependencies.",
        hasCode: true,
        toolNames: ["write_file"],
        toolInputSnippets: ["/tsconfig.json"],
      },
    ],
    ...overrides,
  };
}

function makeProvider(response: string): LlmProvider {
  return {
    name: "test-gemini",
    complete: vi.fn().mockResolvedValue(response),
  };
}

function makeFailingProvider(): LlmProvider {
  return {
    name: "test-gemini",
    complete: vi.fn().mockRejectedValue(new Error("API error")),
  };
}

const VALID_SUMMARY_RESPONSE = JSON.stringify({
  topic: "Setting up TypeScript with strict mode configuration",
  keyDecisions: ["Enable strict mode in tsconfig.json"],
  solutionsFound: ["Configured TypeScript strict mode for better type safety"],
  patterns: ["Always start new projects with strict mode enabled"],
  actionableLearnings: [
    "Use strict mode from day one to catch type errors early",
  ],
});

describe("smartSummarize", () => {
  it("should generate a smart summary from LLM response", async () => {
    const session = makeSession();
    const provider = makeProvider(VALID_SUMMARY_RESPONSE);

    const summary = await smartSummarize(session, provider);

    expect(summary.llmGenerated).toBe(true);
    expect(summary.topicSummary).toContain("TypeScript");
    expect(summary.keyDecisions).toHaveLength(1);
    expect(summary.solutionsFound).toHaveLength(1);
    expect(summary.patterns).toHaveLength(1);
    expect(summary.actionableLearnings).toHaveLength(1);
    // Should also have base heuristic fields
    expect(summary.sessionId).toBe("test-session-1");
    expect(summary.project).toBe("test-project");
    expect(summary.messageCount).toBeGreaterThan(0);
  });

  it("should fall back to heuristic summary on LLM failure", async () => {
    const session = makeSession();
    const provider = makeFailingProvider();

    const summary = await smartSummarize(session, provider);

    expect(summary.llmGenerated).toBe(false);
    expect(summary.topicSummary).toBeTruthy();
    expect(summary.keyDecisions).toEqual([]);
    expect(summary.solutionsFound).toEqual([]);
    expect(summary.sessionId).toBe("test-session-1");
  });

  it("should handle markdown-fenced JSON response", async () => {
    const fenced = "```json\n" + VALID_SUMMARY_RESPONSE + "\n```";
    const session = makeSession();
    const provider = makeProvider(fenced);

    const summary = await smartSummarize(session, provider);
    expect(summary.llmGenerated).toBe(true);
    expect(summary.topicSummary).toContain("TypeScript");
  });

  it("should cap arrays at 5 items", async () => {
    const response = JSON.stringify({
      topic: "Test topic",
      keyDecisions: ["D1", "D2", "D3", "D4", "D5", "D6", "D7"],
      solutionsFound: [],
      patterns: [],
      actionableLearnings: [],
    });
    const session = makeSession();
    const provider = makeProvider(response);

    const summary = await smartSummarize(session, provider);
    expect(summary.keyDecisions.length).toBeLessThanOrEqual(5);
  });

  it("should handle missing arrays gracefully", async () => {
    const response = JSON.stringify({
      topic: "Test topic",
      // Missing all arrays
    });
    const session = makeSession();
    const provider = makeProvider(response);

    const summary = await smartSummarize(session, provider);
    expect(summary.llmGenerated).toBe(true);
    expect(summary.keyDecisions).toEqual([]);
    expect(summary.solutionsFound).toEqual([]);
    expect(summary.patterns).toEqual([]);
    expect(summary.actionableLearnings).toEqual([]);
  });

  it("should fall back when topic is missing", async () => {
    const response = JSON.stringify({
      keyDecisions: ["D1"],
    });
    const session = makeSession();
    const provider = makeProvider(response);

    const summary = await smartSummarize(session, provider);
    // Missing topic should cause fallback to heuristic
    expect(summary.llmGenerated).toBe(false);
  });

  it("should call provider with correct options", async () => {
    const session = makeSession();
    const provider = makeProvider(VALID_SUMMARY_RESPONSE);

    await smartSummarize(session, provider);

    expect(provider.complete).toHaveBeenCalledOnce();
    const [, options] = (provider.complete as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(options.maxTokens).toBe(4096);
    expect(options.temperature).toBe(0.1);
    expect(options.timeoutMs).toBe(30000);
  });

  it("should truncate messages to 300 chars each", async () => {
    const longMessage = "A".repeat(500);
    const session = makeSession({
      messages: [
        {
          role: "user",
          text: longMessage,
          hasCode: false,
          toolNames: [],
          toolInputSnippets: [],
        },
      ],
    });
    const provider = makeProvider(VALID_SUMMARY_RESPONSE);

    await smartSummarize(session, provider);

    const prompt = (provider.complete as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    // The transcript portion should not contain the full 500 chars of the message
    const lines = prompt.split("\n");
    const lastLine = lines[lines.length - 1];
    // [USER] prefix + 300 chars max
    expect(lastLine.length).toBeLessThanOrEqual(307); // [USER] = 7 chars + 300
  });

  it("should capture training data when db is provided", async () => {
    const db = openDatabase(":memory:");
    const session = makeSession();
    const provider = makeProvider(VALID_SUMMARY_RESPONSE);

    await smartSummarize(session, provider, db);

    const row = db.prepare("SELECT * FROM training_data WHERE task_type = 'summarization'").get() as {
      task_type: string;
      model_used: string;
      quality_score: number;
    } | undefined;
    expect(row).toBeDefined();
    expect(row!.task_type).toBe("summarization");
    expect(row!.model_used).toBe("test-gemini");
    expect(row!.quality_score).toBe(1.0);

    db.close();
  });

  it("should not fail summarization when training capture throws", async () => {
    const db = openDatabase(":memory:");
    db.close();

    const session = makeSession();
    const provider = makeProvider(VALID_SUMMARY_RESPONSE);

    // Should not throw
    const summary = await smartSummarize(session, provider, db);
    expect(summary.llmGenerated).toBe(true);
  });
});

describe("heuristicSmartSummary", () => {
  it("should create a SmartSummary from base SessionSummary", () => {
    const base = {
      sessionId: "s1",
      project: "p1",
      projectName: "p1",
      startTime: 1000,
      endTime: 2000,
      duration: 1000,
      messageCount: 5,
      userMessageCount: 3,
      topic: "Test topic",
      keyTopics: ["typescript"],
      toolsUsed: ["write_file"],
      filesReferenced: ["/tsconfig.json"],
      hasCodeChanges: true,
      lastUserMessage: "Done",
    };

    const smart = heuristicSmartSummary(base);

    expect(smart.llmGenerated).toBe(false);
    expect(smart.topicSummary).toBe("Test topic");
    expect(smart.keyDecisions).toEqual([]);
    expect(smart.solutionsFound).toEqual([]);
    expect(smart.patterns).toEqual([]);
    expect(smart.actionableLearnings).toEqual([]);
    expect(smart.sessionId).toBe("s1");
  });
});
