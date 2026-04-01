#!/usr/bin/env node

/**
 * PostToolUse hook: track file changes as SVO events.
 *
 * After Edit/Write tools complete, stores a lightweight event
 * (who edited what). Fire-and-forget — never blocks.
 *
 * Register in ~/.claude/settings.json:
 *   PostToolUse -> matcher: "Edit|Write"
 */

import { readSync } from "fs";
import { basename } from "path";
import { SqliteIndexManager } from "../indexing/sqlite-index-manager.js";
import { SqliteEventStore } from "../storage/sqlite-event-store.js";

interface ToolUsePayload {
  tool_name?: string;
  tool_input?: { file_path?: string; command?: string };
  tool_output?: string;
  session_id?: string;
  cwd?: string;
}

function readStdinSync(): string {
  try {
    const buf = Buffer.alloc(1024 * 16);
    const bytesRead = readSync(0, buf, 0, buf.length, null);
    return buf.toString("utf-8", 0, bytesRead);
  } catch {
    return "";
  }
}

async function main(): Promise<void> {
  let payload: ToolUsePayload = {};

  try {
    const input = readStdinSync();
    if (input.trim()) {
      payload = JSON.parse(input);
    }
  } catch {
    process.exit(0);
  }

  const toolName = payload.tool_name || "";
  const filePath = payload.tool_input?.file_path || "";
  const sessionId = payload.session_id || "unknown";
  const cwd = payload.cwd || "";

  if (!filePath) {
    process.exit(0);
  }

  const verb = toolName === "Write" ? "created" : "edited";
  const project = cwd ? basename(cwd) : "";

  try {
    const indexManager = new SqliteIndexManager();
    const eventStore = new SqliteEventStore(indexManager.db);

    await eventStore.addEvents([{
      subject: "claude",
      verb,
      object: filePath,
      startDate: new Date().toISOString().split("T")[0],
      endDate: null,
      aliases: [toolName.toLowerCase(), "file change", "modification"],
      category: "development",
      sessionId,
      project,
      timestamp: Date.now(),
    }]);

    indexManager.close();
  } catch {
    // Silent failure
  }

  process.exit(0);
}

main();
