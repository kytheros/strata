#!/usr/bin/env node

/**
 * SubagentStart hook: inject Strata MCP awareness into spawned agents.
 *
 * When any subagent starts, this hook injects a brief context reminder that
 * Strata MCP tools are available for searching past conversations,
 * finding solutions to errors, and retrieving project context.
 *
 * This ensures agents proactively use history tools during debugging,
 * feature implementation, and error resolution — without requiring
 * explicit instructions in every agent definition.
 */

import { readFileSync } from "fs";

interface SubagentStartPayload {
  session_id?: string;
  hook_event_name?: string;
  cwd?: string;
}

function main(): void {
  let payload: SubagentStartPayload = {};

  try {
    const buf = Buffer.alloc(1024 * 16);
    let bytesRead: number;
    try {
      bytesRead = require("fs").readSync(0, buf, 0, buf.length, null);
      const input = buf.toString("utf-8", 0, bytesRead);
      if (input.trim()) {
        payload = JSON.parse(input);
      }
    } catch {
      // stdin may not be available
    }
  } catch {
    // Silent failure
  }

  const context = [
    "You have access to Strata MCP tools for searching past AI coding conversations:",
    "- search_history: Full-text search across all past sessions (supports project:, before:, after: filters)",
    "- find_solutions: Search for solutions to errors/problems from past sessions",
    "- get_project_context: Get comprehensive context for the current project",
    "- list_projects: See all projects with conversation history",
    "",
    "Use these tools when: debugging errors you may have seen before, implementing features similar to past work, or needing context about prior decisions.",
  ].join("\n");

  const output = {
    hookSpecificOutput: {
      hookEventName: "SubagentStart",
      additionalContext: context,
    },
  };

  console.log(JSON.stringify(output));
  process.exit(0);
}

main();
