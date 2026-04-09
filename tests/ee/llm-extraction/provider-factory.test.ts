import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetGeminiProviderCache } from "../../../src/extensions/llm-extraction/gemini-provider.js";
import {
  getConflictResolutionProvider,
  getExtractionProvider,
  getSummarizationProvider,
  loadDistillConfig,
  validateConflictResolutionOutput,
  validateExtractionOutput,
  validateSummarizationOutput,
} from "../../../src/extensions/llm-extraction/provider-factory.js";
import { HybridProvider } from "../../../src/extensions/llm-extraction/hybrid-provider.js";

// Mock fs and os modules for config file reading
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

import { existsSync, readFileSync } from "fs";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

describe("validateExtractionOutput", () => {
  it("should return true for valid extraction JSON", () => {
    const valid = JSON.stringify({ entries: [{ type: "decision", summary: "test" }] });
    expect(validateExtractionOutput(valid)).toBe(true);
  });

  it("should return true for empty entries array", () => {
    expect(validateExtractionOutput(JSON.stringify({ entries: [] }))).toBe(true);
  });

  it("should return false for non-JSON string", () => {
    expect(validateExtractionOutput("not json")).toBe(false);
  });

  it("should return false for JSON without entries array", () => {
    expect(validateExtractionOutput(JSON.stringify({ results: [] }))).toBe(false);
  });

  it("should return false for JSON where entries is not an array", () => {
    expect(validateExtractionOutput(JSON.stringify({ entries: "not an array" }))).toBe(false);
  });
});

describe("validateSummarizationOutput", () => {
  it("should return true for valid summarization JSON", () => {
    const valid = JSON.stringify({
      topic: "Implemented new feature",
      keyDecisions: [],
      solutionsFound: [],
      patterns: [],
      actionableLearnings: [],
    });
    expect(validateSummarizationOutput(valid)).toBe(true);
  });

  it("should return false for non-JSON string", () => {
    expect(validateSummarizationOutput("not json")).toBe(false);
  });

  it("should return false for JSON without topic", () => {
    expect(validateSummarizationOutput(JSON.stringify({ keyDecisions: [] }))).toBe(false);
  });

  it("should return false for JSON where topic is empty", () => {
    expect(validateSummarizationOutput(JSON.stringify({ topic: "" }))).toBe(false);
  });

  it("should return false for JSON where topic is not a string", () => {
    expect(validateSummarizationOutput(JSON.stringify({ topic: 42 }))).toBe(false);
  });
});

describe("loadDistillConfig", () => {
  beforeEach(() => {
    vi.stubEnv("STRATA_DATA_DIR", "/tmp/test-strata");
    mockExistsSync.mockReset();
    mockReadFileSync.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("should return null when config file does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    expect(loadDistillConfig()).toBeNull();
  });

  it("should return null when distillation is not enabled", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ distillation: { enabled: false } })
    );
    expect(loadDistillConfig()).toBeNull();
  });

  it("should return config with defaults when distillation is enabled", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ distillation: { enabled: true } })
    );

    const config = loadDistillConfig();
    expect(config).not.toBeNull();
    expect(config!.enabled).toBe(true);
    expect(config!.localUrl).toBe("http://localhost:11434");
    expect(config!.extractionModel).toBe("gemma4:e4b");
    expect(config!.summarizationModel).toBe("gemma4:e4b");
    expect(config!.fallback).toBe("gemini");
  });

  it("should return config with custom values", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        distillation: {
          enabled: true,
          localUrl: "http://localhost:11435",
          extractionModel: "custom-extract",
          summarizationModel: "custom-summary",
          fallback: "openai",
        },
      })
    );

    const config = loadDistillConfig();
    expect(config).not.toBeNull();
    expect(config!.localUrl).toBe("http://localhost:11435");
    expect(config!.extractionModel).toBe("custom-extract");
    expect(config!.summarizationModel).toBe("custom-summary");
    expect(config!.fallback).toBe("openai");
  });

  it("should return null when config file is invalid JSON", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("not valid json {{{");
    expect(loadDistillConfig()).toBeNull();
  });

  it("should return null when distillation key is missing", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ otherSetting: true }));
    expect(loadDistillConfig()).toBeNull();
  });
});

