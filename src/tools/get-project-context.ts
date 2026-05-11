import { parseHistoryFile, groupBySession, getProjectInfos } from "../parsers/history-parser.js";
import { extractProjectName } from "../utils/path-encoder.js";
import type { SqliteSearchEngine } from "../search/sqlite-search-engine.js";
import type { IKnowledgeStore } from "../storage/interfaces/knowledge-store.js";
import { STOP_WORDS } from "../indexing/tokenizer.js";
import { formatProvenanceHandle } from "../utils/format-provenance.js";
import type { KnowledgeEntry } from "../knowledge/knowledge-store.js";

export const getProjectContextTool = {
  name: "get_project_context",
  description:
    "Get comprehensive context for a project: recent sessions, key topics, common tools, and patterns. Useful for session-start context injection.",
  inputSchema: {
    type: "object" as const,
    properties: {
      project: {
        type: "string",
        description:
          "Project name or path. Defaults to current working directory.",
      },
      depth: {
        type: "string",
        enum: ["brief", "normal", "detailed"],
        description:
          "Detail level: brief (last session only), normal (last 3), detailed (last 5 + patterns). Default: normal.",
      },
    },
  },
};

/**
 * Build a trailing `Sources:` line from a list of knowledge entries.
 * Deduplicates by entry id and formats each as a bracket-handle citation.
 * Returns empty string when no entries are provided.
 */
export function buildProvenanceSources(entries: KnowledgeEntry[]): string {
  const seen = new Set<string>();
  const handles: string[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    handles.push(
      formatProvenanceHandle({
        id: entry.id,
        sessionId: entry.sessionId || null,
        createdAt: entry.timestamp,
        updatedAt: entry.timestamp,
        editCount: 0,
      })
    );
  }
  if (handles.length === 0) return "";
  return `\nSources: ${handles.join(" ")}`;
}

export async function handleGetProjectContext(
  engine: SqliteSearchEngine,
  args: { project?: string; depth?: string; user?: string },
  profileSummary?: string,
  knowledgeStore?: IKnowledgeStore,
): Promise<string> {
  const project = args.project || "";
  const depth = args.depth || "normal";

  if (!project) {
    return "Please provide a project name or path.";
  }

  const entries = parseHistoryFile();
  const query = project.toLowerCase();

  const matching = entries.filter(
    (e) =>
      e.project.toLowerCase().includes(query) ||
      extractProjectName(e.project).toLowerCase().includes(query)
  );

  if (matching.length === 0) {
    // Even without conversation history, if there are knowledge entries,
    // surface them via the Sources block.
    if (knowledgeStore) {
      try {
        const knowledgeEntries = await knowledgeStore.getProjectEntries(project, args.user);
        if (knowledgeEntries.length > 0) {
          const sources = buildProvenanceSources(knowledgeEntries);
          return `No history found for project "${project}".${sources}`;
        }
      } catch {
        // best-effort
      }
    }
    return `No history found for project "${project}".`;
  }

  const projectName = extractProjectName(matching[0].project);
  const bySession = groupBySession(matching);

  // Sort sessions by most recent activity
  const sessionList = [...bySession.entries()]
    .map(([sessionId, entries]) => ({
      sessionId,
      entries,
      lastActivity: Math.max(...entries.map((e) => e.timestamp)),
      firstActivity: Math.min(...entries.map((e) => e.timestamp)),
    }))
    .sort((a, b) => b.lastActivity - a.lastActivity);

  const sessionCount = depth === "brief" ? 1 : depth === "detailed" ? 5 : 3;

  const lines: string[] = [
    `## Project Context: ${projectName}`,
    "",
    `**Total sessions**: ${sessionList.length}`,
    `**Total messages**: ${matching.length}`,
    "",
    `### Recent Sessions`,
  ];

  for (const session of sessionList.slice(0, sessionCount)) {
    const date = new Date(session.lastActivity).toLocaleDateString();
    const daysAgo = Math.floor(
      (Date.now() - session.lastActivity) / 86400000
    );
    const daysStr =
      daysAgo === 0
        ? "today"
        : daysAgo === 1
          ? "yesterday"
          : `${daysAgo} days ago`;

    // First user message as topic
    const firstMsg = session.entries[0]?.display || "Unknown topic";
    const topic =
      firstMsg.length > 120 ? firstMsg.slice(0, 120) + "..." : firstMsg;

    lines.push(`- **${date}** (${daysStr}): ${topic}`);
    lines.push(`  Session: ${session.sessionId} — ${session.entries.length} messages`);
  }

  // If detailed, also search for patterns
  if (depth === "detailed") {
    lines.push("");
    lines.push("### Common Topics");

    // Simple frequency analysis of user messages
    const allDisplays = matching.map((e) => e.display.toLowerCase());
    const wordFreq = new Map<string, number>();
    for (const display of allDisplays) {
      const words = display
        .replace(/[^a-z0-9\s]/g, " ")  // Strip punctuation (handles contractions)
        .split(/\s+/)
        .filter((w) => w.length > 3 && !STOP_WORDS.has(w));
      for (const word of new Set(words)) {
        wordFreq.set(word, (wordFreq.get(word) || 0) + 1);
      }
    }

    const topWords = [...wordFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    for (const [word, count] of topWords) {
      lines.push(`- "${word}" (${count} mentions)`);
    }
  }

  // Append compact user profile if available
  if (profileSummary) {
    lines.push("");
    lines.push(profileSummary);
  }

  // Append knowledge-store Sources: block when store is provided
  if (knowledgeStore) {
    try {
      const knowledgeEntries = await knowledgeStore.getProjectEntries(project, args.user);
      const sources = buildProvenanceSources(knowledgeEntries);
      if (sources) {
        lines.push(sources);
      }
    } catch {
      // best-effort — don't block context retrieval
    }
  }

  return lines.join("\n");
}
