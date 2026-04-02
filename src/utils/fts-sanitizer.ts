/**
 * Shared FTS5 query sanitization utility.
 *
 * Strips all FTS5 special characters and optionally removes stop words.
 * Used by storage modules that perform FTS5 MATCH queries to prevent
 * syntax errors from user-supplied query strings.
 *
 * Characters that cause FTS5 syntax errors include: ? ' " * : ( ) ^ ~ { } < > - + @ [ ] !
 * The Unicode-aware regex strips everything except letters, digits, and whitespace.
 */

/**
 * Common English stop words that carry no semantic weight.
 * Removing these from FTS5 queries prevents function words from
 * dominating OR-mode matches or causing AND-mode misses when
 * they don't appear in the indexed content.
 */
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "am", "are", "was", "were", "be", "been",
  "being", "have", "has", "had", "do", "does", "did", "will", "would",
  "shall", "should", "may", "might", "can", "could", "must",
  "i", "me", "my", "mine", "myself", "we", "us", "our", "ours",
  "you", "your", "yours", "he", "him", "his", "she", "her", "hers",
  "it", "its", "they", "them", "their", "theirs",
  "this", "that", "these", "those",
  "to", "of", "in", "for", "on", "with", "at", "by", "from",
  "as", "into", "through", "during", "before", "after", "above",
  "below", "between", "out", "off", "up", "down", "over", "under",
  "and", "but", "or", "nor", "not", "no", "so", "if", "then",
  "than", "too", "very", "just", "about", "also",
  "how", "what", "when", "where", "which", "who", "whom", "why",
  "all", "each", "every", "both", "few", "more", "most", "other",
  "some", "such", "any", "only", "own", "same",
  "here", "there", "again", "once", "further",
]);

/**
 * Sanitize a query string for FTS5 MATCH syntax.
 *
 * 1. Strips all non-letter/non-digit/non-space characters (Unicode-aware).
 * 2. Optionally removes common stop words.
 * 3. Filters out single-character tokens.
 * 4. Joins remaining tokens with space (implicit AND in FTS5).
 *
 * If all tokens are stop words, falls back to the cleaned query
 * to avoid returning empty string for queries like "what is it".
 */
export function sanitizeFtsQuery(query: string, removeStopWords = true): string {
  // Strip FTS5 operators and special chars, keep letters + digits + spaces (Unicode-aware)
  const cleaned = query
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return "";

  const allTokens = cleaned.split(" ").filter((t) => t.length > 1);

  if (!removeStopWords) {
    return allTokens.join(" ");
  }

  const tokens = allTokens.filter((t) => !STOP_WORDS.has(t.toLowerCase()));

  // If all tokens were stop words, fall back to the original cleaned tokens
  if (tokens.length === 0) {
    return allTokens.join(" ");
  }

  return tokens.join(" ");
}
