/**
 * Claude Code conversation parser.
 * Wraps the existing session-parser.ts functions behind the ConversationParser interface.
 */

import { existsSync, readdirSync, statSync } from "fs";
import { join, basename } from "path";
import { CONFIG } from "../config.js";
import type { ConversationParser } from "./parser-interface.js";
import {
  enumerateSessionFiles,
  parseSessionFile,
  type ParsedSession,
  type SessionFileInfo,
} from "./session-parser.js";

export class ClaudeCodeParser implements ConversationParser {
  readonly id = "claude-code";
  readonly name = "Claude Code";

  private projectsDir: string;

  constructor(projectsDir?: string) {
    this.projectsDir = projectsDir ?? CONFIG.projectsDir;
  }

  /**
   * Check if Claude Code data exists on this machine.
   * Returns true when the projects directory exists.
   */
  detect(): boolean {
    return existsSync(this.projectsDir);
  }

  /**
   * Find all Claude Code session JSONL files.
   */
  discover(): SessionFileInfo[] {
    if (this.projectsDir !== CONFIG.projectsDir) {
      return enumerateSessionFilesIn(this.projectsDir);
    }
    return enumerateSessionFiles();
  }

  /**
   * Parse a single Claude Code session file.
   * Delegates to the existing parseSessionFile() and adds the tool field.
   */
  parse(file: SessionFileInfo): ParsedSession | null {
    const session = parseSessionFile(file.filePath, file.projectDir);
    if (!session) return null;

    return {
      ...session,
      tool: this.id,
    };
  }
}

/**
 * Enumerate session files in a custom projects directory.
 * Mirrors the logic of enumerateSessionFiles() but with a custom root.
 */
function enumerateSessionFilesIn(projectsDir: string): SessionFileInfo[] {
  if (!existsSync(projectsDir)) return [];

  const results: SessionFileInfo[] = [];

  for (const projectDir of safeReaddir(projectsDir)) {
    const projectPath = join(projectsDir, projectDir);
    if (!safeIsDir(projectPath)) continue;

    for (const file of safeReaddir(projectPath)) {
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
