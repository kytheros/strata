#!/usr/bin/env node

/**
 * Session-start hook: auto-inject project context on new AI assistant session.
 *
 * Supports both Claude Code (plain text stdout) and Gemini CLI (JSON stdout).
 * Reads pre-computed summaries and knowledge from SQLite database
 * and outputs brief context to stdout. Target: <200ms.
 *
 * Claude Code: Register in ~/.claude/settings.json as a SessionStart hook.
 * Gemini CLI: Register in ~/.gemini/settings.json or via extension hooks.json.
 */

import { encodeProjectPath, extractProjectName } from "../utils/path-encoder.js";
import { SqliteIndexManager } from "../indexing/sqlite-index-manager.js";
import type { RecurringIssue } from "../knowledge/learning-synthesizer.js";
import { listGaps } from "../search/evidence-gaps.js";
import { existsSync, readFileSync } from "fs";
import { CONFIG } from "../config.js";

/**
 * Detect whether the hook is running under Gemini CLI.
 * Gemini CLI sets GEMINI_PROJECT_DIR and/or GEMINI_CONVERSATION_ID
 * in the hook execution environment.
 */
function isGeminiCli(): boolean {
  if (process.env.GEMINI_PROJECT_DIR) return true;
  if (process.env.GEMINI_CONVERSATION_ID) return true;
  return false;
}

/**
 * Log a message to the appropriate stream.
 * In Gemini mode, stdout must be clean JSON only, so all debug/log
 * output goes to stderr. In Claude Code mode, logging is suppressed
 * (the hook only communicates via stdout).
 */
function log(message: string): void {
  if (isGeminiCli()) {
    process.stderr.write(message + "\n");
  }
  // Claude Code mode: no logging (stdout is for context output only)
}

/**
 * Read stdin with a timeout. Gemini CLI sends a JSON payload to stdin;
 * Claude Code sends nothing. We wait briefly (100ms) for data, then proceed.
 *
 * Returns the accumulated stdin data (may be empty for Claude Code).
 */
function drainStdin(timeoutMs: number = 100): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    let resolved = false;

    const finish = () => {
      if (!resolved) {
        resolved = true;
        process.stdin.pause();
        process.stdin.removeAllListeners("data");
        process.stdin.removeAllListeners("end");
        resolve(data);
      }
    };

    process.stdin.setEncoding("utf-8");
    process.stdin.resume();
    process.stdin.on("data", (chunk: string) => { data += chunk; });
    process.stdin.on("end", finish);

    // Don't block forever waiting for stdin (Claude Code sends nothing)
    setTimeout(finish, timeoutMs);
  });
}

/**
 * Emit the context output in the appropriate format.
 * - Gemini CLI: JSON with hookSpecificOutput wrapper
 * - Claude Code: plain text
 */
function emitOutput(lines: string[]): void {
  if (lines.length <= 1) {
    // No meaningful content — emit nothing
    return;
  }

  const context = lines.join("\n");

  if (isGeminiCli()) {
    const output = {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: context,
      },
    };
    process.stdout.write(JSON.stringify(output) + "\n");
  } else {
    process.stdout.write(context + "\n");
  }
}

/**
 * Handle compaction trigger — re-inject condensed context that would
 * otherwise be lost when Claude compacts the conversation.
 * Focuses on session-specific decisions and active work, not full project history.
 */
async function handleCompact(): Promise<void> {
  const lines: string[] = ["[Strata] Context preserved through compaction:"];

  try {
    const indexManager = new SqliteIndexManager();

    // Get recent decisions and solutions
    const recentKnowledge = await indexManager.knowledge.search("");
    const sessionKnowledge = recentKnowledge
      .filter((k) => k.type === "decision" || k.type === "solution" || k.type === "error_fix")
      .slice(0, 5);

    if (sessionKnowledge.length > 0) {
      lines.push("");
      lines.push("Recent decisions and fixes:");
      for (const k of sessionKnowledge) {
        lines.push(`- [${k.type}] ${k.summary}`);
      }
    }

    // Get active evidence gaps (things searched but not found)
    try {
      const gaps = listGaps(indexManager.db, { limit: 3, minOccurrences: 2 });
      if (gaps.length > 0) {
        lines.push("");
        lines.push("Knowledge gaps (searched but unanswered):");
        for (const g of gaps) {
          lines.push(`- "${g.query}" (searched ${g.occurrenceCount}x)`);
        }
      }
    } catch {
      // Gap injection is best-effort
    }

    indexManager.close();
  } catch {
    // Database unavailable — emit what we have
  }

  emitOutput(lines);
}

