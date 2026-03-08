import { parseHistoryFile, getProjectInfos } from "../parsers/history-parser.js";
import { extractProjectName } from "../utils/path-encoder.js";
import { ResponseFormat } from "../utils/response-format.js";
import { CompactSerializer } from "../utils/compact-serializer.js";

export interface ListProjectsArgs {
  sort_by?: string;
  format?: string;
}

/**
 * Normalize project infos into serializable records.
 */
function toRecords(
  infos: ReturnType<typeof getProjectInfos>
): Record<string, unknown>[] {
  return infos.map((info) => ({
    name: extractProjectName(info.path),
    path: info.path,
    sessions: info.sessionCount,
    messages: info.messageCount,
    firstActive: info.firstActivity
      ? new Date(info.firstActivity).toLocaleDateString()
      : "unknown",
    lastActive: info.lastActivity
      ? new Date(info.lastActivity).toLocaleDateString()
      : "unknown",
  }));
}

export function handleListProjects(args: ListProjectsArgs): string {
  const entries = parseHistoryFile();
  const infos = getProjectInfos(entries);

  if (infos.length === 0) {
    return "No projects with conversation history found.";
  }

  // Sort
  const sortBy = args.sort_by || "recent";
  switch (sortBy) {
    case "sessions":
      infos.sort((a, b) => b.sessionCount - a.sessionCount);
      break;
    case "messages":
      infos.sort((a, b) => b.messageCount - a.messageCount);
      break;
    case "name":
      infos.sort((a, b) => a.path.localeCompare(b.path));
      break;
    case "recent":
    default:
      infos.sort((a, b) => b.lastActivity - a.lastActivity);
      break;
  }

  const records = toRecords(infos);
  const format = (args.format as ResponseFormat) || ResponseFormat.STANDARD;

  // TOON format for concise responses
  if (format === ResponseFormat.CONCISE) {
    const serializer = new CompactSerializer("projects");
    return `${infos.length} projects:\n\n` +
      serializer.serialize(records, { format });
  }

  // Detailed: full JSON (for programmatic consumers like strata-py SDK)
  if (format === ResponseFormat.DETAILED) {
    const serializer = new CompactSerializer("projects");
    return serializer.serialize(records, { format });
  }

  // Standard: structured text (default)
  const lines: string[] = [`${infos.length} projects with conversation history:\n`];

  for (const info of infos) {
    const name = extractProjectName(info.path);
    const lastDate = info.lastActivity
      ? new Date(info.lastActivity).toLocaleDateString()
      : "unknown";
    const firstDate = info.firstActivity
      ? new Date(info.firstActivity).toLocaleDateString()
      : "unknown";

    lines.push(
      `- **${name}** — ${info.sessionCount} sessions, ${info.messageCount} messages`
    );
    lines.push(`  Path: ${info.path}`);
    lines.push(`  Active: ${firstDate} → ${lastDate}`);
  }

  return lines.join("\n");
}
