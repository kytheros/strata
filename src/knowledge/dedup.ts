/**
 * Deduplication via trigram Jaccard similarity.
 * Text-based fallback for when embeddings are unavailable.
 *
 * Ported from Kytheros learning-evaluator.ts dedup logic.
 */

export interface DedupResult {
  isDuplicate: boolean;
  shouldMerge: boolean;
  mergeTargetId?: string;
  similarity: number;
}

/**
 * Character-level trigrams from lowercased text.
 */
export function getTrigrams(text: string): Set<string> {
  const lower = text.toLowerCase();
  const trigrams = new Set<string>();
  for (let i = 0; i <= lower.length - 3; i++) {
    trigrams.add(lower.slice(i, i + 3));
  }
  return trigrams;
}

/**
 * Trigram Jaccard similarity between two strings.
 * Returns 0-1 where 1 = identical.
 */
export function trigramJaccard(a: string, b: string): number {
  const trigramsA = getTrigrams(a);
  const trigramsB = getTrigrams(b);

  if (trigramsA.size === 0 && trigramsB.size === 0) return 1;
  if (trigramsA.size === 0 || trigramsB.size === 0) return 0;

  let intersection = 0;
  for (const t of trigramsA) {
    if (trigramsB.has(t)) intersection++;
  }

  const union = trigramsA.size + trigramsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Check if candidate content adds substantive detail beyond existing content.
 * Returns true if candidate has 3+ new words (length > 3) not in existing.
 */
export function addsNewDetail(
  candidateContent: string,
  existingContent: string
): boolean {
  const candidateWords = new Set(candidateContent.toLowerCase().split(/\s+/));
  const existingWords = new Set(existingContent.toLowerCase().split(/\s+/));

  let newWords = 0;
  for (const word of candidateWords) {
    if (!existingWords.has(word) && word.length > 3) {
      newWords++;
    }
  }

  return newWords >= 3;
}

/**
 * Check a candidate against existing entries for duplicates.
 * - similarity > 0.90: duplicate (reject or merge)
 * - similarity 0.80-0.90: related but distinct (accept)
 * - similarity < 0.80: accept
 */
export function checkDuplicate(
  candidateContent: string,
  existingEntries: Array<{ id: string; content: string }>
): DedupResult {
  let bestSimilarity = 0;
  let bestMatchId: string | undefined;
  let bestMatchContent: string | undefined;

  for (const existing of existingEntries) {
    const similarity = trigramJaccard(candidateContent, existing.content);
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestMatchId = existing.id;
      bestMatchContent = existing.content;
    }
  }

  if (bestSimilarity > 0.9 && bestMatchContent) {
    // Near-duplicate: check if candidate adds new detail
    if (addsNewDetail(candidateContent, bestMatchContent)) {
      return {
        isDuplicate: true,
        shouldMerge: true,
        mergeTargetId: bestMatchId,
        similarity: bestSimilarity,
      };
    }
    return {
      isDuplicate: true,
      shouldMerge: false,
      mergeTargetId: bestMatchId,
      similarity: bestSimilarity,
    };
  }

  // Below 0.90 threshold: not a duplicate
  return {
    isDuplicate: false,
    shouldMerge: false,
    similarity: bestSimilarity,
  };
}
