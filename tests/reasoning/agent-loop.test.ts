/**
 * Agent loop unit tests.
 *
 * Exercises the production agent loop (runAgentLoop) with mock providers
 * and mock stores to verify loop control, tool execution, question
 * classification, store availability filtering, and token tracking.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  ToolCallingProvider,
  ToolDefinition,
  AgentMessage,
  ToolCall,
  TokenUsage,
} from "../../src/reasoning/tool-calling-provider.js";
import type { IDocumentStore } from "../../src/storage/interfaces/document-store.js";
import type { IEventStore, SVOEvent } from "../../src/storage/interfaces/event-store.js";
import type { IKnowledgeStore } from "../../src/storage/interfaces/knowledge-store.js";
import type { DocumentChunk } from "../../src/indexing/document-store.js";
import type { KnowledgeEntry } from "../../src/knowledge/knowledge-store.js";
import type { AgentLoopDependencies } from "../../src/reasoning/agent-loop.js";

// ---------------------------------------------------------------------------
// Mock the factory so runAgentLoop never touches real API keys
// ---------------------------------------------------------------------------

let mockProvider: MockToolCallingProvider;

vi.mock("../../src/reasoning/providers/factory.js", () => ({
  createToolCallingProvider: () => mockProvider,
}));

// ---------------------------------------------------------------------------
// Mock ToolCallingProvider
// ---------------------------------------------------------------------------

/** A scripted response for the mock provider. */
interface ScriptedResponse {
  content: string | null;
  toolCalls?: ToolCall[];
  finishReason: string;
  usage?: TokenUsage;
}

/**
 * A fake ToolCallingProvider that returns pre-scripted responses in order.
 * Captures the tools and messages passed to chatWithTools for assertions.
 */
class MockToolCallingProvider implements ToolCallingProvider {
  readonly name = "mock";
  private responses: ScriptedResponse[];
  private callIndex = 0;

  /** Tools received on the most recent chatWithTools call. */
  lastTools: ToolDefinition[] = [];
  /** Messages received on the most recent chatWithTools call. */
  lastMessages: AgentMessage[] = [];
  /** Total number of chatWithTools calls. */
  callCount = 0;

  constructor(responses: ScriptedResponse[]) {
    this.responses = responses;
  }

  async chatWithTools(
    messages: AgentMessage[],
    tools: ToolDefinition[],
    _options?: { temperature?: number; maxTokens?: number; timeoutMs?: number },
  ): Promise<{
    content: string | null;
    toolCalls?: ToolCall[];
    finishReason: string;
    usage?: TokenUsage;
  }> {
    this.lastMessages = messages;
    this.lastTools = tools;
    this.callCount++;

    const response = this.responses[this.callIndex];
    if (!response) {
      // Fallback: return a stop response to prevent infinite loops
      return {
        content: "Fallback answer (out of scripted responses).",
        finishReason: "stop",
        usage: { promptTokens: 0, completionTokens: 0 },
      };
    }

    this.callIndex++;
    return {
      ...response,
      usage: response.usage ?? { promptTokens: 100, completionTokens: 50 },
    };
  }
}

// ---------------------------------------------------------------------------
// Mock stores
// ---------------------------------------------------------------------------

const TEST_TIMESTAMP = new Date("2024-06-15T12:00:00Z").getTime();

function makeChunk(overrides: Partial<DocumentChunk> = {}): DocumentChunk {
  return {
    id: "chunk-1",
    sessionId: "session-abc",
    project: "test-project",
    text: "User discussed building a React dashboard with TypeScript.",
    role: "mixed",
    timestamp: TEST_TIMESTAMP,
    toolNames: [],
    tokenCount: 120,
    messageIndex: 0,
    ...overrides,
  };
}

function createMockDocumentStore(
  sessions: Map<string, DocumentChunk[]> = new Map([
    ["session-abc", [makeChunk()]],
    [
      "session-def",
      [
        makeChunk({
          id: "chunk-2",
          sessionId: "session-def",
          text: "Second session about Python data analysis.",
          messageIndex: 0,
          timestamp: TEST_TIMESTAMP + 86400_000,
        }),
      ],
    ],
  ]),
): IDocumentStore {
  const allDocs = [...sessions.values()].flat();
  return {
    add: vi.fn().mockResolvedValue("new-id"),
    get: vi.fn().mockResolvedValue(undefined),
    getBySession: vi.fn().mockImplementation(async (sid: string) => {
      return sessions.get(sid) ?? [];
    }),
    getByProject: vi.fn().mockResolvedValue([]),
    remove: vi.fn().mockResolvedValue(undefined),
    removeSession: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    searchByDateRange: vi.fn().mockResolvedValue([]),
    getDocumentCount: vi.fn().mockResolvedValue(allDocs.length),
    getAverageTokenCount: vi.fn().mockResolvedValue(120),
    getAllDocuments: vi.fn().mockResolvedValue(allDocs),
    getSessionIds: vi.fn().mockResolvedValue(new Set(sessions.keys())),
    getProjects: vi.fn().mockResolvedValue(new Set(["test-project"])),
  } as unknown as IDocumentStore;
}

