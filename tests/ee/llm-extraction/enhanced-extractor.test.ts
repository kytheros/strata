import { describe, it, expect, vi } from "vitest";
import { enhancedExtract } from "../../../src/extensions/llm-extraction/enhanced-extractor.js";
import type { LlmProvider } from "../../../src/extensions/llm-extraction/llm-provider.js";
import type { ParsedSession } from "../../../src/parsers/session-parser.js";
import { openDatabase } from "../../../src/storage/database.js";

function makeSession(overrides: Partial<ParsedSession> = {}): ParsedSession {
  return {
    sessionId: "test-session-1",
    project: "test-project",
    cwd: "/home/user/project",
    gitBranch: "main",
    startTime: Date.now(),
    endTime: Date.now() + 60000,
    messages: [
      {
        role: "user",
        text: "I decided to use TypeScript instead of JavaScript for better type safety",
        hasCode: false,
        toolNames: [],
        toolInputSnippets: [],
      },
      {
        role: "assistant",
        text: "Good choice. I'll set up the TypeScript config with strict mode enabled.",
        hasCode: false,
        toolNames: [],
        toolInputSnippets: [],
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

const VALID_EXTRACTION_RESPONSE = JSON.stringify({
  entries: [
    {
      type: "decision",
      summary: "Use TypeScript instead of JavaScript for better type safety",
      details: "TypeScript was chosen for strict mode and type checking",
      tags: ["typescript", "tooling"],
      relatedFiles: ["/tsconfig.json"],
    },
    {
      type: "pattern",
      summary: "Enable strict mode in TypeScript configuration",
      details: "Strict mode catches more errors at compile time",
      tags: ["typescript"],
      relatedFiles: [],
    },
  ],
});

describe("enhancedExtract", () => {
  it("should extract knowledge entries from LLM response", async () => {
    const session = makeSession();
    const provider = makeProvider(VALID_EXTRACTION_RESPONSE);

    const entries = await enhancedExtract(session, provider);

    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries[0].type).toBe("decision");
    expect(entries[0].summary).toContain("TypeScript");
    expect(entries[0].project).toBe("test-project");
    expect(entries[0].sessionId).toBe("test-session-1");
    expect(entries[0].id).toBeTruthy();
  });

  it("should fall back to heuristic extraction on LLM failure", async () => {
    const session = makeSession();
    const provider = makeFailingProvider();

    const entries = await enhancedExtract(session, provider);

    // Heuristic extractor may find entries via regex patterns
    expect(Array.isArray(entries)).toBe(true);
    // Should not throw
  });

  it("should handle markdown-fenced JSON response", async () => {
    const fenced = "```json\n" + VALID_EXTRACTION_RESPONSE + "\n```";
    const session = makeSession();
    const provider = makeProvider(fenced);

    const entries = await enhancedExtract(session, provider);
    expect(entries.length).toBeGreaterThanOrEqual(2);
  });

  it("should handle response with preamble text before JSON", async () => {
    const withPreamble =
      "Here is the analysis:\n\n" + VALID_EXTRACTION_RESPONSE;
    const session = makeSession();
    const provider = makeProvider(withPreamble);

    const entries = await enhancedExtract(session, provider);
    expect(entries.length).toBeGreaterThanOrEqual(2);
  });

  it("should cap entries at 10", async () => {
    const manyEntries = {
      entries: Array.from({ length: 15 }, (_, i) => ({
        type: "decision",
        summary: `Decision ${i + 1}`,
        tags: [],
        relatedFiles: [],
      })),
    };
    const session = makeSession();
    const provider = makeProvider(JSON.stringify(manyEntries));

    const entries = await enhancedExtract(session, provider);
    const llmEntries = entries.filter((e) => e.summary.startsWith("Decision"));
    expect(llmEntries.length).toBeLessThanOrEqual(10);
  });

  it("should filter invalid entry types", async () => {
    const response = JSON.stringify({
      entries: [
        { type: "decision", summary: "Valid entry", tags: [] },
        { type: "invalid_type", summary: "Invalid entry", tags: [] },
        { type: "solution", summary: "Also valid", tags: [] },
      ],
    });
    const session = makeSession();
    const provider = makeProvider(response);

    const entries = await enhancedExtract(session, provider);
    const types = entries.map((e) => e.type);
    expect(types).not.toContain("invalid_type");
  });

  it("should truncate summaries to 120 chars", async () => {
    const longSummary = "A".repeat(200);
    const response = JSON.stringify({
      entries: [{ type: "decision", summary: longSummary, tags: [] }],
    });
    const session = makeSession();
    const provider = makeProvider(response);

    const entries = await enhancedExtract(session, provider);
    const llmEntry = entries.find((e) => e.summary.startsWith("AAA"));
    expect(llmEntry).toBeDefined();
    expect(llmEntry!.summary.length).toBeLessThanOrEqual(120);
  });

  it("should repair truncated JSON with complete objects", async () => {
    // Simulate a truncated JSON response that was cut mid-entry
    const truncated = `{"entries": [
      {"type": "decision", "summary": "First entry", "tags": ["ts"]},
      {"type": "solution", "summary": "Second entry", "tags": ["fix"]},
      {"type": "pattern", "summary": "Trun`;

    const session = makeSession();
    const provider = makeProvider(truncated);

    const entries = await enhancedExtract(session, provider);
    // Should have salvaged at least the first two complete entries
    const llmEntries = entries.filter(
      (e) =>
        e.summary === "First entry" || e.summary === "Second entry"
    );
    expect(llmEntries.length).toBe(2);
  });

  it("should handle procedure type with JSON details", async () => {
    const response = JSON.stringify({
      entries: [
        {
          type: "procedure",
          summary: "Deploy to production",
          details: JSON.stringify({
            steps: ["Build", "Test", "Deploy"],
            prerequisites: ["CI green"],
          }),
          tags: ["deployment"],
        },
      ],
    });
    const session = makeSession();
    const provider = makeProvider(response);

    const entries = await enhancedExtract(session, provider);
    const proc = entries.find((e) => e.type === "procedure");
    expect(proc).toBeDefined();
    const details = JSON.parse(proc!.details);
    expect(details.steps).toEqual(["Build", "Test", "Deploy"]);
  });

  it("should wrap plain string procedure details in steps array", async () => {
    const response = JSON.stringify({
      entries: [
        {
          type: "procedure",
          summary: "Run tests",
          details: "npm test",
          tags: [],
        },
      ],
    });
    const session = makeSession();
    const provider = makeProvider(response);

    const entries = await enhancedExtract(session, provider);
    const proc = entries.find((e) => e.type === "procedure");
    expect(proc).toBeDefined();
    const details = JSON.parse(proc!.details);
    expect(details.steps).toEqual(["npm test"]);
  });

  it("should merge LLM and heuristic entries, prioritizing LLM", async () => {
    // The session has text that the heuristic extractor can match
    const session = makeSession({
      messages: [
        {
          role: "user",
          text: "I decided to use Yarn instead of npm for workspaces support",
          hasCode: false,
          toolNames: [],
          toolInputSnippets: [],
        },
        {
          role: "assistant",
          text: "Good choice. The fix was to update the lockfile after switching.",
          hasCode: false,
          toolNames: [],
          toolInputSnippets: [],
        },
      ],
    });

    const response = JSON.stringify({
      entries: [
        {
          type: "decision",
          summary: "Use Yarn instead of npm for workspaces support",
          tags: ["tooling"],
        },
      ],
    });
    const provider = makeProvider(response);

    const entries = await enhancedExtract(session, provider);
    // LLM entry should be present
    expect(entries.some((e) => e.summary.includes("Yarn"))).toBe(true);
  });

  it("should call provider with correct options", async () => {
    const session = makeSession();
    const provider = makeProvider(VALID_EXTRACTION_RESPONSE);

    await enhancedExtract(session, provider);

    expect(provider.complete).toHaveBeenCalledOnce();
    const [, options] = (provider.complete as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(options.maxTokens).toBe(4096);
    expect(options.temperature).toBe(0.1);
    expect(options.timeoutMs).toBe(30000);
  });

  it("should capture training data when db is provided", async () => {
    const db = openDatabase(":memory:");
    const session = makeSession();
    const provider = makeProvider(VALID_EXTRACTION_RESPONSE);

    await enhancedExtract(session, provider, db);

    // Verify training data was captured
    const row = db.prepare("SELECT * FROM training_data WHERE task_type = 'extraction'").get() as {
      task_type: string;
      model_used: string;
      quality_score: number;
    } | undefined;
    expect(row).toBeDefined();
    expect(row!.task_type).toBe("extraction");
    expect(row!.model_used).toBe("test-gemini");
    expect(row!.quality_score).toBe(1.0);

    db.close();
  });

  it("should not capture training data when db is not provided", async () => {
    const session = makeSession();
    const provider = makeProvider(VALID_EXTRACTION_RESPONSE);

    // Should not throw even without db
    const entries = await enhancedExtract(session, provider);
    expect(entries.length).toBeGreaterThan(0);
  });

  it("should not fail extraction when training capture throws", async () => {
    // Use a closed database to simulate capture failure
    const db = openDatabase(":memory:");
    db.close();

    const session = makeSession();
    const provider = makeProvider(VALID_EXTRACTION_RESPONSE);

    // Should not throw — capture failure is swallowed
    const entries = await enhancedExtract(session, provider, db);
    expect(entries.length).toBeGreaterThan(0);
  });
});
