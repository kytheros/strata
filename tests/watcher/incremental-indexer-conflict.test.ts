/**
 * Regression tests for the conflict-resolution write path in IncrementalIndexer.
 *
 * Bug: executeResolution() is async (performs store mutations) but was called
 * without await in handleFileChange, so resolution mutations could land after
 * subsequent writes — and rejections vanished into start()'s empty catch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/config.js", () => ({
  CONFIG: {
    projectsDir: "/mock/.claude/projects",
    claudeDir: "/mock/.claude",
    watcher: { debounceMs: 100, staleSessionMinutes: 0 },
    learning: { maxLearningsPerProject: 20, maxLearningLength: 200, memoryLineBudget: 200 },
    indexing: { chunkSize: 500, maxChunksPerSession: 100 },
    importance: { typeWeight: 0.35, languageWeight: 0.20, frequencyWeight: 0.35, explicitWeight: 0.10, boostMax: 0.5 },
    extraWatchDirs: [],
  },
}));

vi.mock("../../src/parsers/session-parser.js", () => ({
  parseSessionFile: vi.fn(),
}));

vi.mock("../../src/knowledge/knowledge-extractor.js", () => ({
  extractKnowledge: vi.fn(() => []),
}));

vi.mock("../../src/knowledge/session-summarizer.js", () => ({
  summarizeSession: vi.fn(() => ({ sessionId: "s1", summary: "test" })),
  cacheSummary: vi.fn(),
}));

vi.mock("../../src/extensions/llm-extraction/provider-factory.js", () => ({
  getExtractionProvider: vi.fn(async () => ({ name: "mock-provider" })),
  getSummarizationProvider: vi.fn(async () => null),
}));

vi.mock("../../src/extensions/llm-extraction/enhanced-extractor.js", () => ({
  enhancedExtract: vi.fn(async () => []),
}));

vi.mock("../../src/extensions/llm-extraction/smart-summarizer.js", () => ({
  smartSummarize: vi.fn(async () => ({ sessionId: "s1", summary: "test" })),
}));

vi.mock("../../src/knowledge/learning-synthesizer.js", () => ({
  synthesizeLearnings: vi.fn(async () => []),
}));

vi.mock("../../src/knowledge/memory-writer.js", () => ({
  writeLearningsToMemory: vi.fn(),
}));

vi.mock("../../src/knowledge/entity-extractor.js", () => ({
  extractEntities: vi.fn(() => []),
  extractRelations: vi.fn(() => []),
}));

vi.mock("../../src/knowledge/procedure-extractor.js", () => ({
  extractProcedures: vi.fn(() => []),
}));

vi.mock("../../src/knowledge/conflict-resolver.js", () => ({
  resolveConflicts: vi.fn(async () => ({ action: "add" })),
  executeResolution: vi.fn(async () => {}),
}));

vi.mock("../../src/watcher/file-watcher.js", () => {
  let storedCallback: ((f: string, p: string) => void) | null = null;
  return {
    FileWatcher: vi.fn().mockImplementation(function () {
      return {
        start: vi.fn(function (cb: (f: string, p: string) => void) {
          storedCallback = cb;
        }),
        stop: vi.fn(),
        _trigger: (filename: string, parserId: string) => {
          if (storedCallback) storedCallback(filename, parserId);
        },
      };
    }),
    getWatchTargets: vi.fn(() => [
      { dir: "/mock/.claude/projects", glob: "*.jsonl", extensions: [".jsonl"], parserId: "claude-code" },
    ]),
  };
});

vi.mock("fs", async () => {
  const actual = await vi.importActual("fs");
  return {
    ...actual,
    statSync: vi.fn(() => ({
      mtimeMs: Date.now() - 600000, // 10 min ago (stale)
      size: 1024,
    })),
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(() => ""),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

import { IncrementalIndexer } from "../../src/watcher/incremental-indexer.js";
import { parseSessionFile } from "../../src/parsers/session-parser.js";
import { enhancedExtract } from "../../src/extensions/llm-extraction/enhanced-extractor.js";
import { executeResolution } from "../../src/knowledge/conflict-resolver.js";
import type { ParsedSession } from "../../src/parsers/session-parser.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeMockSession(): ParsedSession {
  return {
    sessionId: "test-session",
    project: "proj",
    cwd: "/test",
    gitBranch: "main",
    messages: [
      { role: "user", text: "hello", toolNames: [], toolInputSnippets: [], hasCode: false, timestamp: "", uuid: "u1" },
    ],
    startTime: Date.now() - 60000,
    endTime: Date.now(),
    tool: "claude-code",
  } as ParsedSession;
}

function makeEntry(id: string) {
  return {
    id,
    summary: `entry ${id}`,
    details: "",
    tags: [],
    timestamp: Date.now(),
    type: "pattern",
    sessionId: "test-session",
    occurrences: 1,
    projectCount: 1,
  } as any;
}

function makeMockIndexManager() {
  return {
    incrementalUpdate: vi.fn(async () => ({ added: 0, updated: 0, unchanged: 0 })),
    save: vi.fn(async () => {}),
  };
}

/** Knowledge store with a `search` function so the conflict-resolution branch is taken. */
function makeMockSqliteKnowledgeStore() {
  return {
    addEntry: vi.fn(),
    save: vi.fn(),
    search: vi.fn(async () => []),
    getGlobalLearnings: vi.fn(async () => []),
  };
}

describe("IncrementalIndexer conflict-resolution integrity", () => {
  let indexManager: ReturnType<typeof makeMockIndexManager>;
  let knowledgeStore: ReturnType<typeof makeMockSqliteKnowledgeStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    indexManager = makeMockIndexManager();
    knowledgeStore = makeMockSqliteKnowledgeStore();
    vi.mocked(parseSessionFile).mockReturnValue(makeMockSession());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("awaits executeResolution for every entry before handleFileChange resolves", async () => {
    vi.mocked(enhancedExtract).mockResolvedValue([makeEntry("k1"), makeEntry("k2")]);

    let settled = 0;
    vi.mocked(executeResolution).mockImplementation(async () => {
      await delay(10); // simulate async store mutations (delete/update/add)
      settled++;
    });

    const indexer = new IncrementalIndexer(indexManager as any, knowledgeStore as any);
    await (indexer as any).handleFileChange("proj/session.jsonl", "claude-code");

    expect(executeResolution).toHaveBeenCalledTimes(2);
    // Resolution mutations must have committed by the time the pipeline returns.
    expect(settled).toBe(2);
  });

  it("logs file-change pipeline errors instead of swallowing them", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    indexManager.incrementalUpdate.mockRejectedValue(new Error("index exploded"));

    const indexer = new IncrementalIndexer(indexManager as any, knowledgeStore as any);
    indexer.start();
    (indexer as any).watcher._trigger("proj/session.jsonl", "claude-code");
    await delay(20);

    expect(errorSpy).toHaveBeenCalled();
    const logged = errorSpy.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("index exploded");
  });
});
