/**
 * Safely write synthesized learnings into project MEMORY.md files.
 * Uses sentinel markers to manage a section without touching user content.
 * Supports multiple tools: claude-code, gemini-cli, codex-cli, cline.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { CONFIG } from "../config.js";
import type { KnowledgeEntry } from "./knowledge-store.js";

// New sentinel markers
const BEGIN_MARKER = "<!-- BEGIN STRATA_LEARNINGS -->";
const END_MARKER = "<!-- END STRATA_LEARNINGS -->";
const SECTION_HEADER = "## Learnings (auto-managed by Strata)";

// Legacy markers for backward compatibility / migration
const LEGACY_BEGIN_MARKER = "<!-- BEGIN CLAUDE_HISTORY_LEARNINGS -->";
const LEGACY_END_MARKER = "<!-- END CLAUDE_HISTORY_LEARNINGS -->";
const LEGACY_SECTION_HEADER = "## Learnings (auto-managed by ClaudeHistory)";
const LEGACY_SECTION_HEADER_MCP = "## Learnings (auto-managed by ClaudeHistoryMCP)";

/**
 * Resolve the Cline globalStorage base path (platform-dependent).
 */
function clineGlobalStoragePath(): string {
  const platform = process.platform;
  if (platform === "win32") {
    const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    return join(appData, "Code", "User", "globalStorage", "saoudrizwan.claude-dev");
  }
  if (platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Code", "User", "globalStorage", "saoudrizwan.claude-dev");
  }
  return join(homedir(), ".config", "Code", "User", "globalStorage", "saoudrizwan.claude-dev");
}

/**
 * Get the memory write path for a given tool and project.
 * Returns null for unknown tools (memory writing is skipped).
 */
export function getMemoryWritePath(tool: string, projectPath: string): string | null {
  switch (tool) {
    case "claude-code":
      return join(CONFIG.claudeDir, "projects", projectPath, "memory", "MEMORY.md");
    case "gemini-cli":
      return join(homedir(), ".gemini", "memory", "MEMORY.md");
    case "codex-cli":
      return join(homedir(), ".codex", "memory", "MEMORY.md");
    case "cline":
      return join(clineGlobalStoragePath(), "memory", "MEMORY.md");
    default:
      return null;
  }
}

/**
 * Migrate legacy markers in existing content to new markers.
 * Returns the migrated content string.
 */
export function migrateLegacyMarkers(content: string): string {
  let migrated = content;
  if (migrated.includes(LEGACY_BEGIN_MARKER)) {
    migrated = migrated.replace(LEGACY_BEGIN_MARKER, BEGIN_MARKER);
  }
  if (migrated.includes(LEGACY_END_MARKER)) {
    migrated = migrated.replace(LEGACY_END_MARKER, END_MARKER);
  }
  if (migrated.includes(LEGACY_SECTION_HEADER_MCP)) {
    migrated = migrated.replace(LEGACY_SECTION_HEADER_MCP, SECTION_HEADER);
  } else if (migrated.includes(LEGACY_SECTION_HEADER)) {
    migrated = migrated.replace(LEGACY_SECTION_HEADER, SECTION_HEADER);
  }
  return migrated;
}

/**
 * Write learnings to a project's MEMORY.md file.
 * Only writes to the managed section between sentinel markers.
 *
 * @param projectPath - The project path identifier
 * @param learnings - Knowledge entries to write
 * @param tool - Tool identifier (default: "claude-code" for backward compatibility)
 */
