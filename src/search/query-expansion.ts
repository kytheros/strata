/**
 * Pseudo-relevance feedback (PRF) for hybrid search.
 *
 * Extracts distinctive terms from top vector search results and builds
 * an expanded FTS5 query. This creates FTS5 signal for documents that
 * share vocabulary with semantically similar results, enabling the
 * dual-list bonus in RRF to promote entries with both keyword and
 * semantic relevance.
 */

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "as", "is", "was", "are", "were", "be",
  "been", "being", "have", "has", "had", "do", "does", "did", "will",
  "would", "could", "should", "may", "might", "shall", "can", "need",
  "dare", "ought", "used", "it", "its", "he", "she", "they", "them",
  "we", "you", "your", "our", "my", "his", "her", "their", "this",
  "that", "these", "those", "not", "no", "nor", "so", "too", "very",
  "just", "about", "above", "after", "again", "all", "also", "any",
  "because", "before", "between", "both", "each", "few", "get", "got",
  "here", "how", "into", "more", "most", "new", "now", "only", "other",
  "out", "over", "own", "same", "some", "such", "than", "then", "there",
  "through", "under", "until", "what", "when", "where", "which", "while",
  "who", "why", "down", "off", "once", "per", "up", "set",
]);

/**
 * Extract expansion terms from the text of top vector search results.
 *
 * Terms appearing in multiple top documents are likely semantically
 * related to the query. We exclude original query terms (already
 * in the FTS5 query) and stopwords.
 *
 * @param topTexts  Text content of top-N vector search results
 * @param queryText Original query string
 * @param maxTerms  Maximum expansion terms to return
 * @param minDocFreq Minimum number of top docs a term must appear in
 */
export function extractExpansionTerms(
  topTexts: string[],
  queryText: string,
  maxTerms: number = 10,
  minDocFreq: number = 2
): string[] {
  if (topTexts.length === 0) return [];

  // Tokenize query to exclude original terms
  const queryTerms = new Set(
    queryText.toLowerCase().split(/\W+/).filter(w => w.length > 2)
  );

  // Count how many top documents contain each term
  const termDocFreq = new Map<string, number>();

  for (const text of topTexts) {
    // Unique terms per document (document frequency, not term frequency)
    const seen = new Set<string>();
    for (const word of text.toLowerCase().split(/\W+/)) {
      if (
        word.length > 2 &&
        !STOPWORDS.has(word) &&
        !queryTerms.has(word) &&
        /^[a-z]+$/.test(word) && // alphanumeric only, safe for FTS5
        !seen.has(word)
      ) {
        seen.add(word);
        termDocFreq.set(word, (termDocFreq.get(word) || 0) + 1);
      }
    }
  }

  // Keep terms appearing in enough top documents
  return [...termDocFreq.entries()]
    .filter(([, freq]) => freq >= minDocFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTerms)
    .map(([term]) => term);
}

/**
 * Build an expanded FTS5 query preserving original AND precision.
 *
 * Format: (original AND group) OR expansion_term1 OR expansion_term2 ...
 *
 * BM25 ranks AND-matching docs highest (all original terms present),
 * with expansion-matching docs at lower positions. This preserves
 * the quality of exact keyword matches while broadening recall.
 *
 * @param originalText Original query text
 * @param expansionTerms Terms extracted via PRF
 */
export function buildExpandedFTSQuery(
  originalText: string,
  expansionTerms: string[]
): string {
  const originalTerms = originalText
    .trim()
    .split(/\s+/)
    .filter(t => t.length > 0 && /^[a-z0-9]+$/i.test(t));

  if (originalTerms.length === 0) return originalText;
  if (expansionTerms.length === 0) return originalText;

  // Group original terms with AND (implicit in FTS5 parentheses),
  // then OR with each expansion term
  const andGroup = `(${originalTerms.join(" ")})`;
  return [andGroup, ...expansionTerms].join(" OR ");
}
