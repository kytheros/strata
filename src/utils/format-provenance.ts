/**
 * Format a ProvenanceHandle into the bracket-citation string used in agent-facing
 * search tool responses: `[mem:<short> sess:<short> t:<date>]`.
 *
 * Design goals:
 * - Short enough to appear inline without dominating the result snippet.
 * - Unique enough to distinguish most entries in a session.
 * - Human-readable date (UTC ISO YYYY-MM-DD).
 */

import type { ProvenanceHandle } from "../types/provenance.js";

const SHORT_ID_CHARS = 6;

/**
 * Produce a short, human-readable id from a full entry id.
 *
 * Strategy: strip the prefix up to (and including) the first underscore,
 * then take the first SHORT_ID_CHARS hex chars from the remainder after
 * removing dashes. Preserves the prefix so `k_8a3fb41c-...` → `k_8a3fb4`.
 */
function shortId(fullId: string): string {
  const underscore = fullId.indexOf("_");
  const prefix = underscore === -1 ? "" : fullId.slice(0, underscore + 1);
  const rest = underscore === -1 ? fullId : fullId.slice(underscore + 1);
  return prefix + rest.replace(/-/g, "").slice(0, SHORT_ID_CHARS);
}

/** UTC ISO date string (YYYY-MM-DD) from a ms-epoch timestamp. */
function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Format a ProvenanceHandle into a bracket-citation string.
 *
 * Examples:
 *   `[mem:k_8a3fb4 sess:s_7d21e9 t:2024-05-08]`
 *   `[mem:k_abc123 t:2024-05-08]`  (no session)
 */
export function formatProvenanceHandle(p: ProvenanceHandle): string {
  const parts = [`mem:${shortId(p.id)}`];
  if (p.sessionId) parts.push(`sess:${shortId(p.sessionId)}`);
  parts.push(`t:${isoDate(p.createdAt)}`);
  return `[${parts.join(" ")}]`;
}