describe("loadDistillConfig defaults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses gemma4:e4b as default extractionModel", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ distillation: { enabled: true } }));
    const config = loadDistillConfig();
    expect(config).not.toBeNull();
    expect(config!.extractionModel).toBe("gemma4:e4b");
  });

  it("uses gemma4:e4b as default summarizationModel", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ distillation: { enabled: true } }));
    const config = loadDistillConfig();
    expect(config!.summarizationModel).toBe("gemma4:e4b");
  });

  it("uses gemma4:e2b as default conflictResolutionModel", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ distillation: { enabled: true } }));
    const config = loadDistillConfig();
    expect(config!.conflictResolutionModel).toBe("gemma4:e2b");
  });

  it("respects user-provided model overrides", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        distillation: {
          enabled: true,
          extractionModel: "custom-extract",
          summarizationModel: "custom-sum",
          conflictResolutionModel: "custom-conflict",
        },
      })
    );
    const config = loadDistillConfig();
    expect(config!.extractionModel).toBe("custom-extract");
    expect(config!.summarizationModel).toBe("custom-sum");
    expect(config!.conflictResolutionModel).toBe("custom-conflict");
  });

  it("falls back conflictResolutionModel to extractionModel when only extractionModel is set", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        distillation: {
          enabled: true,
          extractionModel: "mymodel:latest",
        },
      })
    );
    const config = loadDistillConfig();
    expect(config!.extractionModel).toBe("mymodel:latest");
    expect(config!.conflictResolutionModel).toBe("mymodel:latest");
  });
});

describe("getExtractionProvider", () => {
  beforeEach(() => {
    resetGeminiProviderCache();
    mockExistsSync.mockReset();
    mockReadFileSync.mockReset();
  });

  afterEach(() => {
    resetGeminiProviderCache();
    vi.unstubAllEnvs();
  });

  it("should return null when no GEMINI_API_KEY and no distill config", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("STRATA_DATA_DIR", "/tmp/test-strata");
    mockExistsSync.mockReturnValue(false);

    const provider = await getExtractionProvider();
    expect(provider).toBeNull();
  });

  it("should return GeminiProvider when GEMINI_API_KEY set and no distill config", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key-123");
    vi.stubEnv("STRATA_DATA_DIR", "/tmp/test-strata");
    mockExistsSync.mockReturnValue(false);

    const provider = await getExtractionProvider();
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe("gemini");
  });

  it("should return HybridProvider when GEMINI_API_KEY set and distill enabled", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key-123");
    vi.stubEnv("STRATA_DATA_DIR", "/tmp/test-strata");
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ distillation: { enabled: true } })
    );

    const provider = await getExtractionProvider();
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe("hybrid");
    expect(provider).toBeInstanceOf(HybridProvider);
  });

  it("should return null when distill enabled but no GEMINI_API_KEY (need frontier for fallback)", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("STRATA_DATA_DIR", "/tmp/test-strata");
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ distillation: { enabled: true } })
    );

    const provider = await getExtractionProvider();
    // Without GEMINI_API_KEY, getCachedGeminiProvider returns null,
    // so the hybrid path is skipped and it returns null.
    expect(provider).toBeNull();
  });

  it("should return based on GEMINI_API_KEY only when config file missing", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key-123");
    vi.stubEnv("STRATA_DATA_DIR", "/tmp/test-strata");
    mockExistsSync.mockReturnValue(false);

    const provider = await getExtractionProvider();
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe("gemini");
  });
});

