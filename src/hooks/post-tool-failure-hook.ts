#!/usr/bin/env node

/**
 * PostToolUseFailure hook: auto-search for past solutions when a tool fails.
 *
 * Reads the error from stdin payload, searches Strata's document store via FTS5.
 * If a high-confidence match is found, feeds it back to Claude via stderr (exit 2).
 * If no match, exits 0 silently.
 *
 * Register in ~/.claude/settings.json:
 *   PostToolUseFailure -> matcher: "Bash|Write|Edit"
 */

import { readSync } from "fs";
import { SqliteIndexManager } from "../indexing/sqlite-index-manager.js";

interface ToolFailurePayload {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: string;
  error?: string;
  session_id?: string;
  cwd?: string;
}

function readStdinSync(): string {
  try {
    const buf = Buffer.alloc(1024 * 64);
    const bytesRead = readSync(0, buf, 0, buf.length, null);
    return buf.toString("utf-8", 0, bytesRead);
  } catch {
    return "";
  }
}

async function main(): Promise<void> {
  let payload: ToolFailurePayload = {};

  try {
    const input = readStdinSync();
    if (input.trim()) {
      payload = JSON.parse(input);
    }
  } catch {
    // Malformed payload — exit silently
    process.exit(0);
  }

  const errorText = payload.error || payload.tool_output || "";

  // Skip very short errors (not enough signal for search)
  if (errorText.length < 10) {
    process.exit(0);
  }

  // Truncate very long errors to prevent slow searches
  const searchText = errorText.slice(0, 2000);

  try {
    const indexManager = new SqliteIndexManager();

    // Search the document store via FTS5
    const results = await indexManager.documents.search(searchText, 3);
    indexManager.close();

    // Only inject if we have a match
    const topResult = results[0];
    if (!topResult) {
      process.exit(0);
    }

    // Feed the solution back to Claude via stderr + exit 2
    const chunk = topResult.chunk;
    const date = new Date(chunk.timestamp).toLocaleDateString();
    const project = chunk.project || "unknown";
    const lines = [
      `[Strata] Found a past solution for this error:`,
      ``,
      `In a session on ${date} (project: ${project}):`,
      `"${chunk.text.slice(0, 500)}"`,
      ``,
      `Session: ${chunk.sessionId} (rank: ${Math.abs(topResult.rank).toFixed(2)})`,
    ];

    process.stderr.write(lines.join("\n") + "\n");
    process.exit(2);
  } catch {
    // Database unavailable or search failed — exit silently
    process.exit(0);
  }
}

main();
