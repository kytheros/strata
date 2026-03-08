/**
 * Stream-parse session JSONL files from ~/.claude/projects/<encoded-path>/<sessionId>.jsonl
 *
 * Session files contain various message types:
 * - type: "user" — user messages with { message: { role: "user", content: string } }
 * - type: "assistant" — assistant messages with { message: { role: "assistant", content: ContentBlock[] } }
 * - type: "progress" — hook/tool progress events (skip)
 * - type: "file-history-snapshot" — file snapshots (skip)
 *
 * Each message has: parentUuid, uuid, timestamp, cwd, sessionId, type
 */

import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, basename } from "path";
import { CONFIG } from "../config.js";
import {
  extractContent,
  stripSystemReminders,
  type ExtractedContent,
} from "./content-extractor.js";

export interface SessionMessage {
  role: "user" | "assistant";
  text: string;
  toolNames: string[];
  toolInputSnippets: string[];
  hasCode: boolean;
  timestamp: string;
  uuid: string;
}

export interface ParsedSession {
  sessionId: string;
  project: string;
  cwd: string;
  gitBranch: string;
  messages: SessionMessage[];
  startTime: number;
  endTime: number;
  /** Source parser ID (e.g., 'claude-code', 'codex', 'aider') */
  tool?: string;
}

/**
 * Parse a single JSONL line into a SessionMessage (if applicable).
 * Returns null for non-message lines (progress, snapshots, malformed).
 */
function parseLine(line: string): {
  message: SessionMessage | null;
  timestamp: number | null;
  cwd: string | null;
  gitBranch: string | null;
} {
  if (!line.trim()) return { message: null, timestamp: null, cwd: null, gitBranch: null };

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line);
  } catch {
    return { message: null, timestamp: null, cwd: null, gitBranch: null };
  }

  const type = obj.type as string;
  const rawTs = obj.timestamp as string | number | undefined;
  const ts = rawTs
    ? typeof rawTs === "number"
      ? rawTs
      : new Date(rawTs).getTime()
    : null;
  const lineCwd = (obj.cwd as string) || null;
  const lineBranch = (obj.gitBranch as string) || null;

  if (type === "user") {
    const message = obj.message as { role: string; content: unknown } | undefined;
    if (!message) return { message: null, timestamp: ts, cwd: lineCwd, gitBranch: lineBranch };

    const rawContent = message.content;
    let text = "";
    if (typeof rawContent === "string") {
      text = stripSystemReminders(rawContent);
    } else if (Array.isArray(rawContent)) {
      const extracted = extractContent(rawContent);
      text = extracted.text;
    }

    if (text.trim()) {
      return {
        message: {
          role: "user",
          text,
          toolNames: [],
          toolInputSnippets: [],
          hasCode: text.includes("```"),
          timestamp: String(rawTs || ""),
          uuid: (obj.uuid as string) || "",
        },
        timestamp: ts,
        cwd: lineCwd,
        gitBranch: lineBranch,
      };
    }
  } else if (type === "assistant") {
    const message = obj.message as { role: string; content: unknown } | undefined;
    if (!message) return { message: null, timestamp: ts, cwd: lineCwd, gitBranch: lineBranch };

    const extracted: ExtractedContent = extractContent(
      message.content as Parameters<typeof extractContent>[0]
    );

    if (extracted.text.trim() || extracted.toolNames.length > 0) {
      return {
        message: {
          role: "assistant",
          text: extracted.text,
          toolNames: extracted.toolNames,
          toolInputSnippets: extracted.toolInputSnippets,
          hasCode: extracted.hasCode,
          timestamp: String(rawTs || ""),
          uuid: (obj.uuid as string) || "",
        },
        timestamp: ts,
        cwd: lineCwd,
        gitBranch: lineBranch,
      };
    }
  }

  return { message: null, timestamp: ts, cwd: lineCwd, gitBranch: lineBranch };
}

/**
 * Parse a single session JSONL file.
 */
export function parseSessionFile(
  filePath: string,
  projectDir: string
): ParsedSession | null {
  if (!existsSync(filePath)) return null;

  const sessionId = basename(filePath, ".jsonl");
  let cwd = "";
  let gitBranch = "";
  const messages: SessionMessage[] = [];
  let startTime = Infinity;
  let endTime = 0;

  const content = readFileSync(filePath, "utf-8");

  for (const line of content.split("\n")) {
    const parsed = parseLine(line);

    if (parsed.timestamp !== null) {
      if (parsed.timestamp < startTime) startTime = parsed.timestamp;
      if (parsed.timestamp > endTime) endTime = parsed.timestamp;
    }

    if (parsed.cwd && !cwd) cwd = parsed.cwd;
    if (parsed.gitBranch && !gitBranch) gitBranch = parsed.gitBranch;

    if (parsed.message) {
      messages.push(parsed.message);
    }
  }

  if (messages.length === 0) return null;

  return {
    sessionId,
    project: projectDir,
    cwd,
    gitBranch,
    messages,
    startTime: startTime === Infinity ? 0 : startTime,
    endTime,
  };
}

/**
 * Parse a session JSONL file starting from a specific line offset.
 * Returns only the new messages parsed from `fromLine` onward,
 * plus metadata about parsing progress.
 */
export function parsePartial(
  filePath: string,
  fromLine: number
): { messages: SessionMessage[]; linesRead: number; totalLines: number } {
  if (!existsSync(filePath)) {
    return { messages: [], linesRead: 0, totalLines: 0 };
  }

  const content = readFileSync(filePath, "utf-8");
  const allLines = content.split("\n");
  // Don't count trailing empty string from split (file ends with \n)
  const totalLines = allLines.length > 0 && allLines[allLines.length - 1] === ""
    ? allLines.length - 1
    : allLines.length;
  const messages: SessionMessage[] = [];

  for (let i = fromLine; i < totalLines; i++) {
    const parsed = parseLine(allLines[i]);
    if (parsed.message) {
      messages.push(parsed.message);
    }
  }

  return {
    messages,
    linesRead: Math.max(0, totalLines - fromLine),
    totalLines,
  };
}

export interface SessionFileInfo {
  filePath: string;
  projectDir: string;
  sessionId: string;
  mtime: number;
  size: number;
}

/**
 * Enumerate all session JSONL files across all projects.
 */
export function enumerateSessionFiles(): SessionFileInfo[] {
  const projectsDir = CONFIG.projectsDir;
  if (!existsSync(projectsDir)) return [];

  const results: SessionFileInfo[] = [];

  for (const projectDir of readdirSync(projectsDir)) {
    const projectPath = join(projectsDir, projectDir);
    let stat;
    try {
      stat = statSync(projectPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    for (const file of readdirSync(projectPath)) {
      if (!file.endsWith(".jsonl")) continue;

      const filePath = join(projectPath, file);
      try {
        const fstat = statSync(filePath);
        if (!fstat.isFile()) continue;

        results.push({
          filePath,
          projectDir,
          sessionId: basename(file, ".jsonl"),
          mtime: fstat.mtimeMs,
          size: fstat.size,
        });
      } catch {
        continue;
      }
    }
  }

  return results;
}
