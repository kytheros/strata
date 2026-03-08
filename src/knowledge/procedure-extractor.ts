/**
 * Heuristic procedure extraction from parsed sessions.
 *
 * Detects multi-step workflows in assistant messages using:
 * 1. Numbered lists (1. 2. 3. or Step 1: Step 2:)
 * 2. Ordinal language flows (first...then...next...finally)
 * 3. Sequential tool-use sessions (3+ Bash/Write/Edit in a row)
 *
 * Returns KnowledgeEntry[] with type="procedure" and ProcedureDetails JSON in details.
 */

import { randomUUID } from "crypto";
import type { ParsedSession } from "../parsers/session-parser.js";
import type { KnowledgeEntry } from "./knowledge-store.js";
import { extractTags, extractFilePaths } from "./knowledge-extractor.js";

/** Structured procedure data stored as JSON in the details field. */
export interface ProcedureDetails {
  steps: string[];
  prerequisites?: string[];
  warnings?: string[];
}

/** Max characters per message to scan (prevents catastrophic regex backtracking). */
const MAX_SCAN_LENGTH = 2000;

/** Tool names that indicate sequential tool-use sessions. */
const TOOL_USE_NAMES = ["bash", "write", "edit", "read"];

/**
 * Parse a ProcedureDetails JSON string, returning null on malformed input.
 */
export function parseProcedureDetails(details: string): ProcedureDetails | null {
  try {
    const parsed = JSON.parse(details);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray(parsed.steps) ||
      parsed.steps.length < 2
    ) {
      return null;
    }
    // Validate steps are strings
    if (!parsed.steps.every((s: unknown) => typeof s === "string")) {
      return null;
    }
    return parsed as ProcedureDetails;
  } catch {
    return null;
  }
}

/**
 * Extract procedures from a parsed session.
 * Only scans assistant messages. Returns entries with type="procedure".
 */
export function extractProcedures(session: ParsedSession): KnowledgeEntry[] {
  const entries: KnowledgeEntry[] = [];
  const messages = session.messages;
  if (!messages || messages.length === 0) return entries;

  // Track which message indices to scan (assistant messages)
  const assistantIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "assistant") {
      assistantIndices.push(i);
    }
  }

  // Also detect sequential tool-use sessions and prioritize nearby assistant text
  const toolUseIndices = findSequentialToolUseIndices(messages);

  // Combine: all assistant messages + assistant messages following tool-use sequences
  const indicesToScan = new Set(assistantIndices);
  for (const endIdx of toolUseIndices) {
    // Scan assistant messages after the tool-use sequence
    for (let j = endIdx + 1; j < messages.length && j <= endIdx + 3; j++) {
      if (messages[j].role === "assistant") {
        indicesToScan.add(j);
      }
    }
  }

  const seen = new Set<string>();

  for (const i of indicesToScan) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;

    const text = msg.text.slice(0, MAX_SCAN_LENGTH);

    // Skip error messages
    if (isErrorMessage(text)) continue;

    // Try each detection method
    const procedures = [
      ...extractNumberedList(text),
      ...extractStepHeaders(text),
      ...extractOrdinalFlow(text),
    ];

    for (const proc of procedures) {
      if (proc.steps.length < 2) continue;

      // Dedup by normalized title
      const key = proc.title.toLowerCase().trim().slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);

      const details: ProcedureDetails = { steps: proc.steps.slice(0, 20) };

      entries.push({
        id: randomUUID(),
        type: "procedure",
        project: session.project,
        sessionId: session.sessionId,
        timestamp: msg.timestamp
          ? new Date(msg.timestamp).getTime()
          : session.startTime,
        summary: proc.title.slice(0, 200),
        details: JSON.stringify(details),
        tags: extractTags(text),
        relatedFiles: extractFilePaths(text),
      });
    }
  }

  return entries;
}

// ── Detection helpers ───────────────────────────────────────────────

interface RawProcedure {
  title: string;
  steps: string[];
}

/**
 * Detect numbered lists: 1. Step one\n2. Step two\n3. Step three
 * Also matches: 1) Step one
 */
