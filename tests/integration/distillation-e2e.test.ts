/**
 * End-to-end integration tests for the distillation subsystem.
 *
 * These tests validate the full user journey from fresh install through
 * training data accumulation, export, hybrid provider activation, and
 * secret sanitization in the pipeline.
 *
 * External dependencies (Gemini API, Ollama, GPU) are mocked, but all
 * internal wiring between modules is exercised with real databases.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Isolate the API-key lookup from the developer's ~/.strata/config.json.
// `loadGeminiApiKeyFromConfig` falls back to the config file when
// GEMINI_API_KEY is unset; on dev machines that file usually has a real
// key, which makes the "no key set" assertions in this suite leak from
// the host environment. This mock makes the lookup env-only.
vi.mock("../../src/extensions/embeddings/gemini-embedder.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/extensions/embeddings/gemini-embedder.js")
  >("../../src/extensions/embeddings/gemini-embedder.js");
  return {
    ...actual,
    loadGeminiApiKeyFromConfig: (): string | null =>
      process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.length > 0
        ? process.env.GEMINI_API_KEY
        : null,
  };
});

import { openDatabase } from "../../src/storage/database.js";
import { enhancedExtract } from "../../src/extensions/llm-extraction/enhanced-extractor.js";
import {
  saveTrainingPair,
  getTrainingDataCount,
  getTrainingDataStats,
  iterateTrainingData,
} from "../../src/extensions/llm-extraction/training-capture.js";
import {
  getCachedGeminiProvider,
  resetGeminiProviderCache,
  GeminiProvider,
} from "../../src/extensions/llm-extraction/gemini-provider.js";
import {
  getExtractionProvider,
  loadDistillConfig,
  validateExtractionOutput,
} from "../../src/extensions/llm-extraction/provider-factory.js";
import { HybridProvider } from "../../src/extensions/llm-extraction/hybrid-provider.js";
import type { LlmProvider } from "../../src/extensions/llm-extraction/llm-provider.js";
import { LlmError } from "../../src/extensions/llm-extraction/llm-provider.js";
import { extractKnowledge } from "../../src/knowledge/knowledge-extractor.js";
import type { ParsedSession } from "../../src/parsers/session-parser.js";
import type Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a minimal ParsedSession for testing. */
function makeSession(overrides: Partial<ParsedSession> = {}): ParsedSession {
  return {
    sessionId: "e2e-session-1",
    project: "e2e-project",
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

/** Build a mock LlmProvider that returns a fixed response. */
function mockProvider(response: string, name = "test-gemini"): LlmProvider {
  return {
    name,
    complete: vi.fn().mockResolvedValue(response),
  };
}

/** Build a mock LlmProvider that rejects. */
function failingProvider(name = "test-gemini"): LlmProvider {
  return {
    name,
    complete: vi.fn().mockRejectedValue(new Error("API error")),
  };
}

/** Valid extraction JSON that the LLM would return. */
const VALID_EXTRACTION_JSON = JSON.stringify({
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
    {
      type: "solution",
      summary: "Fix build by adding moduleResolution to tsconfig",
      details: "Changed moduleResolution to bundler for ESM compat",
      tags: ["typescript", "esm"],
      relatedFiles: ["/tsconfig.json"],
    },
  ],
});

// ---------------------------------------------------------------------------
// Test 1: Fresh install -- no API key
// ---------------------------------------------------------------------------

describe("E2E Test 1: Fresh install -- no API key", () => {
  beforeEach(() => {
    resetGeminiProviderCache();
    vi.stubEnv("GEMINI_API_KEY", "");
  });

  afterEach(() => {
    resetGeminiProviderCache();
    vi.unstubAllEnvs();
  });

  it("getCachedGeminiProvider returns null when no API key is set", async () => {
    const provider = await getCachedGeminiProvider();
    expect(provider).toBeNull();
  });

  it("getExtractionProvider returns null when no API key and no distill config", async () => {
    vi.stubEnv("STRATA_DATA_DIR", "/tmp/nonexistent-e2e-test");
    const provider = await getExtractionProvider();
    expect(provider).toBeNull();
  });

  it("extraction falls back to heuristic extractKnowledge when provider is null", () => {
    const session = makeSession();
    // Heuristic extraction should work without any provider
    const entries = extractKnowledge(session);
    expect(Array.isArray(entries)).toBe(true);
    // The heuristic should find the "decided to" pattern
    const hasDecision = entries.some((e) => e.type === "decision");
    expect(hasDecision).toBe(true);
  });

  it("no training pairs are captured when provider is null (db not passed)", async () => {
    const db = openDatabase(":memory:");
    try {
      // Without a provider, the caller does not call enhancedExtract at all,
      // so training pairs are never created. Verify the table is empty.
      const counts = getTrainingDataCount(db);
      expect(counts.extraction).toBe(0);
      expect(counts.summarization).toBe(0);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 2: Gemini activation
// ---------------------------------------------------------------------------

describe("E2E Test 2: Gemini activation", () => {
  beforeEach(() => {
    resetGeminiProviderCache();
  });

  afterEach(() => {
    resetGeminiProviderCache();
    vi.unstubAllEnvs();
  });

  it("getCachedGeminiProvider returns a GeminiProvider when API key is set", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-e2e-key-12345");
    const provider = await getCachedGeminiProvider();
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe("gemini");
  });

  it("getExtractionProvider returns GeminiProvider (not HybridProvider) when no distill config", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-e2e-key-12345");
    vi.stubEnv("STRATA_DATA_DIR", "/tmp/nonexistent-e2e-test");
    // Isolate homedir() so loadDistillConfig's fallback can't find the
    // dev machine's real ~/.strata/config.json. Without these stubs,
    // commit 4509b26's home-dir fallback picks up the user's actual
    // distillation config and returns HybridProvider.
    vi.stubEnv("USERPROFILE", "/tmp/nonexistent-e2e-home");
    vi.stubEnv("HOME", "/tmp/nonexistent-e2e-home");
    const provider = await getExtractionProvider();
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe("gemini");
    expect(provider).not.toBeInstanceOf(HybridProvider);
  });

  it("mock Gemini API returns valid extraction JSON and produces KnowledgeEntry[]", async () => {
    const provider = mockProvider(VALID_EXTRACTION_JSON);
    const session = makeSession();

    const entries = await enhancedExtract(session, provider);

    expect(entries.length).toBeGreaterThanOrEqual(3);
    expect(entries[0].type).toBe("decision");
    expect(entries[0].summary).toContain("TypeScript");
    expect(entries[0].project).toBe("e2e-project");
    expect(entries[0].sessionId).toBe("e2e-session-1");
    expect(entries[0].id).toBeTruthy();
  });

  it("training pair is captured in the training_data table after LLM extraction", async () => {
    const db = openDatabase(":memory:");
    try {
      const provider = mockProvider(VALID_EXTRACTION_JSON);
      const session = makeSession();

      await enhancedExtract(session, provider, db);

      // Verify the training pair exists
      const counts = getTrainingDataCount(db);
      expect(counts.extraction).toBe(1);

      const row = db.prepare("SELECT * FROM training_data WHERE task_type = 'extraction'").get() as {
        task_type: string;
        input_text: string;
        output_json: string;
        model_used: string;
        quality_score: number;
      };
      expect(row).toBeDefined();
      expect(row.task_type).toBe("extraction");
      expect(row.model_used).toBe("test-gemini");
      expect(row.output_json).toBe(VALID_EXTRACTION_JSON);
      expect(row.quality_score).toBe(1.0);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 3: Training data accumulation
// ---------------------------------------------------------------------------

describe("E2E Test 3: Training data accumulation", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("getTrainingDataCount increments after multiple enhancedExtract calls", async () => {
    const provider = mockProvider(VALID_EXTRACTION_JSON);

    for (let i = 0; i < 5; i++) {
      const session = makeSession({ sessionId: `accumulate-${i}` });
      await enhancedExtract(session, provider, db);
    }

    const counts = getTrainingDataCount(db);
    expect(counts.extraction).toBe(5);
  });

  it("getTrainingDataStats returns correct quality breakdown", async () => {
    // Insert pairs with varying quality scores directly
    const pairs: Array<{ quality: number; diverged: boolean }> = [
      { quality: 1.0, diverged: false },
      { quality: 0.95, diverged: false },
      { quality: 0.8, diverged: true },
      { quality: 0.5, diverged: false },
    ];

    for (const p of pairs) {
      saveTrainingPair(db, {
        taskType: "extraction",
        inputText: `prompt-q${p.quality}`,
        outputJson: VALID_EXTRACTION_JSON,
        modelUsed: "test-gemini",
        qualityScore: p.quality,
        heuristicDiverged: p.diverged,
      });
    }

    const stats = getTrainingDataStats(db);
    expect(stats.extraction.total).toBe(4);
    expect(stats.extraction.highQuality).toBe(2); // 1.0 and 0.95
    expect(stats.extraction.mediumQuality).toBe(1); // 0.8
    expect(stats.extraction.heuristicDiverged).toBe(1); // the 0.8 one
    expect(stats.lastCapturedAt).toBeGreaterThan(0);
  });

  it("dialogue training pairs can be saved and iterated", () => {
    const db = openDatabase(":memory:");
    try {
      saveTrainingPair(db, {
        taskType: "dialogue",
        inputText: "Player: Can I buy a sword?\n\n[Memories: player saved daughter]",
        outputJson: "Take it — no charge. Consider it a father's gratitude.",
        modelUsed: "claude-sonnet-4-6",
        qualityScore: 0.95,
        heuristicDiverged: false,
      });

      const rows = [...iterateTrainingData(db, "dialogue")];
      expect(rows).toHaveLength(1);
      expect(rows[0].taskType).toBe("dialogue");
      expect(rows[0].inputText).toContain("Player: Can I buy a sword?");
      expect(rows[0].outputJson).toContain("father's gratitude");

      const counts = getTrainingDataCount(db);
      expect(counts.dialogue).toBe(1);
    } finally {
      db.close();
    }
  });

  it("heuristic_diverged is set correctly when heuristic returns 0 entries and LLM returns 3", async () => {
    // Use a session with messages that do NOT match any heuristic patterns
    const session = makeSession({
      sessionId: "divergence-test",
      messages: [
        {
          role: "user",
          text: "Can you explain how closures work in JavaScript?",
          hasCode: false,
          toolNames: [],
          toolInputSnippets: [],
        },
        {
          role: "assistant",
          text: "A closure is a function that has access to the outer scope variables even after the outer function has returned.",
          hasCode: false,
          toolNames: [],
          toolInputSnippets: [],
        },
      ],
    });

    const provider = mockProvider(VALID_EXTRACTION_JSON);
    await enhancedExtract(session, provider, db);

    const row = db.prepare(
      "SELECT heuristic_diverged FROM training_data WHERE task_type = 'extraction'"
    ).get() as { heuristic_diverged: number };

    // The heuristic extractor should find 0 entries for this generic session
    // (no "decided to", "fixed", "error" patterns), but LLM returns 3.
    // So heuristic_diverged should be 1 (true).
    expect(row.heuristic_diverged).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Test 4: Data export via iterateTrainingData
// ---------------------------------------------------------------------------

describe("E2E Test 4: Data export", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("iterateTrainingData yields all seeded extraction pairs", () => {
    // Seed 10 extraction training pairs
    for (let i = 0; i < 10; i++) {
      saveTrainingPair(db, {
        taskType: "extraction",
        inputText: `extraction-input-${i}`,
        outputJson: `{"entries": [{"type": "decision", "summary": "entry ${i}"}]}`,
        modelUsed: "gemini",
        qualityScore: 0.9,
        heuristicDiverged: false,
      });
    }

    const rows = [...iterateTrainingData(db, "extraction")];
    expect(rows).toHaveLength(10);

    // Verify each row has the expected structure
    for (const row of rows) {
      expect(row.taskType).toBe("extraction");
      expect(row.inputText).toMatch(/^extraction-input-\d$/);
      expect(row.qualityScore).toBe(0.9);
      expect(row.heuristicDiverged).toBe(false);
      expect(row.createdAt).toBeGreaterThan(0);
    }
  });

  it("iterateTrainingData filters by quality_score", () => {
    // Mix of quality scores
    for (let i = 0; i < 5; i++) {
      saveTrainingPair(db, {
        taskType: "extraction",
        inputText: `high-${i}`,
        outputJson: "{}",
        modelUsed: "gemini",
        qualityScore: 1.0,
        heuristicDiverged: false,
      });
    }
    for (let i = 0; i < 5; i++) {
      saveTrainingPair(db, {
        taskType: "extraction",
        inputText: `low-${i}`,
        outputJson: "{}",
        modelUsed: "gemini",
        qualityScore: 0.5,
        heuristicDiverged: false,
      });
    }

    // Default min quality 0.7 should return only the 5 high-quality ones
    const defaultRows = [...iterateTrainingData(db, "extraction")];
    expect(defaultRows).toHaveLength(5);
    expect(defaultRows.every((r) => r.qualityScore >= 0.7)).toBe(true);

    // All rows with min 0.0
    const allRows = [...iterateTrainingData(db, "extraction", 0.0)];
    expect(allRows).toHaveLength(10);
  });

  it("iterateTrainingData filters by task_type", () => {
    // Seed both extraction and summarization
    for (let i = 0; i < 3; i++) {
      saveTrainingPair(db, {
        taskType: "extraction",
        inputText: `ext-${i}`,
        outputJson: "{}",
        modelUsed: "gemini",
        qualityScore: 1.0,
        heuristicDiverged: false,
      });
    }
    for (let i = 0; i < 7; i++) {
      saveTrainingPair(db, {
        taskType: "summarization",
        inputText: `sum-${i}`,
        outputJson: "{}",
        modelUsed: "gemini",
        qualityScore: 1.0,
        heuristicDiverged: false,
      });
    }

    const extractionRows = [...iterateTrainingData(db, "extraction")];
    expect(extractionRows).toHaveLength(3);

    const summaryRows = [...iterateTrainingData(db, "summarization")];
    expect(summaryRows).toHaveLength(7);
  });
});

// ---------------------------------------------------------------------------
// Test 5: Hybrid provider behavior
// ---------------------------------------------------------------------------

describe("E2E Test 5: Hybrid provider behavior", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("uses local result when local model succeeds with valid JSON", async () => {
    const localResult = JSON.stringify({
      entries: [{ type: "decision", summary: "local model output" }],
    });
    const frontier = mockProvider("should not be called", "gemini");

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: localResult }),
    }) as unknown as typeof fetch;

    const provider = new HybridProvider({
      localUrl: "http://localhost:11434",
      localModel: "strata-extraction-7b",
      frontierProvider: frontier,
      validateOutput: validateExtractionOutput,
      localTimeoutMs: 15000,
    });

    const result = await provider.complete("test prompt");
    expect(result).toBe(localResult);
    expect(frontier.complete).not.toHaveBeenCalled();
  });

  it("falls back to frontier when local returns invalid JSON", async () => {
    const frontierResult = JSON.stringify({
      entries: [{ type: "solution", summary: "from frontier" }],
    });
    const frontier = mockProvider(frontierResult, "gemini");

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: "this is not valid JSON at all" }),
    }) as unknown as typeof fetch;

    const provider = new HybridProvider({
      localUrl: "http://localhost:11434",
      localModel: "strata-extraction-7b",
      frontierProvider: frontier,
      validateOutput: validateExtractionOutput,
      localTimeoutMs: 15000,
    });

    const result = await provider.complete("test prompt");
    expect(result).toBe(frontierResult);
    expect(frontier.complete).toHaveBeenCalledOnce();
  });

  it("STRICT MODE: throws when local returns invalid JSON (no silent fallback)", async () => {
    // Benchmark runs MUST fail loudly when local inference degrades so we
    // can see the real problem instead of silently measuring a Gemma/Gemini
    // hybrid that masks bugs like request queueing or timeout misconfiguration.
    vi.stubEnv("STRATA_HYBRID_STRICT", "1");

    const frontier = mockProvider("should not be called", "gemini");

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: "this is not valid JSON at all" }),
    }) as unknown as typeof fetch;

    const provider = new HybridProvider({
      localUrl: "http://localhost:11434",
      localModel: "strata-extraction-7b",
      frontierProvider: frontier,
      validateOutput: validateExtractionOutput,
      localTimeoutMs: 15000,
    });

    await expect(provider.complete("test prompt")).rejects.toThrow(
      /validation failed|strict mode/i
    );
    expect(frontier.complete).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("STRICT MODE: throws when local throws (no silent fallback to frontier)", async () => {
    vi.stubEnv("STRATA_HYBRID_STRICT", "1");

    const frontier = mockProvider("should not be called", "gemini");

    globalThis.fetch = vi.fn().mockRejectedValue(
      new TypeError("fetch failed: connection refused")
    ) as unknown as typeof fetch;

    const provider = new HybridProvider({
      localUrl: "http://localhost:11434",
      localModel: "strata-extraction-7b",
      frontierProvider: frontier,
      validateOutput: validateExtractionOutput,
      localTimeoutMs: 15000,
    });

    await expect(provider.complete("test prompt")).rejects.toThrow();
    expect(frontier.complete).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("circuit-breaker: skips local after 3 consecutive failures", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      throw new TypeError("fetch failed: connection refused");
    }) as unknown as typeof fetch;

    const frontier = mockProvider(
      JSON.stringify({ entries: [{ type: "fact", summary: "from frontier" }] }),
      "gemini"
    );

    const provider = new HybridProvider({
      localUrl: "http://localhost:11434",
      localModel: "strata-extraction-7b",
      frontierProvider: frontier,
      validateOutput: validateExtractionOutput,
      localTimeoutMs: 15000,
    });

    // First 3 calls: local fails, falls back to frontier
    await provider.complete("prompt 1");
    await provider.complete("prompt 2");
    await provider.complete("prompt 3");
    expect(callCount).toBe(3); // 3 local attempts

    // 4th call: circuit-breaker should skip local entirely
    await provider.complete("prompt 4");
    expect(callCount).toBe(3); // no new local attempt
    expect(frontier.complete).toHaveBeenCalledTimes(4);
  });

  it("circuit-breaker: resets after successful local call", async () => {
    let callCount = 0;
    const localResult = JSON.stringify({
      entries: [{ type: "decision", summary: "local success" }],
    });

    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      // Fail first 2, succeed on 3rd
      if (callCount <= 2) {
        throw new TypeError("fetch failed");
      }
      return {
        ok: true,
        json: async () => ({ response: localResult }),
      };
    }) as unknown as typeof fetch;

    const frontier = mockProvider("frontier result", "gemini");

    const provider = new HybridProvider({
      localUrl: "http://localhost:11434",
      localModel: "strata-extraction-7b",
      frontierProvider: frontier,
      validateOutput: validateExtractionOutput,
      localTimeoutMs: 15000,
    });

    await provider.complete("prompt 1"); // fail 1, frontier
    await provider.complete("prompt 2"); // fail 2, frontier
    await provider.complete("prompt 3"); // success! resets counter

    // Next call should still try local (counter was reset)
    await provider.complete("prompt 4");
    expect(callCount).toBe(4); // all 4 attempted local
  });

  it("falls back to frontier when local throws (Ollama not running)", async () => {
    const frontierResult = JSON.stringify({ entries: [] });
    const frontier = mockProvider(frontierResult, "gemini");

    globalThis.fetch = vi.fn().mockRejectedValue(
      new TypeError("fetch failed: connection refused")
    ) as unknown as typeof fetch;

    const provider = new HybridProvider({
      localUrl: "http://localhost:11434",
      localModel: "strata-extraction-7b",
      frontierProvider: frontier,
      validateOutput: validateExtractionOutput,
      localTimeoutMs: 15000,
    });

    const result = await provider.complete("test prompt");
    expect(result).toBe(frontierResult);
    expect(frontier.complete).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Test 6: Provider factory wiring
// ---------------------------------------------------------------------------

describe("E2E Test 6: Provider factory wiring", () => {
  const testDataDir = join(
    import.meta.dirname,
    "..",
    ".test-distill-e2e-factory"
  );
  const testHomeDir = join(
    import.meta.dirname,
    "..",
    ".test-distill-e2e-factory-home"
  );

  beforeEach(() => {
    resetGeminiProviderCache();
    if (existsSync(testDataDir)) {
      rmSync(testDataDir, { recursive: true, force: true });
    }
    if (existsSync(testHomeDir)) {
      rmSync(testHomeDir, { recursive: true, force: true });
    }
    mkdirSync(testDataDir, { recursive: true });
    mkdirSync(testHomeDir, { recursive: true });
    vi.stubEnv("STRATA_DATA_DIR", testDataDir);
    // Isolate homedir() so loadDistillConfig's fallback can't find the
    // dev machine's real ~/.strata/config.json. Commit 4509b26 added
    // a home-dir fallback that otherwise bleeds through into tests that
    // expect loadDistillConfig to return null.
    vi.stubEnv("USERPROFILE", testHomeDir);
    vi.stubEnv("HOME", testHomeDir);
  });

  afterEach(() => {
    resetGeminiProviderCache();
    vi.unstubAllEnvs();
    if (existsSync(testDataDir)) {
      rmSync(testDataDir, { recursive: true, force: true });
    }
    if (existsSync(testHomeDir)) {
      rmSync(testHomeDir, { recursive: true, force: true });
    }
  });

  it("returns HybridProvider when distillation enabled and GEMINI_API_KEY set", async () => {
    // Write a config.json with distillation enabled
    const configPath = join(testDataDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ distillation: { enabled: true } }),
      "utf-8"
    );

    vi.stubEnv("GEMINI_API_KEY", "test-e2e-key-12345");

    const provider = await getExtractionProvider();
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe("hybrid");
    expect(provider).toBeInstanceOf(HybridProvider);
  });

  it("returns GeminiProvider when distillation not configured and GEMINI_API_KEY set", async () => {
    // No config.json at all
    vi.stubEnv("GEMINI_API_KEY", "test-e2e-key-12345");

    resetGeminiProviderCache();
    const provider = await getExtractionProvider();
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe("gemini");
    expect(provider).not.toBeInstanceOf(HybridProvider);
  });

  it("returns null when no GEMINI_API_KEY regardless of distill config", async () => {
    const configPath = join(testDataDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ distillation: { enabled: true } }),
      "utf-8"
    );

    vi.stubEnv("GEMINI_API_KEY", "");

    resetGeminiProviderCache();
    const provider = await getExtractionProvider();
    expect(provider).toBeNull();
  });

  it("loadDistillConfig reads enabled flag from config.json", () => {
    const configPath = join(testDataDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        distillation: {
          enabled: true,
          extractionModel: "my-custom-model",
          localUrl: "http://127.0.0.1:11434",
        },
      }),
      "utf-8"
    );

    const config = loadDistillConfig();
    expect(config).not.toBeNull();
    expect(config!.enabled).toBe(true);
    expect(config!.extractionModel).toBe("my-custom-model");
    expect(config!.localUrl).toBe("http://127.0.0.1:11434");
  });

  it("loadDistillConfig returns null when distillation.enabled is false", () => {
    const configPath = join(testDataDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ distillation: { enabled: false } }),
      "utf-8"
    );

    const config = loadDistillConfig();
    expect(config).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Test 7: Sanitizer in the pipeline
