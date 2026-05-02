/**
 * Cline conversation parser.
 * Reads sessions from VS Code globalStorage/saoudrizwan.claude-dev/tasks/<taskId>/
 *
 * Each task directory contains:
 * - api_conversation_history.json: Array of {role, content} messages (primary)
 * - ui_messages.json: UI-facing message history (not parsed)
 * - task_metadata.json: Optional metadata (task name, timestamps)
 *
 * Paths vary by platform:
 * - Windows: %APPDATA%/Code/User/globalStorage/saoudrizwan.claude-dev/tasks/
 * - macOS: ~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/tasks/
 * - Linux: ~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/tasks/
 */

import { existsSync, readdirSync, statSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { ConversationParser } from "./parser-interface.js";
import type { ParsedSession, SessionFileInfo, SessionMessage } from "./session-parser.js";

/** Resolve the Cline tasks directory based on platform */
function defaultTasksDir(): string {
  const platform = process.platform;
  if (platform === "win32") {
    const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    return join(appData, "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "tasks");
  }
  if (platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "tasks");
  }
  // Linux and other Unix
  return join(homedir(), ".config", "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "tasks");
}

export class ClineParser implements ConversationParser {
  readonly id = "cline";
  readonly name = "Cline";

  private tasksDir: string;

  constructor(tasksDir?: string) {
    this.tasksDir = tasksDir ?? defaultTasksDir();
  }

  /**
   * Check if Cline data exists on this machine.
   */
  detect(): boolean {
    return existsSync(this.tasksDir);
  }

  /**
   * Find all Cline task directories that contain conversation history.
   */
  discover(): SessionFileInfo[] {
    if (!existsSync(this.tasksDir)) return [];

    const results: SessionFileInfo[] = [];

    try {
      for (const taskId of safeReaddir(this.tasksDir)) {
        const taskDir = join(this.tasksDir, taskId);
        if (!safeIsDir(taskDir)) continue;

        const apiFile = join(taskDir, "api_conversation_history.json");
        if (!existsSync(apiFile)) continue;

        try {
          const stat = statSync(apiFile);
          if (!stat.isFile()) continue;

          results.push({
            filePath: apiFile,
            projectDir: `cline/${taskId}`,
            sessionId: taskId,
            mtime: stat.mtimeMs,
            size: stat.size,
          });
        } catch {
          continue;
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
   * Parse a single Cline task's api_conversation_history.json.
   */
  parse(file: SessionFileInfo): ParsedSession | null {
    if (!existsSync(file.filePath)) return null;

    let content: string;
    try {
      content = readFileSync(file.filePath, "utf-8");
    } catch {
      return null;
    }

    let rawMessages: ClineMessage[];
    try {
      rawMessages = JSON.parse(content) as ClineMessage[];
    } catch {
      return null;
    }

    if (!Array.isArray(rawMessages)) return null;

    const messages: SessionMessage[] = [];
    let startTime = Infinity;
    let endTime = 0;

    for (const msg of rawMessages) {
      if (!msg || typeof msg.role !== "string") continue;

      const text = extractClineText(msg.content);
      if (!text.trim()) continue;

      const toolNames: string[] = [];
      const toolInputSnippets: string[] = [];

      // Extract tool use from content blocks
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block && typeof block === "object" && "type" in block) {
            const b = block as ContentBlock;
            if (b.type === "tool_use" && b.name) {
              toolNames.push(b.name);
              if (b.input) {
                const snippet = typeof b.input === "string"
                  ? b.input.slice(0, 200)
                  : JSON.stringify(b.input).slice(0, 200);
                toolInputSnippets.push(snippet);
              }
            }
            if (b.type === "tool_result" && typeof b.content === "string") {
              // Tool results are part of the conversation but already captured in text
            }
          }
        }
      }

      // Extract timestamp from msg if available
      const ts = msg.ts ? msg.ts : 0;
      if (ts > 0) {
        if (ts < startTime) startTime = ts;
        if (ts > endTime) endTime = ts;
      }

      const role = msg.role === "user" ? "user" as const : "assistant" as const;

      messages.push({
        role,
        text,
        toolNames,
        toolInputSnippets,
        hasCode: text.includes("```"),
        timestamp: ts ? String(ts) : "",
        uuid: "",
      });
    }

    if (messages.length === 0) return null;

    // Try to read metadata for project info
    const metadata = readTaskMetadata(file.filePath);

    return {
      sessionId: file.sessionId,
      project: metadata.project || `cline-task`,
      cwd: metadata.cwd || "",
      gitBranch: "",
      messages,
      startTime: startTime === Infinity ? 0 : startTime,
      endTime,
      tool: this.id,
    };
  }
}

// --- Cline types ---

interface ClineMessage {
  role: string;
  content: unknown;
  ts?: number;
}

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  tool_use_id?: string;
}

// --- Helpers ---

/**
 * Extract text from Cline message content (string or array of content blocks).
 */
function extractClineText(content: unknown): string {
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block);
      } else if (block && typeof block === "object" && "type" in block) {
        const b = block as ContentBlock;
        if (b.type === "text" && typeof b.text === "string") {
          parts.push(b.text);
        } else if (b.type === "tool_use" && b.name) {
          parts.push(`[tool: ${b.name}]`);
        } else if (b.type === "tool_result" && typeof b.content === "string") {
          parts.push(`[tool result] ${b.content.slice(0, 500)}`);
        }
      }
    }
    return parts.join("\n");
  }

  return "";
}

/**
 * Try to read task_metadata.json from the same directory as the API history file.
 */
function readTaskMetadata(apiFilePath: string): { project: string; cwd: string } {
  try {
    const dir = apiFilePath.replace(/[/\\]api_conversation_history\.json$/, "");
    const metaPath = join(dir, "task_metadata.json");
    if (!existsSync(metaPath)) return { project: "", cwd: "" };

    const raw = JSON.parse(readFileSync(metaPath, "utf-8"));
    return {
      project: (typeof raw.task_name === "string" ? raw.task_name : "") ||
               (typeof raw.project === "string" ? raw.project : ""),
      cwd: typeof raw.cwd === "string" ? raw.cwd : "",
    };
  } catch {
    return { project: "", cwd: "" };
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function safeIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
