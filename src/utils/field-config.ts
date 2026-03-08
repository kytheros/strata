/**
 * Field configurations per entity type per verbosity level.
 * Controls which fields appear in TOON (concise), standard, and detailed responses.
 */

export type FieldSet = string[];

export interface FieldConfig {
  concise: FieldSet;
  standard: FieldSet;
  detailed: FieldSet;
}

export const FIELD_CONFIGS: Record<string, FieldConfig> = {
  /**
   * Search results from search_history / find_solutions
   */
  results: {
    concise: ["project", "date", "score", "snippet"],
    standard: ["project", "date", "score", "confidence", "tools", "snippet"],
    detailed: ["project", "sessionId", "date", "score", "confidence", "role", "tools", "text"],
  },

  /**
   * Project listings from list_projects
   */
  projects: {
    concise: ["name", "sessions", "messages", "lastActive"],
    standard: ["name", "path", "sessions", "messages", "firstActive", "lastActive"],
    detailed: ["name", "path", "sessions", "messages", "firstActive", "lastActive"],
  },

  /**
   * Session summaries from get_session_summary
   */
  sessions: {
    concise: ["sessionId", "project", "date", "topic"],
    standard: ["sessionId", "project", "date", "messages", "tools", "topic"],
    detailed: [
      "sessionId", "project", "branch", "startTime", "endTime",
      "userMessages", "assistantMessages", "tools", "topic", "keyTopics",
    ],
  },
};

/**
 * Get fields for a specific entity type and format level.
 */
export function getFieldsForFormat(
  entityType: string,
  format: "concise" | "standard" | "detailed"
): FieldSet {
  const config = FIELD_CONFIGS[entityType];
  if (!config) return [];
  return config[format];
}
