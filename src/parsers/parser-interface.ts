/**
 * ConversationParser interface for pluggable AI tool parsers.
 * Each parser knows how to detect, discover, and parse sessions
 * from a specific AI coding assistant (Claude Code, Codex, Aider, etc.).
 */

import type { ParsedSession, SessionFileInfo, SessionMessage } from "./session-parser.js";

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

  /**
   * Return the flat list of turns (SessionMessage[]) from a session file.
   *
   * Additive and optional — callers fall back to `parse(file)?.messages ?? []`
   * when they need backwards-compatible behaviour. Each adapter overrides this
   * with a one-line delegation; the default implementation here is the
   * canonical fallback so that any future parser that omits an override still
   * works correctly.
   *
   * Per TIRQDP-1.7 Q3 resolution: all five existing adapters already produce
   * `ParsedSession.messages[]` in the required shape (speaker/content/uuid),
   * so each override is pure delegation, no new parsing logic.
   */
  parseTurns(file: SessionFileInfo): SessionMessage[];
}
