/**
 * Codex CLI conversation parser.
 * Reads sessions from ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 *
 * Codex JSONL format uses event types:
 * - thread.started: session start (thread_id)
 * - item.completed: message or action completed
 *   - item.type "userMessage": user text
 *   - item.type "agentMessage": assistant text
 *   - item.type "commandExecution": shell commands run
 *   - item.type "fileChange": file modifications
 * - turn.started / turn.completed: turn boundaries with usage stats
 *
 * CWD is extracted from <environment_context><cwd>...</cwd></environment_context> tags
 * embedded in user message content.
 */

import { existsSync, readdirSync, statSync, readFileSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import type { ConversationParser } from "./parser-interface.js";
import type { ParsedSession, SessionFileInfo, SessionMessage } from "./session-parser.js";

/** Default Codex sessions directory */
const CODEX_SESSIONS_DIR = join(homedir(), ".codex", "sessions");

export class CodexParser implements ConversationParser {
  readonly id = "codex";
  readonly name = "Codex CLI";

  private sessionsDir: string;

  constructor(sessionsDir?: string) {
    this.sessionsDir = sessionsDir ?? CODEX_SESSIONS_DIR;
  }

  /**
   * Check if Codex CLI data exists on this machine.
   */
  detect(): boolean {
    return existsSync(this.sessionsDir);
  }

  /**
   * Find all Codex session JSONL files.
   * Walks ~/.codex/sessions/YYYY/MM/DD/ directories.
   */
  discover(): SessionFileInfo[] {
    if (!existsSync(this.sessionsDir)) return [];

    const results: SessionFileInfo[] = [];

    try {
      // Walk YYYY directories
      for (const yearDir of safeReaddir(this.sessionsDir)) {
        const yearPath = join(this.sessionsDir, yearDir);
        if (!safeIsDir(yearPath)) continue;

        // Walk MM directories
        for (const monthDir of safeReaddir(yearPath)) {
          const monthPath = join(yearPath, monthDir);
          if (!safeIsDir(monthPath)) continue;

          // Walk DD directories
          for (const dayDir of safeReaddir(monthPath)) {
            const dayPath = join(monthPath, dayDir);
            if (!safeIsDir(dayPath)) continue;

            // Find rollout-*.jsonl files
            for (const file of safeReaddir(dayPath)) {
              if (!file.startsWith("rollout-") || !file.endsWith(".jsonl")) continue;

              const filePath = join(dayPath, file);
              try {
                const stat = statSync(filePath);
                if (!stat.isFile()) continue;

                // Extract session ID from filename: rollout-abc123.jsonl -> abc123
                const sessionId = basename(file, ".jsonl").replace(/^rollout-/, "");

                results.push({
                  filePath,
                  projectDir: `codex/${yearDir}/${monthDir}/${dayDir}`,
                  sessionId,
                  mtime: stat.mtimeMs,
                  size: stat.size,
                });
              } catch {
                continue;
              }
            }
          }
        }
      }
    } catch {
      // If directory walk fails, return empty
    }

    return results;
  }

  /** TIRQDP-1.7: return the flat turn list by delegating to parse(). */
  parseTurns(file: SessionFileInfo): import("./session-parser.js").SessionMessage[] {
    return this.parse(file)?.messages ?? [];
  }

  /**
   * Parse a single Codex session JSONL file.
   */
  parse(file: SessionFileInfo): ParsedSession | null {
    if (!existsSync(file.filePath)) return null;

    let content: string;
    try {
      content = readFileSync(file.filePath, "utf-8");
    } catch {
      return null;
    }

    const messages: SessionMessage[] = [];
    let cwd = "";
    let startTime = Infinity;
    let endTime = 0;

    for (const line of content.split("\n")) {
      if (!line.trim()) continue;

      let event: CodexEvent;
      try {
        event = JSON.parse(line) as CodexEvent;
      } catch {
        continue; // Skip malformed lines
      }

      // Track timestamps
      const ts = extractTimestamp(event);
      if (ts > 0) {
        if (ts < startTime) startTime = ts;
        if (ts > endTime) endTime = ts;
      }

      // Extract CWD from environment context
      if (!cwd) {
        cwd = extractCwd(event);
      }

      // Process item.completed events — these contain the actual messages
      if (event.type === "item.completed" && event.item) {
        const msg = parseItem(event.item, ts);
        if (msg) {
          messages.push(msg);
        }
      }
    }

    if (messages.length === 0) return null;

    // Derive project from CWD or use a generic label
    const project = cwd || `codex-session`;

    return {
      sessionId: file.sessionId,
      project,
      cwd,
      gitBranch: "",
      messages,
      startTime: startTime === Infinity ? 0 : startTime,
      endTime,
      tool: this.id,
    };
  }
}

// --- Codex event types ---

interface CodexEvent {
  type: string;
  item?: CodexItem;
  timestamp?: string | number;
  created_at?: string | number;
  thread_id?: string;
  [key: string]: unknown;
}

interface CodexItem {
  type: string;
  role?: string;
  content?: unknown;
  command?: string;
  exit_code?: number;
  output?: string;
  file_path?: string;
  diff?: string;
  [key: string]: unknown;
}

// --- Parsing helpers ---

function parseItem(item: CodexItem, timestamp: number): SessionMessage | null {
  const tsStr = String(timestamp || "");

  if (item.type === "userMessage" || (item.role === "user")) {
    const text = extractText(item.content);
    // Strip environment_context tags from user text
    const cleanText = text.replace(/<environment_context>[\s\S]*?<\/environment_context>/g, "").trim();
    if (!cleanText) return null;

    return {
      role: "user",
      text: cleanText,
      toolNames: [],
      toolInputSnippets: [],
      hasCode: cleanText.includes("```"),
      timestamp: tsStr,
      uuid: "",
    };
  }

  if (item.type === "agentMessage" || (item.role === "assistant")) {
    const text = extractText(item.content);
    if (!text.trim()) return null;

    return {
      role: "assistant",
      text,
      toolNames: [],
      toolInputSnippets: [],
      hasCode: text.includes("```"),
      timestamp: tsStr,
      uuid: "",
    };
  }

  if (item.type === "commandExecution") {
    const command = item.command || "";
    const output = item.output || "";
    const exitCode = item.exit_code ?? 0;
    const text = `[command] ${command}${output ? `\n${output}` : ""}${exitCode !== 0 ? ` (exit ${exitCode})` : ""}`;

    return {
      role: "assistant",
      text,
      toolNames: ["Bash"],
      toolInputSnippets: [command],
      hasCode: true,
      timestamp: tsStr,
      uuid: "",
    };
  }

  if (item.type === "fileChange") {
    const filePath = item.file_path || "";
    const diff = item.diff || "";
    const text = `[file change] ${filePath}${diff ? `\n${diff}` : ""}`;

    return {
      role: "assistant",
      text,
      toolNames: ["Write"],
      toolInputSnippets: [filePath],
      hasCode: true,
      timestamp: tsStr,
      uuid: "",
    };
  }

  // Unknown item type — skip
  return null;
}

/**
 * Extract text from Codex content (string or array of {type, text}).
 */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    return content
      .filter((block): block is { type: string; text: string } =>
        typeof block === "object" && block !== null && "text" in block
      )
      .map((block) => block.text)
      .join("\n");
  }

  return "";
}

/**
 * Extract CWD from <environment_context><cwd>...</cwd></environment_context> tags.
 */
function extractCwd(event: CodexEvent): string {
  // Check in item content
  if (event.item?.content) {
    const text = extractText(event.item.content);
    const match = text.match(/<environment_context>[\s\S]*?<cwd>([^<]+)<\/cwd>[\s\S]*?<\/environment_context>/);
    if (match) return match[1].trim();
  }

  // Check in event-level fields
  if (typeof event.cwd === "string") return event.cwd;

  return "";
}

/**
 * Extract timestamp from various Codex event formats.
 */
function extractTimestamp(event: CodexEvent): number {
  if (event.timestamp) {
    if (typeof event.timestamp === "number") return event.timestamp;
    const ts = new Date(event.timestamp).getTime();
    if (!isNaN(ts)) return ts;
  }
  if (event.created_at) {
    if (typeof event.created_at === "number") return event.created_at;
    const ts = new Date(event.created_at).getTime();
    if (!isNaN(ts)) return ts;
  }
  return 0;
}

/**
 * Safely read a directory, returning empty array on error.
 */
function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Safely check if a path is a directory.
 */
function safeIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
