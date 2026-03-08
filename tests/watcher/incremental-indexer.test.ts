/**
 * Tests for IncrementalIndexer parser routing and tool-aware memory writing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock all heavy dependencies before importing the module
vi.mock("../../src/config.js", () => ({
  CONFIG: {
    projectsDir: "/mock/.claude/projects",
    claudeDir: "/mock/.claude",
    watcher: { debounceMs: 100, staleSessionMinutes: 0 },
    learning: { maxLearningsPerProject: 20, maxLearningLength: 200, memoryLineBudget: 200 },
    indexing: { chunkSize: 500, maxChunksPerSession: 100 },
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

vi.mock("../../src/extensions/llm-extraction/gemini-provider.js", () => ({
  getCachedGeminiProvider: vi.fn(async () => null),
}));

vi.mock("../../src/extensions/llm-extraction/enhanced-extractor.js", () => ({
  enhancedExtract: vi.fn(async () => []),
}));

vi.mock("../../src/extensions/llm-extraction/smart-summarizer.js", () => ({
  smartSummarize: vi.fn(async () => ({ sessionId: "s1", summary: "test" })),
}));

vi.mock("../../src/knowledge/learning-synthesizer.js", () => ({
  synthesizeLearnings: vi.fn(() => []),
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
  resolveConflicts: vi.fn(),
  executeResolution: vi.fn(),
}));

vi.mock("../../src/watcher/file-watcher.js", () => {
  let storedCallback: ((f: string, p: string) => void) | null = null;
  return {
    FileWatcher: vi.fn().mockImplementation(() => ({
      start: vi.fn((cb: (f: string, p: string) => void) => {
        storedCallback = cb;
      }),
      stop: vi.fn(),
      _trigger: (filename: string, parserId: string) => {
        if (storedCallback) storedCallback(filename, parserId);
      },
    })),
    getWatchTargets: vi.fn(() => [
      { dir: "/mock/.claude/projects", glob: "*.jsonl", extensions: [".jsonl"], parserId: "claude-code" },
      { dir: "/mock/.gemini/tmp", glob: "checkpoint-*.json", extensions: [".json"], parserId: "gemini-cli" },
      { dir: "/mock/.codex/sessions", glob: "rollout-*.jsonl", extensions: [".jsonl"], parserId: "codex" },
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

import { join } from "path";
import { IncrementalIndexer } from "../../src/watcher/incremental-indexer.js";
import { parseSessionFile } from "../../src/parsers/session-parser.js";
import { extractKnowledge } from "../../src/knowledge/knowledge-extractor.js";
import { synthesizeLearnings } from "../../src/knowledge/learning-synthesizer.js";
import { writeLearningsToMemory } from "../../src/knowledge/memory-writer.js";
import type { ParserRegistry } from "../../src/parsers/parser-registry.js";
import type { ConversationParser } from "../../src/parsers/parser-interface.js";
import type { ParsedSession, SessionFileInfo } from "../../src/parsers/session-parser.js";

function makeMockSession(overrides: Partial<ParsedSession> = {}): ParsedSession {
  return {
    sessionId: "test-session",
    project: "test-project",
    cwd: "/test",
    gitBranch: "main",
    messages: [
      { role: "user", text: "hello", toolNames: [], toolInputSnippets: [], hasCode: false, timestamp: "", uuid: "u1" },
    ],
    startTime: Date.now() - 60000,
    endTime: Date.now(),
    tool: undefined,
    ...overrides,
  };
}

function makeMockParser(id: string, session: ParsedSession | null = null): ConversationParser {
  return {
    id,
    name: `Mock ${id}`,
    detect: () => true,
    discover: () => [],
    parse: vi.fn((_file: SessionFileInfo) => session),
  };
}

function makeMockRegistry(parsers: ConversationParser[]): ParserRegistry {
  const map = new Map(parsers.map((p) => [p.id, p]));
  return {
    register: vi.fn(),
    getAll: () => [...map.values()],
    getById: (id: string) => map.get(id),
    detectAvailable: () => [...map.values()],
  } as unknown as ParserRegistry;
}

function makeMockIndexManager() {
  return {
    incrementalUpdate: vi.fn(async () => ({ added: 0, updated: 0, unchanged: 0 })),
    save: vi.fn(async () => {}),
  };
}

function makeMockKnowledgeStore() {
  return {
    addEntry: vi.fn(),
    save: vi.fn(),
    getGlobalLearnings: vi.fn(() => [{ id: "l1", summary: "test learning", details: "", tags: [], timestamp: Date.now() }]),
  };
}

describe("IncrementalIndexer", () => {
  let indexManager: ReturnType<typeof makeMockIndexManager>;
  let knowledgeStore: ReturnType<typeof makeMockKnowledgeStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    indexManager = makeMockIndexManager();
    knowledgeStore = makeMockKnowledgeStore();
  });

  describe("parser routing", () => {
    it("uses parseSessionFile for claude-code parserId", async () => {
      const claudeSession = makeMockSession({ tool: "claude-code", project: "myproject" });
      vi.mocked(parseSessionFile).mockReturnValue(claudeSession);

      const indexer = new IncrementalIndexer(
        indexManager as any,
        knowledgeStore as any,
        undefined,
        undefined // no registry — falls back to legacy path
      );

      // Access private method via prototype
      const result = (indexer as any).parseSession("myproject/session1.jsonl", "claude-code");
      const expectedPath = join("/mock/.claude/projects", "myproject", "session1.jsonl");
      expect(parseSessionFile).toHaveBeenCalledWith(expectedPath, "myproject");
      expect(result).toBe(claudeSession);
    });

    it("uses parser registry for non-claude parserId", async () => {
      const geminiSession = makeMockSession({ tool: "gemini-cli", project: "gemini-project" });
      const geminiParser = makeMockParser("gemini-cli", geminiSession);
      const registry = makeMockRegistry([geminiParser]);

      const indexer = new IncrementalIndexer(
        indexManager as any,
        knowledgeStore as any,
        undefined,
        registry
      );

      const result = (indexer as any).parseSession("checkpoint-abc.json", "gemini-cli");
      expect(geminiParser.parse).toHaveBeenCalled();
      expect(result).toBe(geminiSession);
      // Should NOT call the legacy parseSessionFile
      expect(parseSessionFile).not.toHaveBeenCalled();
    });

    it("returns null for unknown parserId", async () => {
      const registry = makeMockRegistry([]);

      const indexer = new IncrementalIndexer(
        indexManager as any,
        knowledgeStore as any,
        undefined,
        registry
      );

      const result = (indexer as any).parseSession("some-file.txt", "unknown-tool");
      expect(result).toBeNull();
    });

    it("falls back to legacy path when no registry is provided", async () => {
      const session = makeMockSession({ project: "proj" });
      vi.mocked(parseSessionFile).mockReturnValue(session);

      const indexer = new IncrementalIndexer(
        indexManager as any,
        knowledgeStore as any,
        // no entityStore, no registry
      );

      const result = (indexer as any).parseSession("proj/session.jsonl", "gemini-cli");
      // Without registry, even non-claude parsers fall back to legacy
      expect(parseSessionFile).toHaveBeenCalled();
    });
  });

  describe("tool ID flow to memory writer", () => {
    it("passes tool from parsed session to writeLearningsToMemory", async () => {
      const geminiSession = makeMockSession({ tool: "gemini-cli", project: "gproject" });
      const geminiParser = makeMockParser("gemini-cli", geminiSession);
      const registry = makeMockRegistry([geminiParser]);

      // Make knowledge extraction return something so synthesis runs
      vi.mocked(extractKnowledge).mockReturnValue([
        { id: "k1", summary: "test", details: "", tags: [], timestamp: Date.now(), type: "pattern" } as any,
      ]);
      vi.mocked(synthesizeLearnings).mockReturnValue([
        { id: "l1", summary: "learning", details: "", tags: [], timestamp: Date.now() } as any,
      ]);

      const indexer = new IncrementalIndexer(
        indexManager as any,
        knowledgeStore as any,
        undefined,
        registry
      );

      // Call handleFileChange directly (it's private, access via prototype)
      await (indexer as any).handleFileChange("checkpoint-abc.json", "gemini-cli");

      expect(writeLearningsToMemory).toHaveBeenCalledWith(
        "gproject",
        expect.any(Array),
        "gemini-cli"
      );
    });

    it("passes claude-code tool for claude sessions", async () => {
      const claudeSession = makeMockSession({ tool: "claude-code", project: "cproject" });
      vi.mocked(parseSessionFile).mockReturnValue(claudeSession);

      vi.mocked(extractKnowledge).mockReturnValue([
        { id: "k1", summary: "test", details: "", tags: [], timestamp: Date.now(), type: "pattern" } as any,
      ]);
      vi.mocked(synthesizeLearnings).mockReturnValue([
        { id: "l1", summary: "learning", details: "", tags: [], timestamp: Date.now() } as any,
      ]);

      const indexer = new IncrementalIndexer(
        indexManager as any,
        knowledgeStore as any,
      );

      await (indexer as any).handleFileChange("cproject/session.jsonl", "claude-code");

      expect(writeLearningsToMemory).toHaveBeenCalledWith(
        "cproject",
        expect.any(Array),
        "claude-code"
      );
    });

    it("uses parserId as tool fallback when session.tool is undefined", async () => {
      const codexSession = makeMockSession({ project: "codex-proj" });
      // Explicitly no tool field
      delete (codexSession as any).tool;

      const codexParser = makeMockParser("codex", codexSession);
      const registry = makeMockRegistry([codexParser]);

      // Add a codex watch target
      const { getWatchTargets } = await import("../../src/watcher/file-watcher.js");
      vi.mocked(getWatchTargets).mockReturnValue([
        { dir: "/mock/.codex/sessions", glob: "rollout-*.jsonl", extensions: [".jsonl"], parserId: "codex" },
      ]);

      vi.mocked(extractKnowledge).mockReturnValue([
        { id: "k1", summary: "test", details: "", tags: [], timestamp: Date.now(), type: "pattern" } as any,
      ]);
      vi.mocked(synthesizeLearnings).mockReturnValue([
        { id: "l1", summary: "learning", details: "", tags: [], timestamp: Date.now() } as any,
      ]);

      const indexer = new IncrementalIndexer(
        indexManager as any,
        knowledgeStore as any,
        undefined,
        registry
      );

      await (indexer as any).handleFileChange("rollout-abc.jsonl", "codex");

      // tool should be parserId "codex" since session.tool was undefined
      expect(writeLearningsToMemory).toHaveBeenCalledWith(
        "codex-proj",
        expect.any(Array),
        "codex"
      );
    });
  });

  describe("error handling", () => {
    it("does not crash when parser throws", async () => {
      const badParser: ConversationParser = {
        id: "bad-parser",
        name: "Bad Parser",
        detect: () => true,
        discover: () => [],
        parse: vi.fn(() => { throw new Error("parse exploded"); }),
      };

      const { getWatchTargets } = await import("../../src/watcher/file-watcher.js");
      vi.mocked(getWatchTargets).mockReturnValue([
        { dir: "/mock/bad", glob: "*.json", extensions: [".json"], parserId: "bad-parser" },
      ]);

      const registry = makeMockRegistry([badParser]);

      const indexer = new IncrementalIndexer(
        indexManager as any,
        knowledgeStore as any,
        undefined,
        registry
      );

      // Should not throw — parser errors are caught
      await expect(
        (indexer as any).handleFileChange("file.json", "bad-parser")
      ).resolves.not.toThrow();

      // Pipeline should NOT have been called (session parsing failed)
      expect(writeLearningsToMemory).not.toHaveBeenCalled();
    });
  });
});
