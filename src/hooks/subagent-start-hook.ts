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
    "- search_history: Full-text search across all past sessions (project:, before:, after: filters)",
    "- find_solutions: Search for solutions to errors/problems from past sessions",
    "- get_project_context: Get comprehensive context for the current project",
    "- store_memory: Explicitly store decisions, solutions, and preferences for future recall",
    "- find_patterns: Discover recurring patterns and issues in conversation history",
    "- list_projects: See all projects with conversation history",
    "",
    "IMPORTANT — Use these tools proactively:",
    "1. Before debugging: call find_solutions with the error message",
    "2. After making a decision: call store_memory with type=decision",
    "3. After fixing an error: call store_memory with type=error_fix",
    "4. At task start: call get_project_context for relevant history",
    "5. After completing work: call store_memory with type=solution for key solutions",
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
