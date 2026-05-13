export type ResolvedProvider =
  | { kind: "gemini" }
  | { kind: "ollama"; model: string }
  | { kind: "hybrid" };

/**
 * Force STRATA_HYBRID_STRICT=1 for this process. The harness cannot tolerate
 * silent hybrid fallback to Gemini — that would contaminate every "local"
 * measurement. This is the same posture as STRATA_TOKEN_SECRET in REST mode.
 */
export function applyIntegrityGate(): void {
  process.env.STRATA_HYBRID_STRICT = "1";
}

export function resolveProvider(): ResolvedProvider {
  const raw = process.env.STRATA_EXTRACTION_PROVIDER;
  if (!raw) {
    throw new Error(
      "STRATA_EXTRACTION_PROVIDER is required. Examples: " +
      "gemini | ollama:gemma4:e4b | hybrid"
    );
  }
  if (raw === "gemini") return { kind: "gemini" };
  if (raw === "hybrid") return { kind: "hybrid" };
  if (raw.startsWith("ollama:")) {
    const model = raw.slice("ollama:".length);
    if (!model) throw new Error("STRATA_EXTRACTION_PROVIDER=ollama: requires a model name");
    return { kind: "ollama", model };
  }
  throw new Error(`unknown provider kind: ${raw}`);
}
