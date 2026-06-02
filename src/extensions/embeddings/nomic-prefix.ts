/**
 * nomic-embed-text-v1.5 task-type → instruction prefix mapping.
 *
 * nomic-embed-text-v1.5 uses instruction prefixes to steer the embedding
 * space toward the intended retrieval task. The trailing space is significant
 * (it separates the instruction from the input text).
 *
 * Spec §11 — prefix mapping table:
 *   RETRIEVAL_DOCUMENT   → "search_document: "
 *   RETRIEVAL_QUERY      → "search_query: "
 *   CODE_RETRIEVAL_QUERY → "search_query: "
 *   default / undefined  → "search_document: "
 */

/** Map a Gemini-style taskType string to the nomic instruction prefix. */
export function nomicPrefixFor(taskType?: string): string {
  switch (taskType) {
    case "RETRIEVAL_QUERY":
    case "CODE_RETRIEVAL_QUERY":
      return "search_query: ";
    case "RETRIEVAL_DOCUMENT":
    default:
      return "search_document: ";
  }
}
