/**
 * Run all three stages of the local inference quality eval and print a
 * side-by-side comparison of Gemini and Gemma 4.
 *
 * Usage:
 *   npx tsx evals/local-inference-quality/run-eval.ts --provider gemini
 *   npx tsx evals/local-inference-quality/run-eval.ts --provider gemma4
 *   npx tsx evals/local-inference-quality/run-eval.ts --provider both
 *
 * Exit code: 0 on success, 1 if any stage fails the 0.85/0.80/0.90 thresholds
 * when --provider=both is used.
 */

import { evalExtraction, type EvalResult } from "./eval-extraction.js";
import { evalSummarization } from "./eval-summarization.js";
import { evalConflictResolution } from "./eval-conflict-resolution.js";
import { getCachedGeminiProvider } from "../../src/extensions/llm-extraction/gemini-provider.js";
import { OllamaProvider } from "../../src/extensions/llm-extraction/llm-provider.js";
import type { LlmProvider } from "../../src/extensions/llm-extraction/llm-provider.js";

interface StageResults {
  extraction: EvalResult;
  summarization: EvalResult;
  conflictResolution: EvalResult;
}

async function runAllStages(provider: LlmProvider, conflictProvider: LlmProvider): Promise<StageResults> {
  console.log(`Running extraction eval against ${provider.name}...`);
  const extraction = await evalExtraction(provider);

  console.log(`Running summarization eval against ${provider.name}...`);
  const summarization = await evalSummarization(provider);

  console.log(`Running conflict resolution eval against ${conflictProvider.name}...`);
  const conflictResolution = await evalConflictResolution(conflictProvider);

  return { extraction, summarization, conflictResolution };
}

function formatPercent(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function printStageRow(stage: string, gemini: EvalResult | null, gemma: EvalResult | null): void {
  const g = gemini ? `${formatPercent(gemini.score)} (p50=${gemini.latencyP50Ms}ms, p95=${gemini.latencyP95Ms}ms)` : "-";
  const l = gemma ? `${formatPercent(gemma.score)} (p50=${gemma.latencyP50Ms}ms, p95=${gemma.latencyP95Ms}ms)` : "-";
  console.log(`  ${stage.padEnd(20)}  ${g.padEnd(32)}  ${l}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const providerIdx = args.indexOf("--provider");
  const providerArg =
    providerIdx >= 0 && args[providerIdx + 1] ? args[providerIdx + 1] : "both";

  let geminiResults: StageResults | null = null;
  let gemmaResults: StageResults | null = null;

  if (providerArg === "gemini" || providerArg === "both") {
    const gemini = await getCachedGeminiProvider();
    if (!gemini) {
      console.error("ERROR: GEMINI_API_KEY is not set; cannot run Gemini baseline.");
      process.exit(1);
    }
    geminiResults = await runAllStages(gemini, gemini);
  }

  if (providerArg === "gemma4" || providerArg === "both") {
    const extractionProvider = new OllamaProvider("gemma4:e4b");
    const conflictProvider = new OllamaProvider("gemma4:e2b");
    gemmaResults = await runAllStages(extractionProvider, conflictProvider);
  }

  console.log("");
  console.log("====================================================================");
  console.log("  Local Inference Quality Eval — Comparison Table");
  console.log("====================================================================");
  console.log(`  ${"Stage".padEnd(20)}  ${"Gemini".padEnd(32)}  Gemma 4`);
  console.log("  --------------------------------------------------------------------");
  printStageRow("extraction", geminiResults?.extraction || null, gemmaResults?.extraction || null);
  printStageRow(
    "summarization",
    geminiResults?.summarization || null,
    gemmaResults?.summarization || null
  );
  printStageRow(
    "conflict resolution",
    geminiResults?.conflictResolution || null,
    gemmaResults?.conflictResolution || null
  );
  console.log("");

  // Pass gate when both providers ran
  if (providerArg === "both" && geminiResults && gemmaResults) {
    const extractionOk =
      gemmaResults.extraction.score >= 0.85 * geminiResults.extraction.score;
    const summarizationOk =
      gemmaResults.summarization.score >= 0.80 * geminiResults.summarization.score;
    const conflictOk =
      gemmaResults.conflictResolution.score >= 0.90 * geminiResults.conflictResolution.score;

    console.log(`  Extraction gate (>= 0.85 x Gemini): ${extractionOk ? "PASS" : "FAIL"}`);
    console.log(`  Summarization gate (>= 0.80 x Gemini): ${summarizationOk ? "PASS" : "FAIL"}`);
    console.log(`  Conflict gate (>= 0.90 x Gemini): ${conflictOk ? "PASS" : "FAIL"}`);

    if (extractionOk && summarizationOk && conflictOk) {
      console.log("");
      console.log("  RESULT: Gemma 4 is shippable as default.");
      process.exit(0);
    } else {
      console.log("");
      console.log("  RESULT: Gemma 4 does not meet thresholds. Keep opt-in only.");
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
