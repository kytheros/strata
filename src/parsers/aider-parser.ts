/**
 * Aider conversation parser.
 * Reads sessions from .aider.chat.history.md files.
 *
 * Aider uses a markdown-based chat history format:
 * - User messages are prefixed with `#### ` (H4 heading)
 * - Assistant responses follow as plain text until the next `#### ` or EOF
 * - Files are typically located in project roots alongside .aider* config
 *
 * Common locations:
 * - <project>/.aider.chat.history.md (per-project history)
 * - ~/.aider.chat.history.md (global fallback, rare)
 */

import { existsSync, readdirSync, statSync, readFileSync } from "fs";
import { join, basename, dirname } from "path";
import { homedir } from "os";
import type { ConversationParser } from "./parser-interface.js";
import type { ParsedSession, SessionFileInfo, SessionMessage } from "./session-parser.js";

/** Well-known directories to scan for .aider.chat.history.md files */
const SCAN_DIRS = [
  homedir(),
  join(homedir(), "projects"),
  join(homedir(), "repos"),
  join(homedir(), "src"),
  join(homedir(), "code"),
  join(homedir(), "dev"),
  join(homedir(), "workspace"),
  join(homedir(), "Documents"),
];

const HISTORY_FILENAME = ".aider.chat.history.md";
const INPUT_HISTORY_FILENAME = ".aider.input.history";
const USER_PREFIX = "#### ";

export class AiderParser implements ConversationParser {
  readonly id = "aider";
  readonly name = "Aider";

  private scanDirs: string[];

  constructor(scanDirs?: string[]) {
    this.scanDirs = scanDirs ?? SCAN_DIRS;
  }

  /**
   * Check if Aider chat history files exist in any scanned location.
   */
  detect(): boolean {
    for (const dir of this.scanDirs) {
      if (findAiderFiles(dir).length > 0) return true;
    }
    return false;
  }

  /**
   * Find all .aider.chat.history.md files across scanned directories.
   */
  discover(): SessionFileInfo[] {
    const seen = new Set<string>();
    const results: SessionFileInfo[] = [];

    for (const dir of this.scanDirs) {
      for (const filePath of findAiderFiles(dir)) {
        if (seen.has(filePath)) continue;
        seen.add(filePath);

        try {
          const stat = statSync(filePath);
          if (!stat.isFile()) continue;

          // Use the parent directory name as session/project identifier
          const projectDir = dirname(filePath);
          const projectName = basename(projectDir);
          // Create a stable session ID from the file path
          const sessionId = `aider-${simpleHash(filePath)}`;

          results.push({
            filePath,
            projectDir: projectName,
            sessionId,
            mtime: stat.mtimeMs,
            size: stat.size,
          });
        } catch {
          continue;
        }
      }
    }

    return results;
  }

  /**
   * Parse an .aider.chat.history.md file into a unified session.
   */
  parse(file: SessionFileInfo): ParsedSession | null {
    if (!existsSync(file.filePath)) return null;

    let content: string;
    try {
      content = readFileSync(file.filePath, "utf-8");
    } catch {
      return null;
    }

    const messages = parseAiderMarkdown(content);
    if (messages.length === 0) return null;

    // Try to get file mtime as end time
    let endTime = 0;
    try {
      endTime = statSync(file.filePath).mtimeMs;
    } catch {
      // ignore
    }

    return {
      sessionId: file.sessionId,
      project: file.projectDir,
      cwd: dirname(file.filePath),
      gitBranch: "",
      messages,
      startTime: 0, // Aider history doesn't have timestamps per message
      endTime,
      tool: this.id,
    };
  }
}

/**
 * Parse Aider's markdown chat history format.
 *
 * Format:
 * ```
 * #### user message here
 *
 * assistant response here
 * spanning multiple lines
 *
 * #### next user message
 * ```
 */
