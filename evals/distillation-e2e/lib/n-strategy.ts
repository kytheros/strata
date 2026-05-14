/**
 * N-averaging strategy for distillation harness scoring.
 *
 * When n=1 (default, fast): runs the scoring function once.
 * When n=3 (decision mode): runs three times and averages answerScore
 * and recallScore, spreading over GPT-4o stochasticity even at temperature=0.
 *
 * Background: LongMemEval project memory (2026-04-08) notes that single-run
 * verdicts are unreliable even at temperature=0. N=3 is the canary minimum.
 */
export async function withNAveraging<T extends { answerScore: number; recallScore: number }>(
  n: 1 | 3,
  fn: () => Promise<T>
): Promise<T> {
  if (n === 1) return fn();
  const runs: T[] = [];
  for (let i = 0; i < 3; i++) runs.push(await fn());
  const avg = {
    answerScore: runs.reduce((s, r) => s + r.answerScore, 0) / 3,
    recallScore: runs.reduce((s, r) => s + r.recallScore, 0) / 3,
  };
  return { ...runs[0], ...avg } as T;
}