function extractNumberedList(text: string): RawProcedure[] {
  const results: RawProcedure[] = [];

  // Match sequences of numbered items
  const numberedPattern = /(?:^|\n)\s*(\d+)[.)]\s+(.+)/g;
  const items: Array<{ num: number; text: string; index: number }> = [];

  let match: RegExpExecArray | null;
  while ((match = numberedPattern.exec(text)) !== null) {
    items.push({
      num: parseInt(match[1], 10),
      text: match[2].trim(),
      index: match.index,
    });
  }

  if (items.length < 2) return results;

  // Group consecutive numbered items into sequences
  let seqStart = 0;
  for (let i = 1; i <= items.length; i++) {
    const isBreak =
      i === items.length ||
      items[i].num <= items[i - 1].num ||
      items[i].num - items[i - 1].num > 2;

    if (isBreak && i - seqStart >= 2) {
      const steps = items.slice(seqStart, i).map((item) => item.text);
      const title = inferTitle(text, items[seqStart].index);
      results.push({ title, steps });
    }

    if (isBreak) {
      seqStart = i;
    }
  }

  return results;
}

/**
 * Detect step headers: Step 1: ..., Step 2: ...
 */
function extractStepHeaders(text: string): RawProcedure[] {
  const pattern = /(?:^|\n)\s*[Ss]tep\s+(\d+)\s*:\s*(.+)/g;
  const items: Array<{ num: number; text: string; index: number }> = [];

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    items.push({
      num: parseInt(match[1], 10),
      text: match[2].trim(),
      index: match.index,
    });
  }

  if (items.length < 2) return [];

  const steps = items.map((item) => item.text);
  const title = inferTitle(text, items[0].index);
  return [{ title, steps }];
}

/**
 * Detect ordinal flows: first...then...next...finally
 * Requires at least 3 ordinal markers.
 */
function extractOrdinalFlow(text: string): RawProcedure[] {
  const ordinals = [
    /\b[Ff]irst(?:ly)?,?\s+(.{10,150}?)(?:\.|$)/,
    /\b[Tt]hen,?\s+(.{10,150}?)(?:\.|$)/,
    /\b[Nn]ext,?\s+(.{10,150}?)(?:\.|$)/,
    /\b[Aa]fter\s+that,?\s+(.{10,150}?)(?:\.|$)/,
    /\b[Ff]inally,?\s+(.{10,150}?)(?:\.|$)/,
    /\b[Ll]astly,?\s+(.{10,150}?)(?:\.|$)/,
  ];

  const steps: string[] = [];
  for (const pattern of ordinals) {
    const match = text.match(pattern);
    if (match) {
      steps.push(match[1].trim().replace(/\.$/, ""));
    }
  }

  if (steps.length < 3) return [];

  // Use first sentence as title
  const firstSentence = text.match(/^(.{10,100}?)[.:]/);
  const title = firstSentence
    ? firstSentence[1].trim()
    : "Workflow procedure";

  return [{ title, steps }];
}

// ── Utility helpers ─────────────────────────────────────────────────

/**
 * Infer a procedure title from the text preceding the first step.
 * Only uses the preceding sentence if it ends with a colon.
 */
function inferTitle(text: string, firstStepIndex: number): string {
  const before = text.slice(Math.max(0, firstStepIndex - 200), firstStepIndex);
  const lines = before.split("\n").filter((l) => l.trim().length > 0);

  if (lines.length > 0) {
    const lastLine = lines[lines.length - 1].trim();
    // Only use as title if it ends with a colon (spec gotcha #3)
    if (lastLine.endsWith(":")) {
      return lastLine.slice(0, -1).trim().slice(0, 200);
    }
    // Also accept "Here's how to..." style lines
    if (/^(?:here'?s?\s+how|how\s+to|to\s+\w+)/i.test(lastLine)) {
      return lastLine.replace(/[:\s]+$/, "").trim().slice(0, 200);
    }
  }

  return "Extracted procedure";
}

/**
 * Find indices where 3+ sequential tool-use messages occur.
 * Returns the end index of each detected sequence.
 */
function findSequentialToolUseIndices(
  messages: ParsedSession["messages"]
): number[] {
  const results: number[] = [];
  let streak = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const hasToolUse =
      msg.toolNames &&
      msg.toolNames.some((t) =>
        TOOL_USE_NAMES.includes(t.toLowerCase())
      );

    if (hasToolUse) {
      streak++;
    } else {
      if (streak >= 3) {
        results.push(i - 1);
      }
      streak = 0;
    }
  }

  if (streak >= 3) {
    results.push(messages.length - 1);
  }

  return results;
}

/**
 * Check if text is primarily an error message (should not be extracted as procedure).
 */
function isErrorMessage(text: string): boolean {
  const errorIndicators =
    /^(?:error|Error|ERROR|exception|Exception|Traceback|FATAL|panic)/;
  const firstLine = text.split("\n")[0];
  return errorIndicators.test(firstLine.trim());
}