// ---------------------------------------------------------------------------

describe("E2E Test 7: Sanitizer in the pipeline", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("redacts API keys in the prompt sent to the provider", async () => {
    const fakeAnthropicKey = "sk-ant-test1234567890abcdefghij";
    const session = makeSession({
      sessionId: "sanitizer-test",
      messages: [
        {
          role: "user",
          text: `Set my API key to ${fakeAnthropicKey} in the config`,
          hasCode: false,
          toolNames: [],
          toolInputSnippets: [],
        },
        {
          role: "assistant",
          text: "I've added the key to your environment variables.",
          hasCode: false,
          toolNames: [],
          toolInputSnippets: [],
        },
      ],
    });

    const completeFn = vi.fn().mockResolvedValue(VALID_EXTRACTION_JSON);
    const provider: LlmProvider = { name: "test-gemini", complete: completeFn };

    await enhancedExtract(session, provider, db);

    // Verify the prompt sent to the provider has the key redacted
    const [promptArg] = completeFn.mock.calls[0];
    expect(promptArg).not.toContain(fakeAnthropicKey);
    expect(promptArg).toContain("[REDACTED:anthropic-key]");

    // Verify the training pair's input_text also has the redacted version
    const row = db.prepare(
      "SELECT input_text FROM training_data WHERE task_type = 'extraction'"
    ).get() as { input_text: string };
    expect(row).toBeDefined();
    expect(row.input_text).not.toContain(fakeAnthropicKey);
    expect(row.input_text).toContain("[REDACTED:anthropic-key]");
  });

  it("redacts GitHub tokens in the prompt", async () => {
    const fakeGithubToken = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
    const session = makeSession({
      messages: [
        {
          role: "user",
          text: `Use this token: ${fakeGithubToken}`,
          hasCode: false,
          toolNames: [],
          toolInputSnippets: [],
        },
        {
          role: "assistant",
          text: "Token stored.",
          hasCode: false,
          toolNames: [],
          toolInputSnippets: [],
        },
      ],
    });

    const completeFn = vi.fn().mockResolvedValue(VALID_EXTRACTION_JSON);
    const provider: LlmProvider = { name: "test-gemini", complete: completeFn };

    await enhancedExtract(session, provider, db);

    const [promptArg] = completeFn.mock.calls[0];
    expect(promptArg).not.toContain(fakeGithubToken);
    expect(promptArg).toContain("[REDACTED:github-token]");
  });
});

