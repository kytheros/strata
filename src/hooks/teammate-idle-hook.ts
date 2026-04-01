#!/usr/bin/env node

/**
 * TeammateIdle hook: auto-save agent work context when a teammate goes idle.
 *
 * Stores a lightweight episodic memory of which agent was active,
 * in which session and project. Fire-and-forget — never blocks.
 *
 * Register in ~/.claude/settings.json:
 *   TeammateIdle -> matcher: "*"
 */

import { readSync } from "fs";
import { SqliteIndexManager } from "../indexing/sqlite-index-manager.js";
import { randomUUID } from "crypto";

interface TeammateIdlePayload {
  agent_name?: string;
  session_id?: string;
  cwd?: string;
  status?: string;
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
  let payload: TeammateIdlePayload = {};

  try {
    const input = readStdinSync();
    if (input.trim()) {
      payload = JSON.parse(input);
    }
  } catch {
    process.exit(0);
  }

  const agentName = payload.agent_name || "unknown-agent";
  const sessionId = payload.session_id || "unknown-session";
  const cwd = payload.cwd || "";

  try {
    const indexManager = new SqliteIndexManager();
    await indexManager.knowledge.addEntry({
      id: randomUUID(),
      type: "episodic",
      project: cwd ? cwd.split(/[/\\]/).pop() || "" : "",
      sessionId,
      timestamp: Date.now(),
      summary: `Agent '${agentName}' went idle`,
      details: `Session: ${sessionId}\nWorking directory: ${cwd}`,
      tags: ["agent-idle", agentName],
      relatedFiles: [],
      occurrences: 1,
      projectCount: 1,
    });
    indexManager.close();
  } catch {
    // Database unavailable — exit silently
  }

  process.exit(0);
}

main();
