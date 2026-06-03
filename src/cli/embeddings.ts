/**
 * CLI commands for the embeddings subsystem.
 *
 * Subcommands:
 *   strata embeddings status   — Show active provider, model, dims, and vector coverage
 *   strata embeddings use      — Switch active embedding provider (writes config.json)
 *   strata embeddings reindex  — Re-embed knowledge entries under the active model
 *   strata embeddings pull     — (stub) Download model weights from the worker CDN
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { resolveActiveEmbeddingModel } from "../extensions/embeddings/active-model.js";

// ---------------------------------------------------------------------------
// Config helpers — mirrors distill.ts so both read/write the same file
// ---------------------------------------------------------------------------

function getConfigPath(): string {
  return join(
    process.env.STRATA_DATA_DIR || join(homedir(), ".strata"),
    "config.json"
  );
}

function readConfig(): Record<string, unknown> {
  const p = getConfigPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

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

// ---------------------------------------------------------------------------
// strata embeddings status
// ---------------------------------------------------------------------------

export async function runEmbeddingsStatus(
  _args: string[],
  _flags: Record<string, unknown>
): Promise<void> {
  const active = resolveActiveEmbeddingModel();

  console.log("Embedding provider status");
  console.log("─────────────────────────");
  console.log(`  Provider:   ${active.provider}`);
  console.log(`  Model:      ${active.model}`);
  console.log(`  Dimensions: ${active.dimensions}`);
  console.log("");

  // Try to open the SQLite DB for vector coverage (best-effort; skip if not available)
  try {
    const { openDatabase } = await import("../storage/database.js");
    const { detectEmbeddingMismatch } = await import("../extensions/embeddings/mismatch.js");
    const path = join(
      process.env.STRATA_DATA_DIR || join(homedir(), ".strata"),
      "strata.db"
    );
    if (existsSync(path)) {
      const db = openDatabase(path);
      const result = detectEmbeddingMismatch(db, active.model);
      db.close();

      console.log(`  Vectors under active model:  ${result.activeModelVectors}`);
      console.log(`  Vectors under other models:  ${result.otherModelVectors}`);
      if (result.mismatch) {
        console.log("");
        console.log("  ⚠ MISMATCH: corpus has vectors from a different model.");
        console.log("    Run `strata embeddings reindex` to rebuild under the active model.");
      } else if (result.activeModelVectors === 0 && result.otherModelVectors === 0) {
        console.log("");
        console.log("  No vectors found. Start indexing sessions to populate embeddings.");
      } else {
        console.log("");
        console.log("  Coverage looks good.");
      }
    } else {
      console.log("  (No database found at default path — start strata to create it.)");
    }
  } catch {
    // Not fatal — user may not have a local DB yet
    console.log("  (Could not open local database for coverage stats.)");
  }
}

// ---------------------------------------------------------------------------
// strata embeddings use <provider> [--model <name>] [--dimensions <n>]
//                                  [--base-url <url>] [--api-key <key>]
// ---------------------------------------------------------------------------

export async function runEmbeddingsUse(
  args: string[],
  flags: Record<string, unknown>
): Promise<void> {
  const provider = args[0] as "gemini" | "local" | "openai-compatible" | undefined;

  const VALID_PROVIDERS = ["gemini", "local", "openai-compatible"];
  if (!provider || !VALID_PROVIDERS.includes(provider)) {
    console.log("Usage: strata embeddings use <gemini|local|openai-compatible>");
    console.log("       [--model <name>] [--dimensions <n>]");
    console.log("       [--base-url <url>]  (openai-compatible only)");
    console.log("       [--api-key <key>]   (openai-compatible only)");
    process.exit(1);
    return;
  }

  // Build the embeddings block to write
  const block: Record<string, unknown> = { provider };
  if (flags.model) block.model = flags.model;
  if (flags.dimensions) block.dimensions = Number(flags.dimensions);
  if (flags["base-url"]) block.baseUrl = flags["base-url"];
  if (flags["api-key"]) block.apiKey = flags["api-key"];

  writeConfig({ embeddings: block });

  const resolved = resolveActiveEmbeddingModel();
  console.log(`Embeddings provider set to: ${provider}`);
  console.log(`  Model:      ${resolved.model}`);
  console.log(`  Dimensions: ${resolved.dimensions}`);

  if (provider === "local") {
    console.log("");
    console.log("Note: local provider requires model weights.");
    console.log("  Run `strata embeddings pull` once weights distribution is available.");
    console.log("  Then run `strata embeddings reindex` to embed your knowledge entries.");
  } else if (provider === "openai-compatible") {
    if (!flags["base-url"]) {
      console.log("");
      console.log("Note: set STRATA_EMBEDDING_BASE_URL (or re-run with --base-url) before using.");
    }
    console.log("");
    console.log("Run `strata embeddings reindex` to embed your knowledge entries.");
  } else {
    console.log("Run `strata embeddings reindex` if you have existing entries to re-embed.");
  }
}

// ---------------------------------------------------------------------------
// strata embeddings reindex — delegated to reindex.ts
// ---------------------------------------------------------------------------

export async function runEmbeddingsReindex(
  _args: string[],
  _flags: Record<string, unknown>
): Promise<void> {
  const active = resolveActiveEmbeddingModel();
  console.log(`Reindexing knowledge entries under model: ${active.model}`);

  try {
    const { openDatabase } = await import("../storage/database.js");
    const { createEmbeddingProvider } = await import("../extensions/vector-search/embedding-provider.js");
    const { reindexEmbeddings } = await import("../extensions/embeddings/reindex.js");

    const path = join(
      process.env.STRATA_DATA_DIR || join(homedir(), ".strata"),
      "strata.db"
    );
    if (!existsSync(path)) {
      console.log("No database found. Start strata first to create it.");
      return;
    }

    let provider;
    try {
      provider = createEmbeddingProvider();
    } catch (e: any) {
      console.log(`Cannot create embedding provider: ${e.message}`);
      console.log("Check your provider configuration and credentials.");
      return;
    }

    const db = openDatabase(path);
    const result = await reindexEmbeddings(db, provider);
    db.close();

    console.log(`Reindex complete:`);
    console.log(`  Embedded: ${result.embedded}`);
    console.log(`  Failed: ${result.failed}`);
  } catch (e: any) {
    console.log(`Reindex error: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// strata embeddings pull — stub (weights distribution deferred to T14/T15)
// ---------------------------------------------------------------------------

export async function runEmbeddingsPull(
  _args: string[],
  _flags: Record<string, unknown>
): Promise<void> {
  console.log("strata embeddings pull: not yet available.");
  console.log("Model weight distribution is implemented in Task 14/15 (worker route).");
  console.log("Once available, this command will download weights to ~/.strata/models/.");
}