function createMockSearchEngine() {
  return {
    searchSessionLevel: vi.fn().mockResolvedValue([
      {
        sessionId: "session-abc",
        text: "User discussed building a React dashboard with TypeScript.",
        timestamp: TEST_TIMESTAMP,
        score: 5.0,
      },
    ]),
    searchByDateRange: vi.fn().mockResolvedValue([]),
  };
}

function createMockEventStore(): IEventStore {
  const events: SVOEvent[] = [
    {
      subject: "user",
      verb: "purchased",
      object: "Gundam RX-78 model kit",
      startDate: "2024-06-10",
      endDate: null,
      aliases: ["bought plastic model", "ordered gunpla"],
      category: "purchase",
      sessionId: "session-abc",
      project: "test-project",
      timestamp: TEST_TIMESTAMP,
    },
  ];

  return {
    addEvents: vi.fn().mockResolvedValue(1),
    search: vi.fn().mockResolvedValue(events),
    getBySession: vi.fn().mockResolvedValue(events),
    deleteBySession: vi.fn().mockResolvedValue(undefined),
    getEventCount: vi.fn().mockResolvedValue(events.length),
  } as unknown as IEventStore;
}

function createMockKnowledgeStore(): IKnowledgeStore {
  const entries: KnowledgeEntry[] = [
    {
      id: "k-1",
      type: "fact",
      project: "test-project",
      sessionId: "session-abc",
      timestamp: TEST_TIMESTAMP,
      summary: "User owns a golden retriever named Buddy.",
      details: "Mentioned the dog in session about weekend activities.",
      tags: ["pet", "dog"],
      relatedFiles: [],
    },
  ];

  return {
    addEntry: vi.fn().mockResolvedValue(undefined),
    upsertEntry: vi.fn().mockResolvedValue(undefined),
    getEntry: vi.fn().mockResolvedValue(undefined),
    hasEntry: vi.fn().mockResolvedValue(false),
    search: vi.fn().mockResolvedValue(entries),
    getProjectEntries: vi.fn().mockResolvedValue([]),
    getByType: vi.fn().mockResolvedValue([]),
    getGlobalLearnings: vi.fn().mockResolvedValue([]),
    updateEntry: vi.fn().mockResolvedValue(false),
    deleteEntry: vi.fn().mockResolvedValue(false),
    removeEntry: vi.fn().mockResolvedValue(undefined),
    mergeProcedure: vi.fn().mockResolvedValue(undefined),
    getHistory: vi.fn().mockResolvedValue([]),
    getEntryCount: vi.fn().mockResolvedValue(entries.length),
    getAllEntries: vi.fn().mockResolvedValue(entries),
    getEntries: vi.fn().mockResolvedValue({ entries, total: entries.length }),
    getTypeDistribution: vi.fn().mockResolvedValue({ fact: 1 }),
  } as unknown as IKnowledgeStore;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides: Partial<AgentLoopDependencies> = {}): AgentLoopDependencies {
  return {
    searchEngine: createMockSearchEngine() as any,
    documentStore: createMockDocumentStore(),
    eventStore: createMockEventStore(),
    knowledgeStore: createMockKnowledgeStore(),
    ...overrides,
  };
}

