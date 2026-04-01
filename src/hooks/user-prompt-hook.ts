#!/usr/bin/env node

/**
 * UserPromptSubmit hook: inject relevant context when user's prompt
 * matches trigger patterns (errors, recall language, debugging).
 *
 * Silent when no trigger matches (<1ms). Runs a fast search only
 * when triggered (<100ms total). Outputs context to stdout (exit 0).
 *
 * Register in ~/.claude/settings.json:
 *   UserPromptSubmit -> matcher: "*"
 */

import { readSync } from "fs";
import { SqliteIndexManager } from "../indexing/sqlite-index-manager.js";

interface PromptPayload {
  prompt?: string;
  session_id?: string;
  cwd?: string;
}

const TRIGGERS = [
  { pattern: /\b(error|exception|failed|crash|ECONNREFUSED|TypeError|ReferenceError|SyntaxError|ENOENT|EPERM|ENOMEM)\b/i, type: "error" as const },
  { pattern: /\b(how did we|what did we decide|last time|remember when|didn't we already|have we ever|what was our)\b/i, type: "recall" as const },
  { pattern: /\b(why is|what's wrong|broken again|still failing|keeps happening|won't work|not working)\b/i, type: "debug" as const },
  { pattern: /\b(should we use|which approach|what's our pattern|best practice for)\b/i, type: "decision" as const },
];

function readStdinSync(): string {
  try {
    const buf = Buffer.alloc(1024 * 64);
    const bytesRead = readSync(0, buf, 0, buf.length, null);
    return buf.toString("utf-8", 0, bytesRead);
  } catch {
    return "";
  }
}

export function detectTrigger(prompt: string): { type: string; match: string } | null {
  for (const trigger of TRIGGERS) {
    const match = prompt.match(trigger.pattern);
    if (match) {
      return { type: trigger.type, match: match[0] };
    }
  }
  return null;
}

async function main(): Promise<void> {
  let payload: PromptPayload = {};

  try {
    const input = readStdinSync();
    if (input.trim()) {
      payload = JSON.parse(input);
    }
  } catch {
    process.exit(0);
  }

  const prompt = payload.prompt || "";
  if (!prompt.trim()) {
    process.exit(0);
  }

  // Fast path: check triggers before touching the database
  const trigger = detectTrigger(prompt);
  if (!trigger) {
    process.exit(0);
  }

  try {
    const indexManager = new SqliteIndexManager();
    const searchQuery = trigger.type === "error" ? prompt : prompt.replace(/[?!.]/g, "");
    const results = await indexManager.documents.search(searchQuery, 3);
    indexManager.close();

    // Only inject if we have relevant results
    if (results.length === 0) {
      process.exit(0);
    }

    const lines = [
      `[Strata] Relevant context from past sessions:`,
    ];
    for (const r of results.slice(0, 3)) {
      const date = new Date(r.chunk.timestamp).toLocaleDateString();
      const project = r.chunk.project || "unknown";
      const snippet = r.chunk.text.slice(0, 200).replace(/\n/g, " ");
      lines.push(`- (${date}, ${project}): "${snippet}"`);
    }

    process.stdout.write(lines.join("\n") + "\n");
    process.exit(0);
  } catch {
    process.exit(0);
  }
}

main();
