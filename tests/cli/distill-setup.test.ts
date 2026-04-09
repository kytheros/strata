import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runDistillSetup } from "../../src/cli/distill.js";

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(() => "{}"),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

vi.mock("child_process", () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
}));

// Mock the global fetch used for Ollama /api/tags check
const originalFetch = global.fetch;

describe("runDistillSetup", () => {
  let writtenConfig: Record<string, unknown> | null = null;

  beforeEach(async () => {
    writtenConfig = null;
    const fs = await import("fs");
    vi.mocked(fs.writeFileSync).mockImplementation((path, content) => {
      if (typeof path === "string" && path.endsWith("config.json")) {
        writtenConfig = JSON.parse(String(content));
      }
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it("writes distillation.enabled=true with gemma4 defaults on success", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ models: [{ name: "gemma4:e4b" }, { name: "gemma4:e2b" }] }),
    })) as unknown as typeof fetch;

    const { execSync } = await import("child_process");
    vi.mocked(execSync).mockReturnValue(Buffer.from(""));

    await runDistillSetup({ skipPull: true });

    expect(writtenConfig).not.toBeNull();
    const dcfg = (writtenConfig as { distillation?: Record<string, unknown> }).distillation;
    expect(dcfg).toBeDefined();
    expect(dcfg!.enabled).toBe(true);
    expect(dcfg!.extractionModel).toBe("gemma4:e4b");
    expect(dcfg!.summarizationModel).toBe("gemma4:e4b");
    expect(dcfg!.conflictResolutionModel).toBe("gemma4:e2b");
  });

  it("throws a clear error when Ollama is not reachable", async () => {
    global.fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    await expect(runDistillSetup({ skipPull: true })).rejects.toThrow(/Ollama not reachable/);
    expect(writtenConfig).toBeNull();
  });

  it("preserves unrelated config keys when merging", async () => {
    const fs = await import("fs");
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ unrelated: { keep: true }, otherKey: "xyz" })
    );
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ models: [{ name: "gemma4:e4b" }, { name: "gemma4:e2b" }] }),
    })) as unknown as typeof fetch;

    await runDistillSetup({ skipPull: true });

    expect(writtenConfig).not.toBeNull();
    expect((writtenConfig as Record<string, unknown>).unrelated).toEqual({ keep: true });
    expect((writtenConfig as Record<string, unknown>).otherKey).toBe("xyz");
  });
});

import { runDistillTest } from "../../src/cli/distill.js";

describe("runDistillTest", () => {
  let logs: string[] = [];
  let originalLog: typeof console.log;

  beforeEach(() => {
    logs = [];
    originalLog = console.log;
    console.log = (msg: unknown) => { logs.push(String(msg)); };
  });

  afterEach(() => {
    console.log = originalLog;
    vi.clearAllMocks();
  });

  it("reports all-green when all three stages return valid JSON", async () => {
    // Mock the providers to return valid JSON for each stage.
    const mockExtractionProvider = {
      name: "hybrid",
      complete: vi.fn().mockResolvedValue(
        JSON.stringify({ entries: [{ type: "fact", summary: "test" }] })
      ),
    };
    const mockSummarizationProvider = {
      name: "hybrid",
      complete: vi.fn().mockResolvedValue(
        JSON.stringify({ topic: "test topic", keyDecisions: [] })
      ),
    };
    const mockConflictProvider = {
      name: "hybrid",
      complete: vi.fn().mockResolvedValue(
        JSON.stringify({ shouldAdd: true, actions: [] })
      ),
    };

    vi.doMock("../../src/extensions/llm-extraction/provider-factory.js", () => ({
      getExtractionProvider: vi.fn().mockResolvedValue(mockExtractionProvider),
      getSummarizationProvider: vi.fn().mockResolvedValue(mockSummarizationProvider),
      getConflictResolutionProvider: vi.fn().mockResolvedValue(mockConflictProvider),
      validateExtractionOutput: vi.fn().mockReturnValue(true),
      validateSummarizationOutput: vi.fn().mockReturnValue(true),
      validateConflictResolutionOutput: vi.fn().mockReturnValue(true),
    }));

    const { runDistillTest: reimported } = await import("../../src/cli/distill.js");
    await reimported();

    const joined = logs.join("\n");
    expect(joined).toContain("Extraction test");
    expect(joined).toContain("Summarization test");
    expect(joined).toContain("Conflict resolution test");
    expect(joined).toContain("All checks passed");
    expect(joined).not.toContain("FAIL");
  });

  it("reports failure when a provider returns invalid JSON", async () => {
    const mockBadProvider = {
      name: "hybrid",
      complete: vi.fn().mockResolvedValue("not json at all"),
    };

    vi.doMock("../../src/extensions/llm-extraction/provider-factory.js", () => ({
      getExtractionProvider: vi.fn().mockResolvedValue(mockBadProvider),
      getSummarizationProvider: vi.fn().mockResolvedValue(mockBadProvider),
      getConflictResolutionProvider: vi.fn().mockResolvedValue(mockBadProvider),
      validateExtractionOutput: vi.fn().mockReturnValue(false),
      validateSummarizationOutput: vi.fn().mockReturnValue(false),
      validateConflictResolutionOutput: vi.fn().mockReturnValue(false),
    }));

    const { runDistillTest: reimported } = await import("../../src/cli/distill.js");
    await reimported();

    const joined = logs.join("\n");
    expect(joined).toContain("FAIL");
  });
});
