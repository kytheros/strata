/**
 * LongMemEval Ingestion Pipeline
 *
 * Converts LongMemEval haystack sessions into Strata document chunks.
 * Creates a fresh in-memory SQLite database per question (each question
 * has its own unique haystack of ~40 sessions).
 *
 * Dataset structure: sessions are parallel arrays:
 *   haystack_sessions[i] = LongMemTurn[] (array of {role, content} turns)
 *   haystack_session_ids[i] = string (session ID)
 *   haystack_dates[i] = string (date string)
 */

import type Database from "better-sqlite3";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteDocumentStore } from "../../src/storage/sqlite-document-store.js";
import { SqliteSearchEngine } from "../../src/search/sqlite-search-engine.js";
import { SqliteKnowledgeStore } from "../../src/storage/sqlite-knowledge-store.js";
import { SqliteEntityStore } from "../../src/storage/sqlite-entity-store.js";
import { SqliteKnowledgeTurnStore } from "../../src/storage/sqlite-knowledge-turn-store.js";
import { GeminiEmbedder } from "../../src/extensions/embeddings/gemini-embedder.js";
import { VectorSearch } from "../../src/extensions/embeddings/vector-search.js";
import { extractEntities, extractRelations } from "../../src/knowledge/entity-extractor.js";
import { extractKnowledge } from "../../src/knowledge/knowledge-extractor.js";
import type { DocumentMetadata } from "../../src/indexing/document-store.js";
import type { ParsedSession, SessionMessage } from "../../src/parsers/session-parser.js";
import type { LongMemQuestion, LongMemTurn } from "./types.js";
import { initBenchmarkSchema, insertSVOEvents } from "./benchmark-schema.js";
import { loadSVOEvents } from "./extract-events.js";

/**
 * Lazily initialized Gemini embedder (shared across all questions).
 * Returns null if GEMINI_API_KEY is not set.
 */
let _embedder: GeminiEmbedder | null | undefined;
function getEmbedder(): GeminiEmbedder | null {
  if (_embedder === undefined) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey) {
      _embedder = new GeminiEmbedder({ apiKey });
    } else {
      _embedder = null;
    }
  }
  return _embedder;
}

/** Rough token count estimate (whitespace split) */
function estimateTokens(text: string): number {
  return Math.ceil(text.split(/\s+/).length);
}

/** Parse session date string to timestamp (ms). Handles "2023/05/20 (Sat) 02:21" format. */
function parseSessionDate(dateStr: string): number {
  // Strip day-of-week in parentheses: "2023/05/20 (Sat) 02:21" → "2023/05/20 02:21"
  const cleaned = dateStr.replace(/\s*\([^)]*\)\s*/, " ").trim();
  const ts = new Date(cleaned).getTime();
  return isNaN(ts) ? Date.now() : ts;
}