describe("getSummarizationProvider", () => {
  beforeEach(() => {
    resetGeminiProviderCache();
    mockExistsSync.mockReset();
    mockReadFileSync.mockReset();
  });

  afterEach(() => {
    resetGeminiProviderCache();
    vi.unstubAllEnvs();
  });

  it("should return null when no GEMINI_API_KEY and no distill config", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("STRATA_DATA_DIR", "/tmp/test-strata");
    mockExistsSync.mockReturnValue(false);

    const provider = await getSummarizationProvider();
    expect(provider).toBeNull();
  });

  it("should return GeminiProvider when GEMINI_API_KEY set and no distill config", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key-123");
    vi.stubEnv("STRATA_DATA_DIR", "/tmp/test-strata");
    mockExistsSync.mockReturnValue(false);

    const provider = await getSummarizationProvider();
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe("gemini");
  });

  it("should return HybridProvider when GEMINI_API_KEY set and distill enabled", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key-123");
    vi.stubEnv("STRATA_DATA_DIR", "/tmp/test-strata");
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        distillation: {
          enabled: true,
          extractionModel: "extract-model",
          summarizationModel: "summary-model",
        },
      })
    );

    const provider = await getSummarizationProvider();
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe("hybrid");
    expect(provider).toBeInstanceOf(HybridProvider);
  });

  it("should use different model names for extraction vs summarization", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key-123");
    vi.stubEnv("STRATA_DATA_DIR", "/tmp/test-strata");
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        distillation: {
          enabled: true,
          extractionModel: "extract-7b",
          summarizationModel: "summary-7b",
        },
      })
    );

    // Both return HybridProvider but configured differently
    const extractionProvider = await getExtractionProvider();
    resetGeminiProviderCache(); // Reset to avoid cached null from different env stub
    vi.stubEnv("GEMINI_API_KEY", "test-key-123");
    const summarizationProvider = await getSummarizationProvider();

    expect(extractionProvider).not.toBeNull();
    expect(summarizationProvider).not.toBeNull();
    expect(extractionProvider!.name).toBe("hybrid");
    expect(summarizationProvider!.name).toBe("hybrid");

    // They are separate instances (different model config)
    expect(extractionProvider).not.toBe(summarizationProvider);
  });

  it("should return null when distill enabled but no GEMINI_API_KEY", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("STRATA_DATA_DIR", "/tmp/test-strata");
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ distillation: { enabled: true } })
    );

    const provider = await getSummarizationProvider();
    expect(provider).toBeNull();
  });
});

describe("validateConflictResolutionOutput", () => {
  it("returns true for valid shouldAdd-only resolution", () => {
    expect(
      validateConflictResolutionOutput(JSON.stringify({ shouldAdd: true, actions: [] }))
    ).toBe(true);
  });

  it("returns true for resolution with delete actions", () => {
    const valid = JSON.stringify({
      shouldAdd: false,
      actions: [{ action: "delete", targetId: "k-123" }],
    });
    expect(validateConflictResolutionOutput(valid)).toBe(true);
  });

  it("returns true for resolution with update actions", () => {
    const valid = JSON.stringify({
      shouldAdd: false,
      actions: [{ action: "update", targetId: "k-123", newSummary: "updated" }],
    });
    expect(validateConflictResolutionOutput(valid)).toBe(true);
  });

  it("returns false for non-JSON input", () => {
    expect(validateConflictResolutionOutput("not json")).toBe(false);
  });

  it("returns false when shouldAdd is missing", () => {
    expect(validateConflictResolutionOutput(JSON.stringify({ actions: [] }))).toBe(false);
  });

  it("returns false when actions is not an array", () => {
    expect(
      validateConflictResolutionOutput(JSON.stringify({ shouldAdd: true, actions: "bad" }))
    ).toBe(false);
  });
});

describe("getConflictResolutionProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetGeminiProviderCache();
  });

  afterEach(() => {
    delete process.env.GEMINI_API_KEY;
  });

  it("returns null when GEMINI_API_KEY is unset and distillation is disabled", async () => {
    mockExistsSync.mockReturnValue(false);
    const provider = await getConflictResolutionProvider();
    expect(provider).toBeNull();
  });

  it("returns a gemini provider when key set but distillation disabled", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    mockExistsSync.mockReturnValue(false);
    const provider = await getConflictResolutionProvider();
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe("gemini");
  });

  it("returns HybridProvider using conflictResolutionModel when distillation is enabled", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        distillation: {
          enabled: true,
          conflictResolutionModel: "gemma4:e2b",
        },
      })
    );
    const provider = await getConflictResolutionProvider();
    expect(provider).toBeInstanceOf(HybridProvider);
  });
});
