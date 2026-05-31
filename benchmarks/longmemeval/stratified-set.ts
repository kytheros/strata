import { questionTypeToAbility, type MemoryAbility, type QuestionType } from "./types.js";

interface MinimalQ { question_id: string; question_type: QuestionType | string; }

/** Pick `perAbility` questions per memory ability, deterministic (sorted by id). */
export function pickStratified(dataset: MinimalQ[], perAbility: number): string[] {
  const byAbility = new Map<MemoryAbility, string[]>();
  for (const q of dataset) {
    let ability: MemoryAbility;
    try { ability = questionTypeToAbility(q.question_type as QuestionType); }
    catch { continue; }
    const arr = byAbility.get(ability) ?? [];
    arr.push(q.question_id);
    byAbility.set(ability, arr);
  }
  const out: string[] = [];
  for (const ids of byAbility.values()) {
    out.push(...ids.sort().slice(0, perAbility));
  }
  return out;
}