/** Convert a session (array of turns) to concatenated text */
function turnsToText(turns: LongMemTurn[]): string {
  return turns
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`)
    .join("\n\n");
}

/**
 * Map Strata sessionId back to LongMemEval session_id.
 * Format: "longmemeval-{idx}" where idx is the index in the haystack arrays.
 */
export function strataSessionIdToIndex(strataSessionId: string): number {
  const match = strataSessionId.match(/^longmemeval-(\d+)$/);
  return match ? parseInt(match[1], 10) : -1;
}

/** Result of ingesting a single question's haystack */
export interface IngestedQuestion {
  db: Database.Database;
  docStore: SqliteDocumentStore;
  searchEngine: SqliteSearchEngine;
  /** Turn store populated with raw conversation turns for TIR+QDP retrieval. */
  turnStore: SqliteKnowledgeTurnStore;
  /** Knowledge store for structured memory entries. */
  knowledgeStore: SqliteKnowledgeStore;
  questionId: string;
  /** Maps haystack index → session ID for retrieval scoring */
  indexToSessionId: string[];
  sessionCount: number;
  chunkCount: number;
  /** Number of turns indexed in knowledge_turns (for TIR+QDP lane). */
  turnCount: number;
  /** Number of SVO events indexed in events_fts (0 if no event cache) */
  eventCount: number;
}

/**
 * Ingest a single question's haystack sessions into a fresh in-memory database.
 * Returns the database, document store, and search engine ready for querying.
 */
export async function ingestQuestion(
  question: LongMemQuestion
): Promise<IngestedQuestion> {
  const db = openDatabase(":memory:");
  const docStore = new SqliteDocumentStore(db);
  const entityStore = new SqliteEntityStore(db);

  // Set up hybrid search if Gemini API key is available
  const embedder = getEmbedder();
  const vectorSearch = embedder ? new VectorSearch(db) : null;

  // Pass embedder to knowledge store so entries get vector embeddings on write
  const knowledgeStore = new SqliteKnowledgeStore(db, embedder);
  // Turn store for TIR+QDP lane: stores raw turns verbatim for FTS5 retrieval.
  const turnStore = new SqliteKnowledgeTurnStore(db);
  const searchEngine = new SqliteSearchEngine(docStore, embedder, vectorSearch, entityStore, knowledgeStore);

  // Prepare embedding storage statement
  const upsertEmbedding = embedder
    ? db.prepare(
        "INSERT OR REPLACE INTO embeddings (entry_id, embedding, model, created_at) VALUES (?, ?, ?, ?)"
      )
    : null;

  let chunkCount = 0;
  const sessions = question.haystack_sessions;
  const sessionIds = question.haystack_session_ids;
  const dates = question.haystack_dates;

  // Collect chunks for batch embedding
  const chunkTexts: string[] = [];
  const chunkIds: string[] = [];

  for (let idx = 0; idx < sessions.length; idx++) {
    const turns = sessions[idx];
    const text = turnsToText(turns);
    const tokenCount = estimateTokens(text);
    const strataSessionId = `longmemeval-${idx}`;
    const dateStr = dates?.[idx] || "";

    const metadata: DocumentMetadata = {
      sessionId: strataSessionId,
      project: "longmemeval",
      role: "mixed",
      timestamp: parseSessionDate(dateStr),
      toolNames: [],
      messageIndex: idx,
    };

    // For long sessions, chunk manually to stay within Strata's chunk size
    const CHUNK_SIZE = 1600;
    if (tokenCount <= CHUNK_SIZE) {
      const docId = await docStore.add(text, tokenCount, metadata, "longmemeval");
      chunkTexts.push(text);
      chunkIds.push(docId);
      chunkCount++;
    } else {
      // Split into chunks by turn boundaries
      const chunks = chunkTurnsBySize(turns, CHUNK_SIZE);
      for (let i = 0; i < chunks.length; i++) {
        const chunkMeta: DocumentMetadata = {
          ...metadata,
          messageIndex: idx * 1000 + i,
        };
        const chunkTokens = estimateTokens(chunks[i]);
        const docId = await docStore.add(chunks[i], chunkTokens, chunkMeta, "longmemeval");
        chunkTexts.push(chunks[i]);
        chunkIds.push(docId);
        chunkCount++;
      }
    }
  }

  // Populate knowledge_turns for the TIR+QDP turn-level retrieval lane.
  // Each raw turn becomes one row in knowledge_turns / knowledge_turns_fts.
  // This mirrors how the production incremental indexer writes turns during ingest.
  let turnCount = 0;
  for (let idx = 0; idx < sessions.length; idx++) {
    const turns = sessions[idx];
    const strataSessionId = `longmemeval-${idx}`;
    const dateStr = dates?.[idx] || "";
    for (let msgIdx = 0; msgIdx < turns.length; msgIdx++) {
      const turn = turns[msgIdx];
      await turnStore.insert({
        sessionId: strataSessionId,
        project: "longmemeval",
        userId: null,
        speaker: turn.role,     // "user" | "assistant"
        content: turn.content,
        messageIndex: msgIdx,
      });
      turnCount++;
    }
  }

  // Extract knowledge + entities from each session for entity-aware retrieval.
  // This populates the knowledge and entities tables so the entity graph
  // channel in SqliteSearchEngine.searchAsync() can find cross-session links.
  for (let idx = 0; idx < sessions.length; idx++) {
    const turns = sessions[idx];
    const text = turnsToText(turns);
    const strataSessionId = `longmemeval-${idx}`;
    const dateStr = dates?.[idx] || "";
    const timestamp = parseSessionDate(dateStr);

    // Build a minimal ParsedSession for the heuristic extractor
    const session: ParsedSession = {
      sessionId: strataSessionId,
      project: "longmemeval",
      cwd: "",
      gitBranch: "",
      messages: turns.map((t, i) => ({
        role: t.role as "user" | "assistant",
        text: t.content,
        toolNames: [],
        toolInputSnippets: [],
        hasCode: t.content.includes("```"),
        timestamp: dateStr,
        uuid: `${strataSessionId}-${i}`,
      })),
      startTime: timestamp,
      endTime: timestamp,
      tool: "longmemeval",
    };

    // Heuristic knowledge extraction (fast, no API calls)
    const knowledge = extractKnowledge(session);
    const storedEntryIds: string[] = [];
    for (const entry of knowledge) {
      await knowledgeStore.addEntry(entry);
      // Check if entry was actually stored (not rejected as duplicate)
      const exists = await knowledgeStore.hasEntry(entry.id);
      if (exists) storedEntryIds.push(entry.id);
    }

    // Entity extraction from session text + knowledge entries
    const allText = knowledge.map((k) => `${k.summary} ${k.details}`).join(" ") + " " + text.slice(0, 2000);
    const entities = extractEntities(allText);

    for (const extracted of entities) {
      const entityId = await entityStore.upsertEntity({
        id: `${strataSessionId}-${extracted.canonicalName}`,
        name: extracted.name,
        type: extracted.type,
        canonicalName: extracted.canonicalName,
        aliases: [extracted.name.toLowerCase()],
        firstSeen: timestamp,
        lastSeen: timestamp,
        project: "longmemeval",
      });

      // Link entities only to knowledge entries that were actually stored
      for (const entryId of storedEntryIds) {
        await entityStore.linkToKnowledge(entryId, entityId);
      }
    }

    // Extract relations between entities
    const relations = extractRelations(allText, entities);
    for (const rel of relations) {
      const sourceEntity = await entityStore.findByName(rel.sourceCanonical);
      const targetEntity = await entityStore.findByName(rel.targetCanonical);
      if (sourceEntity && targetEntity) {
        await entityStore.addRelation({
          sourceEntityId: sourceEntity.id,
          targetEntityId: targetEntity.id,
          relationType: rel.relationType,
          context: rel.context,
          sessionId: strataSessionId,
        });
      }
    }
  }

  // Embed all chunks and store in embeddings table (batch for efficiency)
  if (embedder && upsertEmbedding && chunkTexts.length > 0) {
    // Process in batches of 20 to respect API limits
    const BATCH_SIZE = 20;
    for (let i = 0; i < chunkTexts.length; i += BATCH_SIZE) {
      const batchTexts = chunkTexts.slice(i, i + BATCH_SIZE);
      const batchIds = chunkIds.slice(i, i + BATCH_SIZE);

      try {
        const vectors = await embedder.embedBatch(batchTexts, "RETRIEVAL_DOCUMENT");
        for (let j = 0; j < vectors.length; j++) {
          const vec = vectors[j];
          const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
          upsertEmbedding.run(batchIds[j], buf, "gemini-embedding-001", Date.now());
        }
      } catch (err) {
        // Embedding failed — continue without vector search for this question
        console.error(`  [embed] Failed batch ${i}-${i + BATCH_SIZE}:`, err);
        break;
      }
    }
  }

  // Wait for async knowledge embeddings to flush (fire-and-forget in addEntry)
  if (embedder) {
    await new Promise((r) => setTimeout(r, 1500));
  }

  // Initialize benchmark-only schema (events + events_fts tables)
  initBenchmarkSchema(db);

  // Load SVO events from cache and index in events_fts
  const svoEvents = loadSVOEvents(question.question_id);
  let eventCount = 0;
  if (svoEvents.length > 0) {
    eventCount = insertSVOEvents(db, svoEvents);
  }

  return {
    db,
    docStore,
    searchEngine,
    turnStore,
    knowledgeStore,
    questionId: question.question_id,
    indexToSessionId: sessionIds,
    sessionCount: sessions.length,
    chunkCount,
    turnCount,
    eventCount,
  };
}

/**
 * Chunk turns by size, keeping chunks under maxTokens.
 * Preserves complete turns — never splits mid-turn.
 */
function chunkTurnsBySize(turns: LongMemTurn[], maxTokens: number): string[] {
  const chunks: string[] = [];
  let currentChunk = "";
  let currentTokens = 0;

  for (const turn of turns) {
    const turnText = `${turn.role === "user" ? "User" : "Assistant"}: ${turn.content}\n\n`;
    const turnTokens = estimateTokens(turnText);

    if (currentTokens + turnTokens > maxTokens && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = "";
      currentTokens = 0;
    }

    currentChunk += turnText;
    currentTokens += turnTokens;
  }

  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

/** Close an ingested question's database */
export function closeIngested(ingested: IngestedQuestion): void {
  ingested.db.close();
}
