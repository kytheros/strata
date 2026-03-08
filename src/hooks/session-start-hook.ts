#!/usr/bin/env node

/**
 * Session-start hook: auto-inject project context on new Claude Code session.
 *
 * Reads pre-computed summaries and knowledge from SQLite database
 * and outputs brief context to stdout. Target: <200ms.
 *
 * Register in ~/.claude/settings.json as a SessionStart hook.
 */

import { encodeProjectPath, extractProjectName } from "../utils/path-encoder.js";
import { SqliteIndexManager } from "../indexing/sqlite-index-manager.js";
import type { RecurringIssue } from "../knowledge/learning-synthesizer.js";
import { existsSync, readFileSync } from "fs";
import { CONFIG } from "../config.js";

function main(): void {
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
    const summaries = indexManager.summaries.getByProject(projectDir);
    const knowledge = indexManager.knowledge.getProjectEntries(projectDir)
      .filter((e) => e.type !== "learning");
    const globalLearnings = indexManager.knowledge.getGlobalLearnings(projectDir);
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

    if (lines.length > 1) {
      console.log(lines.join("\n"));
    }

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
