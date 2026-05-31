/**
 * Structured sufficiency evaluator (gap-judge) — the EviMem/IRIS pattern.
 * After a retrieval round, decides whether the accumulated evidence answers
 * the question; if not, emits structured gap items to steer the next query.
 * Provider-agnostic: caller supplies a cheap `complete(prompt)` function.
 *
 * Defensive: any parse failure or model error returns sufficient=true so the
 * gap-judge can never deadlock or crash the agent loop.
 */
export interface GapItem { missing: string; suggestedQuery?: string; }
export interface GapVerdict { sufficient: boolean; gaps: GapItem[]; }

const PROMPT = (question: string, evidence: string) =>
  `You are judging whether the gathered evidence is SUFFICIENT to answer a question.\n\n` +
  `Question: ${question}\n\nGathered evidence:\n${evidence}\n\n` +
  `Respond ONLY with JSON: {"sufficient": boolean, "gaps": [{"missing": "<what's still needed>", "suggestedQuery": "<a search query to find it>"}]}.\n` +
  `If the evidence fully answers the question, return {"sufficient": true, "gaps": []}. ` +
  `Otherwise list 1-3 specific gaps. Be strict: partial or ambiguous evidence is NOT sufficient.`;

export async function judgeGap(
  question: string,
  evidence: string,
  complete: (prompt: string) => Promise<string>
): Promise<GapVerdict> {
  let raw: string;
  try {
    raw = await complete(PROMPT(question, evidence));
  } catch {
    return { sufficient: true, gaps: [] }; // model error → don't block
  }
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return { sufficient: true, gaps: [] };
    const parsed = JSON.parse(m[0]) as Partial<GapVerdict>;
    if (typeof parsed.sufficient !== "boolean") return { sufficient: true, gaps: [] };
    const gaps = Array.isArray(parsed.gaps)
      ? parsed.gaps.filter((g): g is GapItem => !!g && typeof (g as GapItem).missing === "string")
      : [];
    return { sufficient: parsed.sufficient, gaps };
  } catch {
    return { sufficient: true, gaps: [] };
  }
}

/** Render gaps into a message the agent loop injects to steer the next round. */
export function formatGapInjection(v: GapVerdict): string {
  if (v.sufficient || v.gaps.length === 0) return "";
  const lines = v.gaps.map((g) =>
    `- Still missing: ${g.missing}${g.suggestedQuery ? ` (try searching: "${g.suggestedQuery}")` : ""}`);
  return `Your evidence is not yet sufficient. ${v.gaps.length} gap(s) remain — search to fill them:\n${lines.join("\n")}`;
}
