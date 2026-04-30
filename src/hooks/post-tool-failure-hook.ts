#!/usr/bin/env node

/**
 * PostToolUseFailure hook: auto-search for past solutions when a tool fails.
 *
 * Reads the error from stdin payload, searches Strata's document store via FTS5.
 * Only surfaces a match when (a) it comes from the same project as the failing
 * session and (b) it is not effectively the same error text we just searched on
 * (which would be a recurring-error duplicate, not a fix). Qualifying matches
 * are fed back to Claude via stderr + exit 2; everything else exits 0 silently.
 *
 * Register in ~/.claude/settings.json:
 *   PostToolUseFailure -> matcher: "Bash|Write|Edit"
 */

import { readSync } from "fs";
import { SqliteIndexManager } from "../indexing/sqlite-index-manager.js";
import { encodeProjectPath } from "../utils/path-encoder.js";

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

  // Same-project scoping: only surface matches from the failing session's own
  // project. Without a cwd we can't scope, so exit silently rather than risk
  // injecting cross-project noise as a "solution".
  if (!payload.cwd) {
    process.exit(0);
  }
  const currentProject = encodeProjectPath(payload.cwd);

  try {
    const indexManager = new SqliteIndexManager();

    // Pull a wider candidate set; we'll filter to same-project below.
    const results = await indexManager.documents.search(searchText, 10);
    indexManager.close();

    const topResult = results.find((r) => r.chunk.project === currentProject);
    if (!topResult) {
      process.exit(0);
    }

    // Avoid surfacing the same error back to itself: if the matched chunk is
    // mostly the same text as our search query, it's a recurring error from a
    // prior session, not a fix.
    if (isNearDuplicate(searchText, topResult.chunk.text)) {
      process.exit(0);
    }

    // Feed the solution back to Claude via stderr + exit 2
    const chunk = topResult.chunk;
    const date = new Date(chunk.timestamp).toLocaleDateString();
    const lines = [
      `[Strata] Found a past solution for this error:`,
      ``,
      `In a session on ${date} (project: ${chunk.project}):`,
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

function isNearDuplicate(a: string, b: string): boolean {
  // Token-set Jaccard on the leading 500 chars. Cheap and good enough to
  // catch the "this hook surfaced the same error as its own solution" case.
  const tokenize = (s: string) =>
    new Set(
      s.slice(0, 500).toLowerCase().split(/\W+/).filter((t) => t.length > 2),
    );
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return false;
  let overlap = 0;
  for (const t of ta) if (tb.has(t)) overlap++;
  const union = ta.size + tb.size - overlap;
  return overlap / union >= 0.8;
}

main();