function makeToolCall(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: `call-${name}-${Date.now()}`, name, arguments: args };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runAgentLoop", () => {
  // Lazy import — must happen after vi.mock above is applied
  let runAgentLoop: typeof import("../../src/reasoning/agent-loop.js").runAgentLoop;

  beforeEach(async () => {
    // Re-import to pick up the vi.mock'd factory
    const mod = await import("../../src/reasoning/agent-loop.js");
    runAgentLoop = mod.runAgentLoop;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // Basic loop behavior
  // -----------------------------------------------------------------------

  describe("Basic loop behavior", () => {
    it("returns answer on first response (no tool calls)", async () => {
      mockProvider = new MockToolCallingProvider([
        {
          content: "The user's dog is named Buddy.",
          finishReason: "stop",
          usage: { promptTokens: 200, completionTokens: 40 },
        },
      ]);

      const result = await runAgentLoop("What is the dog's name?", makeDeps());

      expect(result.answer).toBe("The user's dog is named Buddy.");
      expect(result.iterations).toBe(1);
      expect(result.toolCallLog).toHaveLength(0);
      expect(result.questionType).toBe("factual");
    });

    it("executes tool calls and continues loop", async () => {
      mockProvider = new MockToolCallingProvider([
        // Iteration 1: model calls search_sessions
        {
          content: "Let me search for information about the dog.",
          toolCalls: [
            makeToolCall("search_sessions", { query: "dog name" }),
          ],
          finishReason: "tool_calls",
          usage: { promptTokens: 300, completionTokens: 60 },
        },
        // Iteration 2: model returns final answer
        {
          content: "The dog's name is Buddy.",
          finishReason: "stop",
          usage: { promptTokens: 500, completionTokens: 30 },
        },
      ]);

      const result = await runAgentLoop("What is the dog's name?", makeDeps());

      expect(result.answer).toBe("The dog's name is Buddy.");
      expect(result.iterations).toBe(2);
      expect(result.toolCallLog).toHaveLength(1);
      expect(result.toolCallLog[0].tool).toBe("search_sessions");
    });

    it("classifies counting questions correctly", async () => {
      mockProvider = new MockToolCallingProvider([
        {
          content: "You have read 5 books.",
          finishReason: "stop",
        },
      ]);

      const result = await runAgentLoop("How many books did you read?", makeDeps());

      expect(result.questionType).toBe("counting");
    });

    it("classifies temporal questions", async () => {
      mockProvider = new MockToolCallingProvider([
        {
          content: "You started learning piano in March 2024.",
          finishReason: "stop",
        },
      ]);

      const result = await runAgentLoop("When did I start learning piano?", makeDeps());

      expect(result.questionType).toBe("temporal");
    });
  });

  // -----------------------------------------------------------------------
  // Loop control
  // -----------------------------------------------------------------------

  describe("Loop control", () => {
    it("forces final answer after max iterations", async () => {
      // Provider always returns tool calls — loop should stop at maxIterations
      const toolCallResponse: ScriptedResponse = {
        content: "Searching further...",
        toolCalls: [makeToolCall("search_sessions", { query: "test" })],
        finishReason: "tool_calls",
        usage: { promptTokens: 200, completionTokens: 50 },
      };

      mockProvider = new MockToolCallingProvider([
        toolCallResponse,
        toolCallResponse,
        toolCallResponse,
        // After max iterations, loop sends a forced-answer prompt and calls
        // chatWithTools one more time — this is the forced final response
        {
          content: "Based on what I found: the answer is 42.",
          finishReason: "stop",
          usage: { promptTokens: 400, completionTokens: 30 },
        },
      ]);

      const result = await runAgentLoop("What is the meaning of life?", makeDeps(), {
        maxIterations: 3,
      });

      expect(result.answer).toBe("Based on what I found: the answer is 42.");
      // iterations = maxIterations (3) + 1 for the forced final answer
      expect(result.iterations).toBe(4);
      expect(result.toolCallLog).toHaveLength(3);
    });

    it("tracks token usage across iterations", async () => {
      mockProvider = new MockToolCallingProvider([
        {
          content: "Searching...",
          toolCalls: [makeToolCall("search_sessions", { query: "test" })],
          finishReason: "tool_calls",
          usage: { promptTokens: 200, completionTokens: 50 },
        },
        {
          content: "Final answer.",
          finishReason: "stop",
          usage: { promptTokens: 400, completionTokens: 80 },
        },
      ]);

      const result = await runAgentLoop("What happened?", makeDeps());

      expect(result.tokenUsage.promptTokens).toBe(200 + 400);
      expect(result.tokenUsage.completionTokens).toBe(50 + 80);
    });
  });

  // -----------------------------------------------------------------------
  // Store availability
  // -----------------------------------------------------------------------

  describe("Store availability", () => {
    it("excludes search_events tool when eventStore is undefined", async () => {
      mockProvider = new MockToolCallingProvider([
        {
          content: "Answer without events.",
          finishReason: "stop",
        },
      ]);

      await runAgentLoop(
        "How many books did you read?",
        makeDeps({ eventStore: undefined }),
      );

      // The mock provider captures the tool list. Since counting questions
      // include search_events in their subset, it should be excluded when
      // eventStore is undefined.
      const toolNames = mockProvider.lastTools.map((t) => t.name);
      expect(toolNames).not.toContain("search_events");
    });

    it("excludes search_knowledge when knowledgeStore is undefined", async () => {
      mockProvider = new MockToolCallingProvider([
        {
          content: "Answer without knowledge.",
          finishReason: "stop",
        },
      ]);

      // factual questions include search_knowledge in their tool subset
      await runAgentLoop(
        "What is the dog's name?",
        makeDeps({ knowledgeStore: undefined }),
      );

      const toolNames = mockProvider.lastTools.map((t) => t.name);
      expect(toolNames).not.toContain("search_knowledge");
    });
  });

  // -----------------------------------------------------------------------
  // Tool execution
  // -----------------------------------------------------------------------

  describe("Tool execution", () => {
    it("search_events returns formatted SVO events", async () => {
      let capturedToolResult = "";

      mockProvider = new MockToolCallingProvider([
        {
          content: "Searching events...",
          toolCalls: [makeToolCall("search_events", { query: "model kit" })],
          finishReason: "tool_calls",
          usage: { promptTokens: 200, completionTokens: 50 },
        },
        {
          content: "Found the event.",
          finishReason: "stop",
          usage: { promptTokens: 400, completionTokens: 30 },
        },
      ]);

      // Wrap the mock provider to capture the tool result from messages
      const originalChat = mockProvider.chatWithTools.bind(mockProvider);
      mockProvider.chatWithTools = async (messages, tools, options) => {
        // On the second call, the messages should contain the tool result
        for (const msg of messages) {
          if (msg.role === "tool") {
            capturedToolResult = msg.content;
          }
        }
        return originalChat(messages, tools, options);
      };

      // Use counting question to get search_events in the tool subset
      await runAgentLoop("How many model kits?", makeDeps());

      expect(capturedToolResult).toContain("user");
      expect(capturedToolResult).toContain("purchased");
      expect(capturedToolResult).toContain("Gundam RX-78 model kit");
    });

    it("get_session returns session text", async () => {
      let capturedToolResult = "";

      mockProvider = new MockToolCallingProvider([
        {
          content: "Let me read the session.",
          toolCalls: [makeToolCall("get_session", { session_id: "session-abc" })],
          finishReason: "tool_calls",
          usage: { promptTokens: 200, completionTokens: 50 },
        },
        {
          content: "Found the answer.",
          finishReason: "stop",
          usage: { promptTokens: 500, completionTokens: 30 },
        },
      ]);

      const originalChat = mockProvider.chatWithTools.bind(mockProvider);
      mockProvider.chatWithTools = async (messages, tools, options) => {
        for (const msg of messages) {
          if (msg.role === "tool") {
            capturedToolResult = msg.content;
          }
        }
        return originalChat(messages, tools, options);
      };

      await runAgentLoop("What is the dog's name?", makeDeps());

      expect(capturedToolResult).toContain("session-abc");
      expect(capturedToolResult).toContain("React dashboard");
    });

    it("get_session handles unknown ID gracefully", async () => {
      let capturedToolResult = "";

      mockProvider = new MockToolCallingProvider([
        {
          content: "Reading session...",
          toolCalls: [makeToolCall("get_session", { session_id: "nonexistent-id" })],
          finishReason: "tool_calls",
          usage: { promptTokens: 200, completionTokens: 50 },
        },
        {
          content: "Could not find it.",
          finishReason: "stop",
          usage: { promptTokens: 400, completionTokens: 30 },
        },
      ]);

      const originalChat = mockProvider.chatWithTools.bind(mockProvider);
      mockProvider.chatWithTools = async (messages, tools, options) => {
        for (const msg of messages) {
          if (msg.role === "tool") {
            capturedToolResult = msg.content;
          }
        }
        return originalChat(messages, tools, options);
      };

      await runAgentLoop("What is the dog's name?", makeDeps());

      expect(capturedToolResult).toContain("No session found");
    });

    it("count_sessions returns count and date range", async () => {
      let capturedToolResult = "";

      mockProvider = new MockToolCallingProvider([
        {
          content: "Counting sessions...",
          toolCalls: [makeToolCall("count_sessions", {})],
          finishReason: "tool_calls",
          usage: { promptTokens: 200, completionTokens: 50 },
        },
        {
          content: "There are 2 sessions.",
          finishReason: "stop",
          usage: { promptTokens: 400, completionTokens: 30 },
        },
      ]);

      const originalChat = mockProvider.chatWithTools.bind(mockProvider);
      mockProvider.chatWithTools = async (messages, tools, options) => {
        for (const msg of messages) {
          if (msg.role === "tool") {
            capturedToolResult = msg.content;
          }
        }
        return originalChat(messages, tools, options);
      };

      // Use a counting question so count_sessions is in the tool subset
      await runAgentLoop("How many conversations do I have?", makeDeps());

      expect(capturedToolResult).toContain("Total sessions");
      expect(capturedToolResult).toContain("2");
    });
  });
});
