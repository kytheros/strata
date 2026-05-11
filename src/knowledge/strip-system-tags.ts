/**
 * stripSystemTags — pre-extraction sanitizer for entity extraction.
 *
 * Removes XML/HTML-like tag patterns from text before entity extraction runs.
 * Claude Code system-reminder formatting uses tags like:
 *   <task-notification>, <tool-use-id>, <command-message>, <command-args>,
 *   <command-name>, <system-reminder>, etc.
 *
 * Without stripping, the NPM_PATTERN in entity-extractor.ts matches the
 * hyphenated tag names as npm package candidates, creating garbage entities
 * like "tool-use-id", "task-notification", "command-message", "ommand-args"
 * (the last variant comes from matching substrings after the leading < is
 * stripped but before a word boundary).
 *
 * Strategy: strip at the source. Tags should never reach the extractor.
 *
 * Patterns removed (in order):
 *   1. Paired tags with content:  <foo-bar>...</foo-bar>
 *   2. Self-closing tags:         <foo-bar/>
 *   3. Bare opening tags:         <foo-bar>
 *   4. Bare closing tags:         </foo-bar>
 *
 * Tag name rule: starts with a letter, followed by letters, digits,
 * underscores, or hyphens. This matches system-reminder tags without
 * catching unrelated text (e.g. comparison operators < and >).
 *
 * Performance: four sequential regex passes. Designed for <10ms on
 * typical knowledge-entry text (≤4000 chars).
 *
 * Ticket: entity extractor pollution fix (strata-mcp@2.2.2)
 */

/** Tag name pattern: letter followed by letters/digits/underscores/hyphens. */
const TAG_NAME = "[a-zA-Z][a-zA-Z0-9_-]*";

/**
 * Paired tags with content (greedy-safe because we anchor to matching close tag).
 * Handles multi-line content via [\s\S]*?.
 */
const PAIRED_TAGS_RE = new RegExp(
  `<(${TAG_NAME})(?:\\s[^>]*)?>([\\s\\S]*?)<\\/\\1>`,
  "g"
);

/** Self-closing tags: <foo-bar/> */
const SELF_CLOSING_RE = new RegExp(`<${TAG_NAME}(?:\\s[^>]*)?\\/>`,"g");

/** Bare opening tags: <foo-bar> or <foo-bar attr="x"> */
const BARE_OPEN_RE = new RegExp(`<${TAG_NAME}(?:\\s[^>]*)?>`, "g");

/** Bare closing tags: </foo-bar> */
const BARE_CLOSE_RE = new RegExp(`<\\/${TAG_NAME}>`, "g");

/**
 * Strip XML/HTML-like tag patterns from text before entity extraction.
 *
 * Returns the cleaned text with tags replaced by spaces, then whitespace
 * normalized. Preserves surrounding prose.
 *
 * @param text - raw text that may contain system-reminder tag formatting
 * @returns text with all XML-like tags removed
 */
export function stripSystemTags(text: string): string {
  if (!text) return text;

  // Reset lastIndex for global regexes before each call
  PAIRED_TAGS_RE.lastIndex = 0;
  SELF_CLOSING_RE.lastIndex = 0;
  BARE_OPEN_RE.lastIndex = 0;
  BARE_CLOSE_RE.lastIndex = 0;

  return text
    .replace(PAIRED_TAGS_RE, " ")
    .replace(SELF_CLOSING_RE, " ")
    .replace(BARE_OPEN_RE, " ")
    .replace(BARE_CLOSE_RE, " ")
    .replace(/[ \t]+/g, " ")   // collapse horizontal whitespace
    .trim();
}
