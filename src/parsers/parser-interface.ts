/**
 * ConversationParser interface for pluggable AI tool parsers.
 * Each parser knows how to detect, discover, and parse sessions
 * from a specific AI coding assistant (Claude Code, Codex, Aider, etc.).
 */

import type { ParsedSession, SessionFileInfo } from "./session-parser.js";

export interface ConversationParser {
  /** Unique identifier: 'claude-code' | 'codex' | 'aider' | etc. */
  readonly id: string;

  /** Human-readable name */
  readonly name: string;

  /** Check if this tool's data exists on this machine */
  detect(): boolean;

  /** Find all session files/entries for this tool */
  discover(): SessionFileInfo[];

  /** Parse a single session into the unified format */
  parse(file: SessionFileInfo): ParsedSession | null;
}