export function parseAiderMarkdown(content: string): SessionMessage[] {
  const messages: SessionMessage[] = [];
  const lines = content.split("\n");

  let currentRole: "user" | "assistant" | null = null;
  let currentLines: string[] = [];

  const flush = () => {
    if (currentRole && currentLines.length > 0) {
      const text = currentLines.join("\n").trim();
      if (text) {
        messages.push({
          role: currentRole,
          text,
          toolNames: currentRole === "assistant" ? extractAiderTools(text) : [],
          toolInputSnippets: [],
          hasCode: text.includes("```"),
          timestamp: "",
          uuid: "",
        });
      }
    }
    currentLines = [];
  };

  for (const line of lines) {
    if (line.startsWith(USER_PREFIX)) {
      // Flush any pending message
      flush();

      // Start new user message (strip the #### prefix)
      currentRole = "user";
      const userText = line.slice(USER_PREFIX.length);
      if (userText.trim()) {
        currentLines.push(userText);
      }
    } else if (currentRole === "user" && !line.startsWith(USER_PREFIX)) {
      // If we hit a non-#### line after a user message, the user message
      // is complete and this is the start of assistant response
      if (line.trim() === "" && currentLines.length > 0) {
        // Empty line after user message — flush user, switch to assistant
        flush();
        currentRole = "assistant";
      } else if (currentLines.length > 0) {
        // Non-empty line — this is assistant content
        flush();
        currentRole = "assistant";
        currentLines.push(line);
      }
    } else if (currentRole === "assistant") {
      currentLines.push(line);
    }
  }

  // Flush final message
  flush();

  return messages;
}

/**
 * Extract tool-like references from Aider assistant responses.
 * Aider logs file edits inline; look for common patterns.
 */
function extractAiderTools(text: string): string[] {
  const tools: string[] = [];

  // Aider shows file edit blocks like:
  // ```python
  // path/to/file.py
  // <<<<<<< SEARCH
  if (text.includes("<<<<<<< SEARCH") || text.includes(">>>>>>> REPLACE")) {
    tools.push("Edit");
  }

  // Shell commands shown as ```bash blocks
  if (/```(?:bash|shell|sh)\n/i.test(text)) {
    tools.push("Bash");
  }

  // Deduplicate
  return [...new Set(tools)];
}

/** Max subdirectory depth for findAiderFiles. Root = depth 0. */
const AIDER_MAX_DEPTH = 3;

/** Directories that are never worth scanning for aider history files. */
const AIDER_SKIP_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", "vendor", "dist", "build",
  "__pycache__", ".cache", ".npm", ".yarn", "Library", "AppData",
  "Application Data", ".Trash", "$RECYCLE.BIN",
]);

/**
 * Find .aider.chat.history.md files under `dir`, recursing up to
 * AIDER_MAX_DEPTH subdirectory levels. Skips large/irrelevant trees.
 *
 * Depth of 3 covers the common case of home → workspace/ → project/ and
 * home → code/ → org/ → repo/ without descending into deeply nested vendor
 * trees. Raising it further has diminishing returns and meaningful I/O cost
 * on Windows filesystems.
 */
function findAiderFiles(dir: string, depth: number = 0): string[] {
  if (depth > AIDER_MAX_DEPTH) return [];
  if (!existsSync(dir)) return [];

  const results: string[] = [];

  // Check the directory itself
  const directFile = join(dir, HISTORY_FILENAME);
  if (existsSync(directFile)) {
    results.push(directFile);
  }

  try {
    for (const entry of readdirSync(dir)) {
      if (AIDER_SKIP_DIRS.has(entry)) continue;
      // Skip hidden dirs (but not .aider files themselves)
      if (entry.startsWith(".") && !entry.startsWith(".aider")) continue;

      const subDir = join(dir, entry);
      try {
        if (!statSync(subDir).isDirectory()) continue;
      } catch {
        continue;
      }

      // Recurse into subdirectory (depth-first)
      const nested = findAiderFiles(subDir, depth + 1);
      if (nested.length > 0) results.push(...nested);
    }
  } catch {
    // Directory not readable
  }

  return results;
}

/**
 * Simple string hash for generating stable session IDs from file paths.
 */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return Math.abs(hash).toString(36);
}
