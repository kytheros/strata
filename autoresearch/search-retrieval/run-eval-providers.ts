/**
 * Provider comparison eval — runs the hybrid eval per provider and computes
 * relative recall vs Gemini baseline.
 *
 * Usage:
 *   npx tsx autoresearch/search-retrieval/run-eval-providers.ts
 *
 * Requires GEMINI_API_KEY for Gemini baseline.
 * Local provider falls back to FTS5-only and reports N/A (no hard-fail).
 */

import { execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

interface ProviderResult {
  provider: string;
  model: string;
  score: number | null;
  relativeRecall: number | null;
  note: string;
}

const PROVIDERS = [
  { name: "gemini", envKey: "STRATA_EMBEDDING_PROVIDER", envVal: undefined },
  { name: "local", envKey: "STRATA_EMBEDDING_PROVIDER", envVal: "local" },
  // openai-compatible reports N/A when STRATA_EMBEDDING_BASE_URL is not set (no hard-fail)
  { name: "openai-compatible", envKey: "STRATA_EMBEDDING_PROVIDER", envVal: "openai-compatible" },
];

function scoreFromOutput(stdout: string): number | null {
  // The eval prints a line like: "Score: 25/30"
  const m = stdout.match(/Score:\s+(\d+)\/(\d+)/);
  if (!m) return null;
  return parseInt(m[1], 10) / parseInt(m[2], 10);
}

async function runProviderEval(
  provider: string,
  envOverride?: Record<string, string>
): Promise<{ score: number | null; note: string }> {
  const env = { ...process.env, ...envOverride };

  // Check if local weights are available
  if (provider === "local") {
    const weightsPath = join(homedir(), ".strata", "models", "nomic-embed-text-v1.5", "model_int8.onnx");
    if (!existsSync(weightsPath)) {
      return {
        score: null,
        note: "Local weights not found — falling back to FTS5. Run `strata embeddings pull` first.",
      };
    }
  }

  try {
    const result = execSync(
      "npx tsx autoresearch/search-retrieval/run-eval-hybrid.ts",
      { env, encoding: "utf-8", timeout: 300_000 }
    );
    const score = scoreFromOutput(result);
    return { score, note: score === null ? "Could not parse score from output" : "" };
  } catch (e: any) {
    return { score: null, note: `Eval failed: ${e.message?.slice(0, 100)}` };
  }
}

async function main() {
  console.log("=== Provider Comparison Eval ===\n");

  const results: ProviderResult[] = [];

  // Run Gemini baseline first
  console.log("Running Gemini baseline...");
  const geminiResult = await runProviderEval("gemini");
  const geminiScore = geminiResult.score;
  results.push({
    provider: "gemini",
    model: "gemini-embedding-001",
    score: geminiScore,
    relativeRecall: 1.0,
    note: geminiResult.note,
  });

  // Run other providers
  for (const p of PROVIDERS.slice(1)) {
    console.log(`Running ${p.name} provider...`);
    const override = p.envVal ? { [p.envKey]: p.envVal } : undefined;
    const r = await runProviderEval(p.name, override);

    const relativeRecall =
      r.score !== null && geminiScore !== null && geminiScore > 0
        ? r.score / geminiScore
        : null;

    const modelLabel =
      p.name === "local" ? "nomic-embed-text-v1.5"
      : p.name === "openai-compatible" ? process.env.STRATA_EMBEDDING_MODEL || "(configured model)"
      : "(unknown)";
    results.push({
      provider: p.name,
      model: modelLabel,
      score: r.score,
      relativeRecall,
      note: r.note,
    });
  }

  // Print summary table
  console.log("\n=== Results ===\n");
  console.log("Provider          | Model                    | Score | Relative Recall | Note");
  console.log("──────────────────┼──────────────────────────┼───────┼─────────────────┼─────");
  for (const r of results) {
    const scoreStr = r.score !== null ? (r.score * 100).toFixed(1) + "%" : "N/A (FTS5 fallback)";
    const relStr = r.relativeRecall !== null ? (r.relativeRecall * 100).toFixed(1) + "%" : "N/A";
    const note = r.note ? r.note.slice(0, 40) : "";
    console.log(
      `${r.provider.padEnd(17)} | ${r.model.padEnd(24)} | ${scoreStr.padStart(5)} | ${relStr.padStart(15)} | ${note}`
    );
  }

  // Gemini baseline re-anchor reminder
  console.log("\nNote: Re-anchor the Gemini baseline after any changes to run-eval-hybrid.ts.");
  console.log("Frozen baseline (from memory): 30/30 (hybrid) / 29/30 (FTS5-only).");
}

main().catch((e) => {
  console.error("Provider eval failed:", e);
  process.exit(1);
});
