/** Token accounting + pricing for the teacher bake-off. Prices are $/1M tokens
 *  (from Strata 2026-04-27 model-intelligence scan). Update as prices change. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export const MODEL_PRICING: Record<string, { inPerM: number; outPerM: number }> = {
  "gemini-2.5-flash": { inPerM: 0.30, outPerM: 2.50 },
  "gemini-3-flash": { inPerM: 0.50, outPerM: 3.00 },
  "gpt-5.4-mini": { inPerM: 0.75, outPerM: 4.50 },
  "claude-haiku-4-5": { inPerM: 1.00, outPerM: 5.00 },
  "claude-sonnet-4-6": { inPerM: 3.00, outPerM: 15.00 },
};

/** $ for a single question's tokens on a model. Unknown model → 0 (logged, not priced). */
export function computeCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = MODEL_PRICING[model.replace(/^vertex:/, "")];
  if (!p) return 0;
  return (inputTokens / 1_000_000) * p.inPerM + (outputTokens / 1_000_000) * p.outPerM;
}

export function summariseTokens(usages: TokenUsage[]): {
  totalInput: number; totalOutput: number; meanInputPerQ: number; meanOutputPerQ: number;
} {
  const totalInput = usages.reduce((s, u) => s + u.inputTokens, 0);
  const totalOutput = usages.reduce((s, u) => s + u.outputTokens, 0);
  const n = usages.length || 1;
  return { totalInput, totalOutput, meanInputPerQ: totalInput / n, meanOutputPerQ: totalOutput / n };
}
