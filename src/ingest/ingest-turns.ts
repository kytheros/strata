import { randomUUID } from "node:crypto";
import { chunkSession } from "../indexing/chunk-session.js";
import { extractKnowledge } from "../knowledge/knowledge-extractor.js";
import type { ParsedSession, SessionMessage } from "../parsers/session-parser.js";
import type { IKnowledgeTurnStore, KnowledgeTurnInput } from "../storage/interfaces/knowledge-turn-store.js";
import type { IDocumentStore } from "../storage/interfaces/document-store.js";
import type { IKnowledgeStore } from "../storage/interfaces/knowledge-store.js";

const VALID_SPEAKERS = new Set(["user", "assistant", "system"]);

export interface IngestTurnsMessage {
  speaker: "user" | "assistant" | "system";
  content: string;
  created_at?: number; // epoch ms
}

export interface IngestTurnsInput {
  sessionId: string;
  project?: string;
  userId?: string;
  messages: IngestTurnsMessage[];
}

export interface IngestTurnsResult {
  sessionId: string;
  turnsWritten: number;
  chunksWritten: number;
  entriesWritten: number;
  embedded: boolean;
  warnings: string[];
}

export interface IngestTurnsDeps {
  turnStore: IKnowledgeTurnStore | null;
  documents: IDocumentStore;
  knowledge: IKnowledgeStore;
  /** True when the turn store was built with an embedding provider (dense vectors written). */
  embedderPresent: boolean;
}

/** Build a ParsedSession for chunking + heuristic knowledge extraction.
 *  'system' turns are folded as a prefix into the next user message
 *  (ParsedSession only models user|assistant). */
export function buildParsedSession(input: IngestTurnsInput): ParsedSession {
  const project = input.project ?? "global";
  const messages: SessionMessage[] = [];
  const times: number[] = [];
  let systemPrefix = "";
  for (const m of input.messages) {
    const ts = m.created_at ?? Date.now();
    times.push(ts);
    if (m.speaker === "system") { systemPrefix += (systemPrefix ? "\n" : "") + m.content; continue; }
    const text = systemPrefix ? `${systemPrefix}\n${m.content}` : m.content;
    systemPrefix = "";
    messages.push({
      role: m.speaker === "assistant" ? "assistant" : "user",
      text,
      toolNames: [],
      toolInputSnippets: [],
      hasCode: /```|\bfunction\b|=>/.test(text),
      timestamp: new Date(ts).toISOString(),
      uuid: randomUUID(),
    });
  }
  return {
    sessionId: input.sessionId, project, cwd: "", gitBranch: "", messages,
    startTime: times.length ? Math.min(...times) : Date.now(),
    endTime: times.length ? Math.max(...times) : Date.now(),
    tool: "ingest",
  };
}

function validate(input: IngestTurnsInput): void {
  if (!input.sessionId || !input.sessionId.trim()) throw new Error("ingestTurns: sessionId is required");
  if (!Array.isArray(input.messages) || input.messages.length === 0) throw new Error("ingestTurns: messages must be a non-empty array");
  input.messages.forEach((m, i) => {
    if (!VALID_SPEAKERS.has(m.speaker)) throw new Error(`ingestTurns: message[${i}] has invalid speaker '${m.speaker}'`);
  });
}

/** Drop messages whose content is empty or whitespace-only. Real conversations
 *  carry empty turns (tool-only turns, redacted content, client quirks) — skip
 *  them rather than reject the whole session. Returns the kept list + drop count. */
function dropEmptyMessages(messages: IngestTurnsMessage[]): { kept: IngestTurnsMessage[]; dropped: number } {
  const kept = messages.filter((m) => typeof m.content === "string" && m.content.trim().length > 0);
  return { kept, dropped: messages.length - kept.length };
}

/**
 * Shared conversation-turn write-path (#30). Replace-session, then write the
 * load-bearing 3 reps: turns(+dense vectors when embedderPresent), doc chunks
 * (FTS), heuristic knowledge entries. Synchronous & awaited.
 */
export async function ingestTurns(deps: IngestTurnsDeps, input: IngestTurnsInput): Promise<IngestTurnsResult> {
  validate(input);
  const project = input.project ?? "global";
  const userId = input.userId;
  const warnings: string[] = [];

  // Normalize BEFORE any destructive write: drop empty-content turns, and bail
  // on an all-empty payload so replace-session can't wipe a session in exchange
  // for nothing.
  const { kept: messages, dropped } = dropEmptyMessages(input.messages);
  if (messages.length === 0) throw new Error("ingestTurns: all messages have empty content");
  if (dropped > 0) warnings.push(`skipped ${dropped} empty-content message(s)`);

  // 1) Replace-session: clear all 3 reps for this session.
  if (deps.turnStore) await deps.turnStore.deleteBySessionId(input.sessionId);
  await deps.documents.removeSession(input.sessionId);
  await deps.knowledge.deleteBySessionId(input.sessionId, userId);

  // 2) Turns (+ dense vectors when an embedder is attached to the store).
  let turnsWritten = 0;
  if (deps.turnStore) {
    const turns: KnowledgeTurnInput[] = messages.map((m, i) => ({
      sessionId: input.sessionId, project, userId: userId ?? null,
      speaker: m.speaker, content: m.content, messageIndex: i, createdAt: m.created_at,
    }));
    const ids = await deps.turnStore.bulkInsert(turns);
    turnsWritten = ids.length;
  } else {
    warnings.push("turn store unavailable: dense-turn lane not written (no provider and keyless turn store not wired)");
  }

  // 3) Doc chunks (FTS). tokenCount = whitespace word count (matches production ingest).
  const session = buildParsedSession({ ...input, messages });
  let chunksWritten = 0;
  for (const chunk of chunkSession(session)) {
    await deps.documents.add(chunk.text, chunk.text.split(/\s+/).length, {
      sessionId: input.sessionId, project, role: chunk.role,
      timestamp: chunk.timestamp, toolNames: chunk.toolNames, messageIndex: chunk.messageIndex,
    }, "ingest", userId ?? "default");
    chunksWritten++;
  }

  // 4) Heuristic knowledge entries (keyless). Stamp tenant scope, then await embeds.
  let entriesWritten = 0;
  for (const entry of extractKnowledge(session)) {
    if (userId) entry.user = userId;
    entry.project = project;
    await deps.knowledge.addEntry(entry);
    entriesWritten++;
  }
  await deps.knowledge.flushPendingEmbeddings();

  const embedded = deps.embedderPresent && turnsWritten > 0;
  if (!embedded && deps.turnStore) warnings.push("dense-turn embeddings skipped: no embedding provider");

  return { sessionId: input.sessionId, turnsWritten, chunksWritten, entriesWritten, embedded, warnings };
}