export function writeLearningsToMemory(
  projectPath: string,
  learnings: KnowledgeEntry[],
  tool: string = "claude-code"
): void {
  const memoryFile = getMemoryWritePath(tool, projectPath);
  if (memoryFile === null) return;

  const memoryDir = dirname(memoryFile);

  if (learnings.length === 0) return;

  // Limit to configured max
  const maxLearnings = CONFIG.learning.maxLearningsPerProject;
  const topLearnings = learnings.slice(0, maxLearnings);

  // Format learning lines
  const learningLines = topLearnings.map(
    (l) => `- ${truncate(l.summary, CONFIG.learning.maxLearningLength)}`
  );

  // Read existing file or start fresh
  let existingContent = "";
  if (existsSync(memoryFile)) {
    existingContent = readFileSync(memoryFile, "utf-8");
  }

  // Migrate legacy markers if present
  existingContent = migrateLegacyMarkers(existingContent);

  // Calculate line budget
  const userLines = getUserLineCount(existingContent);
  const budgetRemaining = CONFIG.learning.memoryLineBudget - userLines;

  // Need at least: header (1) + begin marker (1) + end marker (1) + 1 learning = 4 lines
  if (budgetRemaining < 4) return;

  // Trim learnings to fit budget (header + markers = 3 lines overhead)
  const maxLearningLines = budgetRemaining - 3;
  const fittedLines = learningLines.slice(0, maxLearningLines);
  if (fittedLines.length === 0) return;

  // Build the managed section
  const managedSection = [
    SECTION_HEADER,
    BEGIN_MARKER,
    ...fittedLines,
    END_MARKER,
  ].join("\n");

  // Replace existing managed section or append
  const newContent = replaceManagedSection(existingContent, managedSection);

  // Ensure directory exists
  if (!existsSync(memoryDir)) {
    mkdirSync(memoryDir, { recursive: true });
  }

  writeFileSync(memoryFile, newContent);
}

/**
 * Replace the managed section between markers, or append it.
 */
function replaceManagedSection(
  content: string,
  newSection: string
): string {
  // Find existing managed section (including header line before BEGIN)
  const headerIdx = content.indexOf(SECTION_HEADER);
  const endIdx = content.indexOf(END_MARKER);

  if (headerIdx !== -1 && endIdx !== -1) {
    // Replace from header through end marker
    const before = content.slice(0, headerIdx).trimEnd();
    const after = content.slice(endIdx + END_MARKER.length).trimStart();

    const parts = [before, newSection];
    if (after.length > 0) parts.push(after);
    return parts.filter(Boolean).join("\n\n") + "\n";
  }

  // Check for markers without header (shouldn't happen, but handle gracefully)
  const beginIdx = content.indexOf(BEGIN_MARKER);
  if (beginIdx !== -1 && endIdx !== -1) {
    const before = content.slice(0, beginIdx).trimEnd();
    const after = content.slice(endIdx + END_MARKER.length).trimStart();

    const parts = [before, newSection];
    if (after.length > 0) parts.push(after);
    return parts.filter(Boolean).join("\n\n") + "\n";
  }

  // No existing section — append
  if (content.trim().length === 0) {
    return newSection + "\n";
  }
  return content.trimEnd() + "\n\n" + newSection + "\n";
}

/**
 * Count lines of user content (everything outside the managed section).
 */
function getUserLineCount(content: string): number {
  if (content.trim().length === 0) return 0;

  const headerIdx = content.indexOf(SECTION_HEADER);
  const endIdx = content.indexOf(END_MARKER);

  if (headerIdx !== -1 && endIdx !== -1) {
    const before = content.slice(0, headerIdx);
    const after = content.slice(endIdx + END_MARKER.length);
    const userContent = before + after;
    return userContent.split("\n").filter((l) => l.trim().length > 0).length;
  }

  return content.split("\n").filter((l) => l.trim().length > 0).length;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

/**
 * Filter learnings by relevance to a project's tags.
 */
export function filterLearningsForProject(
  learnings: KnowledgeEntry[],
  projectTags: string[]
): KnowledgeEntry[] {
  if (projectTags.length === 0) return learnings;

  const tagSet = new Set(projectTags.map((t) => t.toLowerCase()));
  return learnings.filter((l) => {
    // Global learnings with high occurrence always qualify
    if ((l.occurrences ?? 0) >= 5) return true;
    // Otherwise need tag overlap
    return l.tags.some((t) => tagSet.has(t.toLowerCase()));
  });
}