async function main(): Promise<void> {
  // Drain stdin: Gemini CLI sends a JSON payload, Claude Code sends nothing.
  // Must consume stdin to prevent Gemini CLI from blocking on pipe write.
  const stdinData = await drainStdin(100);

  // Parse stdin payload if present (Gemini CLI)
  if (stdinData) {
    try {
      const payload = JSON.parse(stdinData);
      if (payload.source === "clear") {
        // User invoked /clear — don't inject context
        process.exit(0);
      }
      // Compact trigger — inject condensed session context instead of full project context
      if (payload.trigger === "compact" || payload.source === "compact") {
        await handleCompact();
        process.exit(0);
      }
    } catch {
      // Not valid JSON (unexpected) or empty — proceed normally
    }
  }

  const cwd = process.cwd();
  const projectDir = encodeProjectPath(cwd);
  const projectName = extractProjectName(cwd);

  let indexManager: SqliteIndexManager;
  try {
    indexManager = new SqliteIndexManager();
  } catch {
    // Database not yet created — nothing to inject
    return;
  }

  try {
    // Load recent summaries for this project
    const summaries = await indexManager.summaries.getByProject(projectDir);
    const knowledge = (await indexManager.knowledge.getProjectEntries(projectDir))
      .filter((e) => e.type !== "learning");
    const globalLearnings = await indexManager.knowledge.getGlobalLearnings(projectDir);
    const recurringIssue = loadTopRecurringIssue();

    if (
      summaries.length === 0 &&
      knowledge.length === 0 &&
      globalLearnings.length === 0 &&
      !recurringIssue
    ) {
      indexManager.close();
      return;
    }

    const lines: string[] = [`[Strata] Previous context for ${projectName}:`];

    // Show last 3 session summaries
    for (const summary of summaries.slice(0, 3)) {
      const daysAgo = Math.floor((Date.now() - summary.endTime) / 86400000);
      const timeStr =
        daysAgo === 0
          ? "today"
          : daysAgo === 1
            ? "yesterday"
            : `${daysAgo} days ago`;
      const topic =
        summary.topic.length > 80
          ? summary.topic.slice(0, 80) + "..."
          : summary.topic;
      lines.push(`- Last session (${timeStr}): ${topic}`);
    }

    // Show key decisions/solutions
    const decisions = knowledge.filter((k) => k.type === "decision").slice(0, 2);
    for (const d of decisions) {
      lines.push(`- Key decision: ${d.summary}`);
    }

    const solutions = knowledge.filter((k) => k.type === "solution").slice(0, 2);
    for (const s of solutions) {
      lines.push(`- Solution found: ${s.summary}`);
    }

    // Show unresolved issues (errors without fixes)
    const errorFixes = knowledge.filter((k) => k.type === "error_fix").slice(0, 1);
    for (const ef of errorFixes) {
      lines.push(`- Error fix: ${ef.summary}`);
    }

    // Show synthesized learnings (max 3)
    for (const l of globalLearnings.slice(0, 3)) {
      lines.push(`- Learning: ${l.summary}`);
    }

    // Show top recurring issue
    if (recurringIssue) {
      lines.push(
        `- Recurring: ${recurringIssue.tag} issues (${recurringIssue.count} occurrences)`
      );
    }

    // Tool guidance block
    lines.push("");
    lines.push("[Strata] Available memory tools:");
    lines.push(`- Hit an error? → find_solutions "error message" to check past fixes`);
    lines.push(`- Making a decision? → store_memory "text" type=decision to remember it`);
    lines.push(`- Need project context? → get_project_context project="name"`);
    lines.push(`- Searching past work? → search_history "query" for full-text search`);

    // Gap-aware injection: surface frequently searched but unanswered topics
    try {
      const gaps = listGaps(indexManager.db, {
        project: projectDir,
        status: "open",
        minOccurrences: 2,
        limit: 3,
      });
      if (gaps.length > 0) {
        lines.push("");
        lines.push("[Strata] Knowledge gaps (searched but never answered):");
        for (const gap of gaps) {
          lines.push(`- "${gap.query}" (searched ${gap.occurrenceCount} times)`);
        }
        lines.push("If you learn about these topics, use store_memory to fill the gap.");
      }
    } catch {
      // Gap injection is best-effort
    }

    emitOutput(lines);

    indexManager.close();
  } catch {
    try { indexManager.close(); } catch { /* ignore */ }
  }
}

function loadTopRecurringIssue(): RecurringIssue | null {
  if (!existsSync(CONFIG.recurringIssuesFile)) return null;

  try {
    const issues = JSON.parse(
      readFileSync(CONFIG.recurringIssuesFile, "utf-8")
    ) as RecurringIssue[];
    return issues.length > 0 ? issues[0] : null;
  } catch {
    return null;
  }
}

main();
