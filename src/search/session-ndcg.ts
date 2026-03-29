/**
 * Session-level DCG (Discounted Cumulative Gain) scoring.
 *
 * Computes a session's relevance score by aggregating the positions of its
 * chunks in the global ranked list. Sessions with multiple high-ranking
 * chunks compound signal, breaking the ceiling imposed by single-best-chunk
 * deduplication.
 *
 * Pure computation module. No external dependencies.
 */

/**
 * Compute session-level DCG score from chunk positions in global ranked list.
 *
 * For each chunk belonging to a session, its contribution to the session score
 * is `1 / log2(globalRank + 2)` where globalRank is 0-indexed position in the
 * fused chunk list. Sessions with multiple high-ranking chunks compound signal.
 *
 * The +2 offset ensures: rank 0 -> 1/log2(2) = 1.0, rank 1 -> 1/log2(3) ~ 0.63, etc.
 */
export function computeSessionDcg(
  chunkGlobalRanks: number[] // 0-indexed positions in the global ranked list
): number {
  let dcg = 0;
  for (const rank of chunkGlobalRanks) {
    dcg += 1 / Math.log2(rank + 2);
  }
  return dcg;
}
