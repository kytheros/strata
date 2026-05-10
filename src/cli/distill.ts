/**
 * CLI commands for the distillation subsystem.
 *
 * Subcommands:
 *   strata distill status        — Show training data stats and readiness
 *   strata distill export-data   — Export training data to JSONL for fine-tuning
 *   strata distill activate      — Enable distillation mode
 *   strata distill deactivate    — Disable distillation mode
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createWriteStream } from "fs";

/** Distillation readiness threshold per task type */
const DISTILL_THRESHOLD = 1_000;

/**
 * Get the path to ~/.strata/config.json
 */
function getConfigPath(): string {
  return join(
    process.env.STRATA_DATA_DIR || join(homedir(), ".strata"),
    "config.json"
  );
}

/**
 * Read the full config object from ~/.strata/config.json.
 * Returns an empty object if the file doesn't exist or is invalid.
 */
function readConfig(): Record<string, unknown> {
  const p = getConfigPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Write the config object to ~/.strata/config.json, merging with existing data.
 */
function writeConfig(patch: Record<string, unknown>): void {
  const p = getConfigPath();
  const dir = join(p, "..");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const existing = readConfig();
  const merged = { ...existing, ...patch };
  writeFileSync(p, JSON.stringify(merged, null, 2) + "\n", "utf-8");
}

/**
 * Format a number with locale-aware thousands separators.
 */
function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Format a Unix timestamp (ms) to a human-readable date string.
 */
function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

/**
 * Check if Ollama is running by pinging its API.
 */
async function detectOllama(): Promise<{
  detected: boolean;
  models: string[];
}> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch("http://localhost:11434/api/tags", {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return { detected: false, models: [] };
    const data = (await res.json()) as {
      models?: Array<{ name: string }>;
    };
    const models = (data.models ?? []).map((m) => m.name);
    return { detected: true, models };
  } catch {
    return { detected: false, models: [] };
  }
}

/**
 * Determine the current extraction mode based on environment and config.
 */
function getCurrentMode(): {
  mode: string;
  description: string;
} {
  const config = readConfig();
  const distillation = config.distillation as
    | { enabled?: boolean }
    | undefined;
  const hasGemini = Boolean(process.env.GEMINI_API_KEY);
  const distillEnabled = distillation?.enabled === true;

  if (distillEnabled && hasGemini) {
    return {
      mode: "hybrid",
      description: "hybrid (local model + gemini fallback)",
    };
  }
  if (distillEnabled) {
    return {
      mode: "local",
      description: "local (distilled model via Ollama)",
    };
  }
  if (hasGemini) {
    return {
      mode: "gemini",
      description: "gemini-2.5-flash (LLM extraction active)",
    };
  }
  return {
    mode: "heuristic",
    description: "heuristic (no GEMINI_API_KEY set)",
  };
}

/**
 * Run the `strata distill status` command.
 */
export async function runDistillStatus(
  flags: Record<string, string | boolean>
): Promise<void> {
  const { openDatabase, getDbPath } = await import("../storage/database.js");
  const { getTrainingDataStats } = await import(
    "../extensions/llm-extraction/training-capture.js"
  );
  const fmtMod = await import("./formatter.js");
  fmtMod.initColor(flags);

  const dbPath = getDbPath();
  const db = openDatabase();

  try {
    const stats = getTrainingDataStats(db);

    // Header
    console.log(fmtMod.bronze("Strata Distillation Status"));
    console.log(fmtMod.bronze("==========================="));
    console.log();

    // Training data counts
    console.log("Training data collected:");
    const extractionUsable =
      stats.extraction.highQuality + stats.extraction.mediumQuality;
    const summarizationUsable =
      stats.summarization.highQuality + stats.summarization.mediumQuality;

    const extractionReady = extractionUsable >= DISTILL_THRESHOLD;
    const summarizationReady = summarizationUsable >= DISTILL_THRESHOLD;

    const extractionIndicator = extractionReady
      ? fmtMod.success("Ready")
      : `${fmt(DISTILL_THRESHOLD - extractionUsable)} pairs to go`;
    const summarizationIndicator = summarizationReady
      ? fmtMod.success("Ready")
      : `${fmt(DISTILL_THRESHOLD - summarizationUsable)} pairs to go`;

    console.log(
      `  Extraction:      ${fmtMod.text(fmt(extractionUsable))} pairs (threshold: ${fmt(DISTILL_THRESHOLD)}) ${extractionReady ? fmtMod.success("\u2713") : fmtMod.active("~")} ${extractionIndicator}`
    );
    console.log(
      `  Summarization:   ${fmtMod.text(fmt(summarizationUsable))} pairs (threshold: ${fmt(DISTILL_THRESHOLD)}) ${summarizationReady ? fmtMod.success("\u2713") : fmtMod.active("~")} ${summarizationIndicator}`
    );

    const dialogueTotal = stats.dialogue.total;
    console.log(
      `  Dialogue:        ${fmtMod.text(fmt(dialogueTotal))} pairs (NPC training data)`
    );
    console.log();

    // Quality breakdown
    console.log("Quality breakdown:");
    console.log(
      `  High quality (\u22650.9):    ${fmtMod.text(fmt(stats.extraction.highQuality))} extraction, ${fmtMod.text(fmt(stats.summarization.highQuality))} summarization`
    );
    console.log(
      `  Medium quality (\u22650.7):  ${fmtMod.text(fmt(stats.extraction.mediumQuality))} extraction, ${fmtMod.text(fmt(stats.summarization.mediumQuality))} summarization`
    );
    console.log(
      `  Heuristic-diverged:     ${fmtMod.text(fmt(stats.extraction.heuristicDiverged))} extraction, ${fmtMod.text(fmt(stats.summarization.heuristicDiverged))} summarization`
    );
    console.log();

    // Last captured
    if (stats.lastCapturedAt) {
      console.log(
        `Last pair captured: ${fmtMod.text(formatTimestamp(stats.lastCapturedAt))}`
      );
    } else {
      console.log(
        `Last pair captured: ${fmtMod.dim("none")}`
      );
    }
    console.log();

    // Local model status
    console.log("Local model status:");
    const ollama = await detectOllama();
    if (ollama.detected) {
      console.log(`  Ollama:          ${fmtMod.success("detected")}`);
      const extractionModel = ollama.models.find((m) =>
        m.includes("strata-extraction")
      );
      const summarizationModel = ollama.models.find((m) =>
        m.includes("strata-summarization") || m.includes("strata-summary")
      );
      console.log(
        `  Extraction model: ${extractionModel ? fmtMod.success(extractionModel) : fmtMod.dim("not loaded")}`
      );
      console.log(
        `  Summarization model: ${summarizationModel ? fmtMod.success(summarizationModel) : fmtMod.dim("not loaded")}`
      );
    } else {
      console.log(`  Ollama:          ${fmtMod.dim("not detected")}`);
      console.log(`  Extraction model: ${fmtMod.dim("not loaded")}`);
      console.log(`  Summarization model: ${fmtMod.dim("not loaded")}`);
    }
    console.log();

    // Current mode
    const { description } = getCurrentMode();
    console.log(`Current mode: ${fmtMod.active(description)}`);
    console.log();

    // Next steps
    if (!extractionReady && !summarizationReady) {
      if (!process.env.GEMINI_API_KEY) {
        console.log("To start collecting training data:");
        console.log(
          "  1. Get a free Gemini API key at https://aistudio.google.com/apikey"
        );
        console.log("  2. export GEMINI_API_KEY=<your-key>");
        console.log("  3. Use Strata normally -- training pairs accumulate automatically");
      } else {
        console.log("Training data is accumulating. Keep using Strata normally.");
        console.log(
          `Need ${fmt(Math.max(DISTILL_THRESHOLD - extractionUsable, 0))} more extraction and ${fmt(Math.max(DISTILL_THRESHOLD - summarizationUsable, 0))} more summarization pairs.`
        );
      }
    } else {
      console.log("To begin fine-tuning:");
      console.log("  pip install 'strata-memory[distill]'");
      console.log("  strata-distill start --task extraction");
    }
  } finally {
    db.close();
  }
}

/**
 * Run the `strata distill export-data` command.
 */
export async function runDistillExport(
  args: string[],
  flags: Record<string, string | boolean>
): Promise<void> {
  const { openDatabase } = await import("../storage/database.js");
  const { iterateTrainingData } = await import(
    "../extensions/llm-extraction/training-capture.js"
  );

  // Parse --task and --output flags
  const taskType = flags.task as string | undefined;
  const outputPath = flags.output as string | undefined;
  const minQuality = flags["min-quality"]
    ? parseFloat(String(flags["min-quality"]))
    : 0.7;

  if (!taskType || !["extraction", "summarization", "dialogue", "conflict"].includes(taskType)) {
    console.log(
      "Usage: strata distill export-data --task <extraction|summarization|dialogue|conflict> --output <path.jsonl> [--min-quality <0.0-1.0>]"
    );
    process.exit(1);
  }

  if (!outputPath) {
    console.log(
      "Usage: strata distill export-data --task <extraction|summarization|dialogue|conflict> --output <path.jsonl> [--min-quality <0.0-1.0>]"
    );
    process.exit(1);
  }

  // Load the appropriate system prompt
  let systemPrompt: string;
  if (taskType === "extraction") {
    // Dynamically import to get the prompt constant
    const mod = await import(
      "../extensions/llm-extraction/enhanced-extractor.js"
    );
    // The EXTRACTION_PROMPT is not exported, but it's embedded in each input_text
    // stored in training_data (the prompt is prepended to the transcript).
    // We still need the raw system prompt for the chat-template format.
    // Since the prompt is a private const, we extract it from the module source
    // or hardcode the well-known prefix. In practice, the input_text already
    // contains the full prompt + transcript. For the JSONL format, we split
    // the system prompt from the user input.
    systemPrompt = getExtractionPrompt();
  } else if (taskType === "dialogue") {
    // Dialogue pairs store the full context (player message + memories) as
    // input_text and the NPC response as output_json. No system prompt
    // splitting needed — export them as-is.
    systemPrompt = "";
  } else if (taskType === "conflict") {
    // Conflict resolution pairs: input_text is the classification prompt
    // (candidate + similar entries), output_json is the resolution JSON.
    // No additional system prompt needed — the full context is in input_text.
    systemPrompt = "";
  } else {
    systemPrompt = getSummarizerPrompt();
  }

  const db = openDatabase();
  try {
    const stream = createWriteStream(outputPath, { encoding: "utf-8" });
    let count = 0;

    for (const row of iterateTrainingData(
      db,
      taskType as "extraction" | "summarization" | "dialogue" | "conflict",
      minQuality
    )) {
      // The input_text contains SYSTEM_PROMPT + transcript.
      // For the chat template, we want to split them.
      // The system prompt ends at the transcript section, which is the
      // content after the known prompt prefix. We use the stored input_text
      // as the human message since it already represents what the model saw.
      // The system prompt is provided separately for SFT training format.
      const humanMessage = row.inputText;
      const assistantMessage = row.outputJson;

      const line = JSON.stringify({
        conversations: [
          { from: "system", value: systemPrompt },
          { from: "human", value: humanMessage },
          { from: "gpt", value: assistantMessage },
        ],
      });

      stream.write(line + "\n");
      count++;
    }

    await new Promise<void>((resolve, reject) => {
      stream.end((err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });

    console.log(`Exported ${fmt(count)} pairs to ${outputPath}`);
  } finally {
    db.close();
  }
}

/**
 * Run the `strata distill activate` command.
 */
export async function runDistillActivate(): Promise<void> {
  writeConfig({ distillation: { enabled: true } });
  console.log("Distillation mode activated.");
  console.log("Strata will use the local Ollama model when available, falling back to Gemini.");
  console.log("");
  console.log("Make sure Ollama is running with your fine-tuned model loaded:");
  console.log("  ollama create strata-extraction -f Modelfile");
  console.log("  ollama run strata-extraction");
}

/**
 * Run the `strata distill deactivate` command.
 */
export async function runDistillDeactivate(): Promise<void> {
  writeConfig({ distillation: { enabled: false } });
  console.log("Distillation mode deactivated.");
  console.log("Strata will use the standard provider (Gemini or heuristic).");
}

/**
 * Options for `strata distill setup`.
 */
export interface DistillSetupOptions {
  /** Skip the `ollama pull` step. Useful for tests and CI. */
  skipPull?: boolean;
  /** Override the Ollama base URL (default: http://localhost:11434). */
  ollamaUrl?: string;
}

/**
 * Print platform-specific instructions for setting OLLAMA_NUM_PARALLEL=2.
 * Does not execute any system commands — guidance only.
 */
function trySetOllamaParallel(): void {
  if (process.platform === "win32") {
    console.log(
      "[distill setup] On Windows: set OLLAMA_NUM_PARALLEL=2 via System Environment Variables, " +
      "then restart the Ollama service. Required so dialogue + extraction share the model.",
    );
    return;
  }
  if (process.platform === "linux") {
    console.log(
      "[distill setup] On Linux: add 'Environment=OLLAMA_NUM_PARALLEL=2' to " +
      "/etc/systemd/system/ollama.service under [Service], then 'systemctl daemon-reload && systemctl restart ollama'.",
    );
    return;
  }
  if (process.platform === "darwin") {
    console.log(
      "[distill setup] On macOS: run 'launchctl setenv OLLAMA_NUM_PARALLEL 2', then restart Ollama.",
    );
    return;
  }
}

/**
 * Run the `strata distill setup` command.
 *
 * One-step onboarding for local inference:
 *  1. Probe Ollama /api/tags
 *  2. Pull gemma3:4b (default) + gemma3:1b + gemma4:e2b + gemma4:e4b (skippable via --skip-pull)
 *  3. Write distillation block to ~/.strata/config.json
 *  4. Print OLLAMA_NUM_PARALLEL guidance for the current platform
 */
export async function runDistillSetup(options: DistillSetupOptions = {}): Promise<void> {
  const ollamaUrl = options.ollamaUrl || "http://localhost:11434";

  console.log("Strata Local Inference Setup");
  console.log("");

  // Step 1: Probe Ollama
  console.log("[1/3] Checking Ollama installation...");
  let availableModels: string[] = [];
  try {
    const response = await fetch(`${ollamaUrl}/api/tags`);
    if (!response.ok) {
      throw new Error(`Ollama returned HTTP ${response.status}`);
    }
    const body = (await response.json()) as { models?: Array<{ name: string }> };
    availableModels = (body.models || []).map((m) => m.name);
    console.log(`  OK  Ollama detected at ${ollamaUrl}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Ollama not reachable at ${ollamaUrl}: ${message}\n` +
        "  Install Ollama from https://ollama.com and ensure it is running."
    );
  }

  // Step 2: Pull models
  const MODELS_TO_PULL = [
    "gemma3:4b",    // new default extraction model (3.3 GB, 63.3% baseline)
    "gemma3:1b",    // future distillation base (815 MB)
    "gemma4:e2b",   // opt-in higher quality (7.2 GB)
    "gemma4:e4b",   // opt-in ceiling quality (9.6 GB)
  ];
  if (options.skipPull) {
    console.log("[2/3] Skipping model pulls (--skip-pull).");
  } else {
    console.log("[2/3] Pulling Gemma models...");
    const { execSync } = await import("child_process");
    for (const model of MODELS_TO_PULL) {
      if (availableModels.includes(model)) {
        console.log(`  OK  ${model} already present`);
        continue;
      }
      console.log(`  Pulling ${model}...`);
      try {
        execSync(`ollama pull ${model}`, { stdio: "inherit" });
        console.log(`  OK  ${model}`);
      } catch (err) {
        throw new Error(
          `Failed to pull ${model}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  // Step 3: Write config
  console.log("[3/3] Updating ~/.strata/config.json...");
  const existing = readConfig();
  const merged = {
    ...existing,
    distillation: {
      enabled: true,
      localUrl: ollamaUrl,
      extractionModel: "gemma3:4b",
      summarizationModel: "gemma4:e4b",
      conflictResolutionModel: "gemma4:e2b",
      fallback: "gemini",
    },
  };
  writeConfig(merged);
  console.log("  OK  distillation.enabled = true");
  console.log("  OK  extractionModel = gemma3:4b");
  console.log("  OK  summarizationModel = gemma4:e4b");
  console.log("  OK  conflictResolutionModel = gemma4:e2b");
  console.log("");
  console.log("Setup complete. Test with:");
  console.log("  strata distill test");

  // Print OLLAMA_NUM_PARALLEL guidance
  trySetOllamaParallel();
}

/**
 * Run the `strata distill test` command.
 *
 * Exercises each pipeline stage end-to-end:
 *  1. Extraction — short prompt, expects valid entries JSON
 *  2. Summarization — short prompt, expects valid topic JSON
 *  3. Conflict resolution — short prompt, expects valid shouldAdd JSON
 *
 * Uses the factory so the same hybrid provider stack applied in
 * strata-pro's ingest_conversation is validated here.
 */
export async function runDistillTest(): Promise<void> {
  const {
    getExtractionProvider,
    getSummarizationProvider,
    getConflictResolutionProvider,
    validateExtractionOutput,
    validateSummarizationOutput,
    validateConflictResolutionOutput,
  } = await import("../extensions/llm-extraction/provider-factory.js");

  console.log("Testing local inference pipeline...");
  console.log("");

  let anyFailures = false;

  // Extraction
  try {
    console.log("[1/3] Extraction test (extraction provider)...");
    const provider = await getExtractionProvider();
    if (!provider) {
      console.log("  FAIL  no extraction provider (missing GEMINI_API_KEY?)");
      anyFailures = true;
    } else {
      const prompt =
        'Return ONLY valid JSON: {"entries":[{"type":"fact","summary":"user likes coffee"}]}';
      const start = Date.now();
      const raw = await provider.complete(prompt, { timeoutMs: 30000 });
      const ms = Date.now() - start;
      if (validateExtractionOutput(raw)) {
        console.log(`  OK  valid JSON with entries (${ms}ms)`);
      } else {
        console.log(`  FAIL  output did not match entries schema: ${raw.slice(0, 200)}`);
        anyFailures = true;
      }
    }
  } catch (err) {
    console.log(`  FAIL  ${err instanceof Error ? err.message : String(err)}`);
    anyFailures = true;
  }

  // Summarization
  try {
    console.log("[2/3] Summarization test (summarization provider)...");
    const provider = await getSummarizationProvider();
    if (!provider) {
      console.log("  FAIL  no summarization provider");
      anyFailures = true;
    } else {
      const prompt = 'Return ONLY valid JSON: {"topic":"test topic"}';
      const start = Date.now();
      const raw = await provider.complete(prompt, { timeoutMs: 30000 });
      const ms = Date.now() - start;
      if (validateSummarizationOutput(raw)) {
        console.log(`  OK  valid JSON with topic (${ms}ms)`);
      } else {
        console.log(`  FAIL  output did not match topic schema: ${raw.slice(0, 200)}`);
        anyFailures = true;
      }
    }
  } catch (err) {
    console.log(`  FAIL  ${err instanceof Error ? err.message : String(err)}`);
    anyFailures = true;
  }

  // Conflict resolution
  try {
    console.log("[3/3] Conflict resolution test (conflict-resolution provider)...");
    const provider = await getConflictResolutionProvider();
    if (!provider) {
      console.log("  FAIL  no conflict resolution provider");
      anyFailures = true;
    } else {
      const prompt = 'Return ONLY valid JSON: {"shouldAdd":true,"actions":[]}';
      const start = Date.now();
      const raw = await provider.complete(prompt, { timeoutMs: 20000 });
      const ms = Date.now() - start;
      if (validateConflictResolutionOutput(raw)) {
        console.log(`  OK  valid resolution (${ms}ms)`);
      } else {
        console.log(`  FAIL  output did not match resolution schema: ${raw.slice(0, 200)}`);
        anyFailures = true;
      }
    }
  } catch (err) {
    console.log(`  FAIL  ${err instanceof Error ? err.message : String(err)}`);
    anyFailures = true;
  }

  // Parallelism probe
  await probeParallelism();

  console.log("");
  if (anyFailures) {
    console.log("Some checks failed. See output above.");
  } else {
    console.log("All checks passed. Local inference is ready.");
  }
}

/**
 * Probe whether Ollama is serving requests in parallel.
 * Makes one sequential call and two simultaneous calls, then compares wall times.
 * If the parallel pair takes >1.6x the single call, Ollama is likely serializing.
 */
async function probeParallelism(): Promise<void> {
  console.log("[distill test] Parallelism probe (OLLAMA_NUM_PARALLEL)...");
  const { OllamaProvider } = await import("../extensions/llm-extraction/llm-provider.js");
  const p = new OllamaProvider("gemma3:4b");
  const prompt = "Say hi in exactly one word.";

  const t0 = Date.now();
  await p.complete(prompt, { maxTokens: 4, timeoutMs: 30_000 });
  const singleMs = Date.now() - t0;

  const t1 = Date.now();
  await Promise.all([
    p.complete(prompt, { maxTokens: 4, timeoutMs: 30_000 }),
    p.complete(prompt, { maxTokens: 4, timeoutMs: 30_000 }),
  ]);
  const parallelMs = Date.now() - t1;

  const overhead = parallelMs / singleMs;
  console.log(`[distill test]   single call: ${singleMs}ms`);
  console.log(`[distill test]   two parallel calls: ${parallelMs}ms (${overhead.toFixed(2)}x single)`);
  if (overhead > 1.6) {
    console.warn(
      "[distill test] ⚠ Parallelism appears serial (two calls ≈ 2× one). " +
      "Set OLLAMA_NUM_PARALLEL>=2 and restart Ollama, or NPC dialogue will block on extraction.",
    );
  } else {
    console.log("[distill test] ✓ Ollama is serving requests in parallel.");
  }
}

// ---------------------------------------------------------------------------
// System prompts for JSONL export
// ---------------------------------------------------------------------------

/**
 * The extraction system prompt used in enhanced-extractor.ts.
 * This must match the EXTRACTION_PROMPT constant in that file.
 */
function getExtractionPrompt(): string {
  return `You are analyzing a coding assistant conversation to extract knowledge entries. Find decisions, solutions, error fixes, and patterns — especially implicit ones that simple regex would miss.

Return ONLY valid JSON with this exact structure (no markdown, no explanation):
{
  "entries": [
    {
      "type": "decision|solution|error_fix|pattern|procedure",
      "summary": "Concise description (under 120 chars)",
      "details": "Optional elaboration with context, or JSON for procedures",
      "tags": ["relevant", "technology", "tags"],
      "relatedFiles": ["/path/to/file.ts"]
    }
  ]
}

Extraction rules:
- "decision": Choices between alternatives, even implicit ones like "After trying X, Y worked better"
- "solution": Problems solved, bugs fixed. Include WHAT was wrong and HOW it was fixed.
- "error_fix": Error message paired with its resolution.
- "pattern": Reusable approaches, anti-patterns, or best practices discovered.
- "procedure": Sequential workflows, how-to guides, step-by-step processes. Extract steps as an ordered JSON array in the details field. Format: {"steps": ["step1", "step2", ...], "prerequisites": [...], "warnings": [...]}
- Maximum 10 entries total.
- Each summary under 120 characters.
- Focus on entries that regex pattern matching would MISS (implicit decisions, multi-turn context).
- Do NOT extract trivial file edits or routine operations.`;
}

/**
 * The summarizer system prompt used in smart-summarizer.ts.
 * This must match the SUMMARIZER_PROMPT constant in that file.
 */
function getSummarizerPrompt(): string {
  return `You are analyzing a coding assistant conversation session. Extract structured knowledge from the conversation.

Return ONLY valid JSON with this exact structure (no markdown, no explanation):
{
  "topic": "One sentence describing what this session was about",
  "keyDecisions": ["Decision 1", "Decision 2"],
  "solutionsFound": ["Solution 1", "Solution 2"],
  "patterns": ["Pattern 1"],
  "actionableLearnings": ["Learning 1", "Learning 2"]
}

Rules:
- topic: Brief (under 100 chars), specific description
- keyDecisions: Architectural or implementation choices made. Empty array if none.
- solutionsFound: Bugs fixed, problems solved. Include the problem and solution. Empty array if none.
- patterns: Reusable approaches or anti-patterns discovered. Empty array if none.
- actionableLearnings: Concrete takeaways someone could apply in future work. Empty array if none.
- Each array item should be a concise sentence (under 120 chars).
- Maximum 5 items per array.`;
}
