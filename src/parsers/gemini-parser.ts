/**
 * Gemini CLI conversation parser.
 *
 * Supports two formats:
 *
 * **v1 (legacy)**: ~/.gemini/tmp/<project_hash>/chats/checkpoint-<tag>.json
 *   - JSON array of {role, parts} objects
 *   - Parts: {text}, {functionCall}, {functionResponse}
 *
 * **v2 (current, ≥0.30)**: ~/.gemini/tmp/<project>/chats/session-<tag>.json
 *   - JSON object with {sessionId, messages: [{type, content, toolCalls}]}
 *   - type: "user" | "gemini"
 *   - content: string or [{text}]
 *   - toolCalls: [{name, args, result}]
 */

import { existsSync, readdirSync, statSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { ConversationParser } from "./parser-interface.js";
import type { ParsedSession, SessionFileInfo, SessionMessage } from "./session-parser.js";

/** Default Gemini CLI tmp directory */
const GEMINI_TMP_DIR = join(homedir(), ".gemini", "tmp");

export class GeminiParser implements ConversationParser {
  readonly id = "gemini-cli";
  readonly name = "Gemini CLI";

  private tmpDir: string;

  constructor(tmpDir?: string) {
    this.tmpDir = tmpDir ?? GEMINI_TMP_DIR;
  }

  detect(): boolean {
    return existsSync(this.tmpDir);
  }

  discover(): SessionFileInfo[] {
    if (!existsSync(this.tmpDir)) return [];

    const results: SessionFileInfo[] = [];

    try {
      for (const projectName of safeReaddir(this.tmpDir)) {
        const projectDir = join(this.tmpDir, projectName);
        if (!safeIsDir(projectDir)) continue;

        const chatsDir = join(projectDir, "chats");
        if (!existsSync(chatsDir) || !safeIsDir(chatsDir)) continue;

        for (const file of safeReaddir(chatsDir)) {
          // Accept both checkpoint-*.json (v1) and session-*.json (v2)
          const isCheckpoint = file.startsWith("checkpoint-") && file.endsWith(".json");
          const isSession = file.startsWith("session-") && file.endsWith(".json");
          if (!isCheckpoint && !isSession) continue;

          const filePath = join(chatsDir, file);
          try {
            const stat = statSync(filePath);
            if (!stat.isFile()) continue;

            const tag = file.replace(/^(?:checkpoint|session)-/, "").replace(/\.json$/, "");
            const sessionId = `${projectName}-${tag}`;

            results.push({
              filePath,
              projectDir: `gemini/${projectName}`,
              sessionId,
              mtime: stat.mtimeMs,
              size: stat.size,
            });
          } catch {
            continue;
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

  parse(file: SessionFileInfo): ParsedSession | null {
    if (!existsSync(file.filePath)) return null;

    let content: string;
    try {
      content = readFileSync(file.filePath, "utf-8");
    } catch {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return null;
    }

    // Detect format: v2 is an object with .messages, v1 is a bare array
    if (Array.isArray(parsed)) {
      return this.parseV1(parsed, file);
    }
    if (parsed && typeof parsed === "object" && "messages" in parsed) {
      return this.parseV2(parsed as GeminiV2Session, file);
    }

    return null;
  }

  // ── v1: Legacy checkpoint format (array of {role, parts}) ───────────

  /**
   * Extract the project name portion of `file.projectDir`.
   * The indexer sets projectDir to `gemini/<projectName>`; return `<projectName>`
   * so parsed sessions carry a non-empty cwd for recall and display.
   *
   * Gemini CLI derives projectName from path.basename(cwd) with collision
   * suffixes (e.g. "strata", "strata-1"), so this is the best proxy for the
   * original working directory without an authoritative reverse mapping.
   */
  private extractProjectName(file: SessionFileInfo): string {
    if (!file.projectDir) return "";
    const normalized = file.projectDir.replace(/\\/g, "/");
    if (normalized.startsWith("gemini/")) return normalized.slice("gemini/".length);
    return normalized;
  }

  private parseV1(rawMessages: unknown[], file: SessionFileInfo): ParsedSession | null {
    const messages: SessionMessage[] = [];
    const createTimes: number[] = [];

    for (const raw of rawMessages) {
      const msg = raw as GeminiV1Message;
      if (!msg || typeof msg.role !== "string") continue;
      if (!Array.isArray(msg.parts)) continue;

      let msgTimestamp = "";
      if (typeof msg.createTime === "string" && msg.createTime) {
        const parsed = new Date(msg.createTime).getTime();
        if (!isNaN(parsed)) {
          createTimes.push(parsed);
          msgTimestamp = msg.createTime;
        }
      }

      const textParts: string[] = [];
      const toolNames: string[] = [];
      const toolInputSnippets: string[] = [];

      for (const part of msg.parts) {
        if (!part || typeof part !== "object") continue;

        if ("text" in part && typeof part.text === "string") {
          textParts.push(part.text);
        }

        if ("functionCall" in part && part.functionCall) {
          const fc = part.functionCall as { name?: string; args?: unknown };
          const name = fc.name || "unknown";
          toolNames.push(name);
          textParts.push(`[tool: ${name}]`);
          if (fc.args) {
            const snippet = typeof fc.args === "string"
              ? fc.args.slice(0, 200)
              : JSON.stringify(fc.args).slice(0, 200);
            toolInputSnippets.push(snippet);
          }
        }

        if ("functionResponse" in part && part.functionResponse) {
          const fr = part.functionResponse as { name?: string; response?: unknown };
          const name = fr.name || "unknown";
          const respStr = fr.response
            ? (typeof fr.response === "string" ? fr.response : JSON.stringify(fr.response))
            : "";
          textParts.push(`[tool result: ${name}] ${respStr.slice(0, 500)}`);
        }
      }

      const text = textParts.join("\n");
      if (!text.trim()) continue;

      const role = msg.role === "user" ? "user" as const : "assistant" as const;

      messages.push({
        role,
        text,
        toolNames,
        toolInputSnippets,
        hasCode: text.includes("```"),
        timestamp: msgTimestamp,
        uuid: "",
      });
    }

    if (messages.length === 0) return null;

    let startTime: number;
    let endTime: number;

    if (createTimes.length > 0) {
      startTime = Math.min(...createTimes);
      endTime = Math.max(...createTimes);
    } else {
      endTime = file.mtime;
      startTime = file.mtime - (messages.length * 30_000);
    }

    return {
      sessionId: file.sessionId,
      project: file.projectDir,
      cwd: this.extractProjectName(file),
      gitBranch: "",
      messages,
      startTime,
      endTime,
      tool: this.id,
    };
  }

  // ── v2: Current session format ({sessionId, messages}) ──────────────

  private parseV2(session: GeminiV2Session, file: SessionFileInfo): ParsedSession | null {
    const messages: SessionMessage[] = [];
    const timestamps: number[] = [];

    if (!Array.isArray(session.messages)) return null;

    for (const msg of session.messages) {
      if (!msg || typeof msg.type !== "string") continue;

      const msgTimestamp = typeof msg.timestamp === "string" ? msg.timestamp : "";
      if (msgTimestamp) {
        const parsed = new Date(msgTimestamp).getTime();
        if (!isNaN(parsed)) timestamps.push(parsed);
      }

      const textParts: string[] = [];
      const toolNames: string[] = [];
      const toolInputSnippets: string[] = [];

      // Extract text content
      if (typeof msg.content === "string") {
        textParts.push(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
            textParts.push(part.text);
          }
        }
      }

      // Extract tool calls
      if (Array.isArray(msg.toolCalls)) {
        for (const tc of msg.toolCalls) {
          if (!tc || typeof tc !== "object") continue;
          const name = (tc as GeminiV2ToolCall).name || "unknown";
          toolNames.push(name);
          textParts.push(`[tool: ${name}]`);

          const args = (tc as GeminiV2ToolCall).args;
          if (args) {
            const snippet = typeof args === "string"
              ? args.slice(0, 200)
              : JSON.stringify(args).slice(0, 200);
            toolInputSnippets.push(snippet);
          }
        }
      }

      const text = textParts.join("\n");
      if (!text.trim()) continue;

      // Map type to role: "user" -> user, "gemini" -> assistant
      const role = msg.type === "user" ? "user" as const : "assistant" as const;

      messages.push({
        role,
        text,
        toolNames,
        toolInputSnippets,
        hasCode: text.includes("```"),
        timestamp: msgTimestamp,
        uuid: (msg as { id?: string }).id || "",
      });
    }

    if (messages.length === 0) return null;

    let startTime: number;
    let endTime: number;

    if (timestamps.length > 0) {
      startTime = Math.min(...timestamps);
      endTime = Math.max(...timestamps);
    } else if (session.startTime) {
      startTime = new Date(session.startTime).getTime() || file.mtime;
      endTime = session.lastUpdated
        ? new Date(session.lastUpdated).getTime() || file.mtime
        : file.mtime;
    } else {
      endTime = file.mtime;
      startTime = file.mtime - (messages.length * 30_000);
    }

    return {
      sessionId: session.sessionId || file.sessionId,
      project: file.projectDir,
      cwd: this.extractProjectName(file),
      gitBranch: "",
      messages,
      startTime,
      endTime,
      tool: this.id,
    };
  }
}

// --- v1 types ---

interface GeminiV1Message {
  role: string;
  parts: unknown[];
  createTime?: string;
}

// --- v2 types ---

interface GeminiV2Session {
  sessionId?: string;
  projectHash?: string;
  startTime?: string;
  lastUpdated?: string;
  messages: GeminiV2Message[];
}

interface GeminiV2Message {
  type: string;
  content: string | Array<{ text?: string }>;
  toolCalls?: unknown[];
  timestamp?: string;
}

interface GeminiV2ToolCall {
  name?: string;
  args?: unknown;
}

// --- Helpers ---

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
