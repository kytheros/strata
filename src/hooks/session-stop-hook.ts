#!/usr/bin/env node

/**
 * Session-stop hook: extract knowledge + incremental reindex on session end.
 *
 * Reads the session transcript (provided via stdin payload), parses it,
 * extracts evaluated knowledge, caches a summary, and triggers incremental
 * index update via SQLite. Target: <5s for typical sessions.
 *
 * Register in ~/.claude/settings.json as a Stop hook.
 */

import { existsSync } from "fs";
import { basename, dirname } from "path";
import { parseSessionFile } from "../parsers/session-parser.js";
import { extractEvaluatedKnowledge } from "../knowledge/knowledge-extractor.js";
import { summarizeSession } from "../knowledge/session-summarizer.js";
import { SqliteIndexManager } from "../indexing/sqlite-index-manager.js";

interface StopPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
}

async function main(): Promise<void> {
  let payload: StopPayload = {};

  try {
    let input = "";
    // Read stdin synchronously
    const buf = Buffer.alloc(1024 * 64);
    let bytesRead: number;
    try {
      bytesRead = require("fs").readSync(0, buf, 0, buf.length, null);
      input = buf.toString("utf-8", 0, bytesRead);
    } catch {
      // stdin may not be available
    }
    if (input.trim()) {
      payload = JSON.parse(input);
    }
  } catch {
    // Silent failure — best effort
  }

  const transcriptPath = payload.transcript_path;
  if (!transcriptPath || !existsSync(transcriptPath)) {
    // No transcript to process
    return;
  }

  const sessionId = payload.session_id || basename(transcriptPath, ".jsonl");
  const projectDir = basename(dirname(transcriptPath));

  try {
    // 1. Parse the session
    const session = parseSessionFile(transcriptPath, projectDir);
    if (!session || session.messages.length < 3) {
      // Skip very short sessions (noise)
      return;
    }

    // 2. Open SQLite and store summary
    const indexManager = new SqliteIndexManager();

    const summary = summarizeSession(session);
    await indexManager.summaries.save(summary);

    // 3. Extract knowledge with evaluation + dedup
    const existingEntries = await indexManager.knowledge.getAllEntries();
    const newKnowledge = extractEvaluatedKnowledge(session, existingEntries);

    if (newKnowledge.length > 0) {
      for (const entry of newKnowledge) {
        await indexManager.knowledge.addEntry(entry);
      }
    }

    // 3b. LLM-powered extraction (when Gemini is available)
    if (process.env.GEMINI_API_KEY) {
      try {
        const { enhancedExtract } = await import("../extensions/llm-extraction/enhanced-extractor.js");
        const { GeminiProvider } = await import("../extensions/llm-extraction/gemini-provider.js");
        const provider = new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY });
        const enhanced = await Promise.race([
          enhancedExtract(session, provider, indexManager.db),
          new Promise<null>((_, reject) => setTimeout(() => reject(new Error("timeout")), 8000)),
        ]);
        if (enhanced && enhanced.length > 0) {
          for (const entry of enhanced) {
            await indexManager.knowledge.upsertEntry(entry);
          }
        }
      } catch {
        // LLM extraction failed or timed out — heuristic results already stored
      }
    }

    // 4. Incremental index update
    indexManager.incrementalUpdate();

    // 5. Close database
    indexManager.close();
  } catch {
    // Silent failure — hooks must never crash
  }
}

main();