// ---------------------------------------------------------------------------
// Test 8: Activate/deactivate config persistence
// ---------------------------------------------------------------------------

describe("E2E Test 8: Activate/deactivate config persistence", () => {
  const testDataDir = join(
    import.meta.dirname,
    "..",
    ".test-distill-e2e-config"
  );

  beforeEach(() => {
    if (existsSync(testDataDir)) {
      rmSync(testDataDir, { recursive: true, force: true });
    }
    mkdirSync(testDataDir, { recursive: true });
    vi.stubEnv("STRATA_DATA_DIR", testDataDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (existsSync(testDataDir)) {
      rmSync(testDataDir, { recursive: true, force: true });
    }
  });

  it("activate writes distillation.enabled=true to config.json", async () => {
    // Dynamically import to pick up the stubbed env
    const { runDistillActivate } = await import("../../src/cli/distill.js");

    // Suppress console output
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runDistillActivate();

      const configPath = join(testDataDir, "config.json");
      expect(existsSync(configPath)).toBe(true);
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(config.distillation).toBeDefined();
      expect(config.distillation.enabled).toBe(true);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("deactivate writes distillation.enabled=false to config.json", async () => {
    const { runDistillActivate, runDistillDeactivate } = await import(
      "../../src/cli/distill.js"
    );

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      // Activate first
      await runDistillActivate();

      // Then deactivate
      await runDistillDeactivate();

      const configPath = join(testDataDir, "config.json");
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(config.distillation).toBeDefined();
      expect(config.distillation.enabled).toBe(false);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("activate then deactivate then activate round-trips correctly", async () => {
    const { runDistillActivate, runDistillDeactivate } = await import(
      "../../src/cli/distill.js"
    );

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runDistillActivate();
      await runDistillDeactivate();
      await runDistillActivate();

      const configPath = join(testDataDir, "config.json");
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(config.distillation.enabled).toBe(true);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("config preserves other settings when activate/deactivate is called", async () => {
    // Write an initial config with other settings
    const configPath = join(testDataDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ customSetting: "preserved", version: 42 }),
      "utf-8"
    );

    const { runDistillActivate } = await import("../../src/cli/distill.js");

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runDistillActivate();

      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(config.customSetting).toBe("preserved");
      expect(config.version).toBe(42);
      expect(config.distillation.enabled).toBe(true);
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
