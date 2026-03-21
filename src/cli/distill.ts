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
      console.log("  pip install strata-memory[distill]");
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

  if (!taskType || !["extraction", "summarization"].includes(taskType)) {
    console.log(
      "Usage: strata distill export-data --task <extraction|summarization> --output <path.jsonl> [--min-quality <0.0-1.0>]"
    );
    process.exit(1);
  }

  if (!outputPath) {
    console.log(
      "Usage: strata distill export-data --task <extraction|summarization> --output <path.jsonl> [--min-quality <0.0-1.0>]"
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
  } else {
    systemPrompt = getSummarizerPrompt();
  }

  const db = openDatabase();
  try {
    const stream = createWriteStream(outputPath, { encoding: "utf-8" });
    let count = 0;

    for (const row of iterateTrainingData(
      db,
      taskType as "extraction" | "summarization",
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
