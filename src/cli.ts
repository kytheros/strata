#!/usr/bin/env node

/**
 * Strata CLI entry point.
 *
 * Routes to MCP server (default) or CLI subcommands:
 *   (no args)             → start MCP server on stdio
 *   search "query"        → search and print results
 *   find-procedures "q"   → search procedure entries
 *   entities "q"          → search entity graph
 *   store-memory "text"   → store an explicit memory
 *   migrate               → run legacy data migration
 *   status                → print index statistics
 *   --version             → print version
 *   --help                → print usage
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import type { PlatformId } from "./cli/platform.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, "..", "package.json"), "utf-8")
    );
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function printHelp(): void {
  const version = getVersion();
  console.log(`strata v${version} — Mine your AI coding history for searchable knowledge

Usage:
  strata                                  Start MCP server on stdio (default)
  strata serve                            Start HTTP server on port 3000 (or $PORT)
  strata serve --rest                     Start REST API on port 3001
  strata serve --rest --rest-port 8080    REST API on custom port
  strata serve --rest --rest-token SECRET REST API with bearer token auth
  strata serve --rest --multi-tenant      REST + multi-tenant MCP mode
  strata search <query>                   Search conversation history
  strata find-procedures <query>          Search for procedures (Pro)
  strata entities [query]                 Search entity graph (Pro)
  strata store-memory <text> --type <t>   Store an explicit memory
  strata migrate                          Migrate legacy data to SQLite
  strata status                           Print index statistics
  strata index --rebuild-turns            Backfill knowledge_turns from session files (TIR+QDP opt-in)
  strata index --backfill-junction        Backfill knowledge_entities junction from existing knowledge entries
  strata activate <key>                   Activate a license (JWT or Polar key)
  strata update                           Check for and install newer versions
  strata license                          Show current license status
  strata embed                            Generate embeddings for vector search
  strata world-migrate                    Migrate legacy agents/players/ layout to world-scoped DB
  strata backup push <s3-uri>             Upload ~/.strata/strata.db to S3-compatible bucket
  strata backup pull <s3-uri>             Download backup to ~/.strata/strata.db
  strata backup status <s3-uri>           Show local vs. remote size and mtime
  strata distill status                   Show distillation training data stats
  strata distill export-data              Export training data to JSONL
  strata distill activate                 Enable local model distillation mode
  strata distill deactivate               Disable local model distillation mode
  strata distill setup                    One-step Gemma 4 local inference setup
  strata distill test                     Verify local inference pipeline
  strata deploy cloudflare                Deploy Strata to Cloudflare Workers + D1
  strata deploy gcp                       Deploy Strata to GCP Cloud Run
  strata deploy gcp --multi-tenant        Deploy multi-tenant Strata on Cloud Run + Cloud SQL
  strata init                             Auto-detect CLIs and set up all found
  strata init --claude                   Set up Claude Code integration only
  strata init --gemini                   Set up Gemini CLI integration only
  strata init --all                      Set up all supported CLIs
  strata --version                        Print version
  strata --help                           Print this help

  Also available as: strata-mcp (alias)

Search flags:
  --limit <n>       Maximum results (default: 20)
  --project <name>  Filter by project
  --tool <name>     Filter by tool (claude-code, codex, aider)
  --json            Output results as JSON

Find-procedures flags:
  --project <name>  Filter by project
  --json            Output results as JSON

Entities flags:
  --type <type>     Filter by entity type (library, service, tool, etc.)
  --project <name>  Filter by project
  --limit <n>       Maximum results (default: 10)
  --json            Output results as JSON

Store-memory flags:
  --type <type>     Memory type (required): decision, solution, error_fix,
                    pattern, learning, procedure, fact, preference, episodic
  --tags <tags>     Comma-separated tags
  --project <name>  Project scope (default: global)
  --json            Output result as JSON

Serve flags:
  --port <n>        HTTP port (default: 3000 or $PORT)
  --multi-tenant    Enable multi-tenant HTTP mode (per-user databases)
  --data-dir <path> Base directory for per-user databases (overrides STRATA_DATA_DIR)
  --max-dbs <n>     Max open databases in pool (default: 200)
  --rest            Start REST API for game engines (default port: 3001)
  --rest-port <n>   REST API port (default: 3001)
  --rest-token <t>  Bearer token for REST API auth (or STRATA_REST_TOKEN env)
  --rest-max-agents <n>  LRU cap for per-(player, npc) cache (default: 200)

Activate flags:
  --binary          Download standalone binary instead of tarball
  --platform <id>   Override platform detection (linux-x64, darwin-arm64,
                    darwin-x64, win-x64)

Init flags:
  --gemini          Set up Gemini CLI integration only
  --claude          Set up Claude Code integration only
  --all             Set up all supported CLIs (even if not detected)
  --global          Install skills and commands to ~ instead of project dir
  --force           Overwrite existing skills, hooks, and context files

Deploy cloudflare flags:
  --account-id <id>   Cloudflare account ID (prompted if omitted)
  --db-name <name>    D1 database name (default: strata-db)
  --worker-name <n>   Worker name (default: strata-mcp)
  --token <token>     Gateway auth token (auto-generated if omitted)
  --gemini-key <key>  Gemini API key for semantic search
  --out-dir <path>    Output directory (default: ./strata-cloudflare)

Distill export-data flags:
  --task <type>     Task type: extraction or summarization (required)
  --output <path>   Output file path for JSONL (required)
  --min-quality <n> Minimum quality score (default: 0.7)

Migrate flags:
  --force           Re-run migration even if already completed

Global flags:
  --no-color        Disable colored output (also: NO_COLOR env var)

Environment:
  STRATA_DATA_DIR       Data directory (default: ~/.strata/)
  STRATA_LICENSE_KEY    License key (alternative to activate command)
  NO_COLOR              Disable colored output (any value)
`);
}

function parseArgs(argv: string[]): {
  command: string;
  args: string[];
  flags: Record<string, string | boolean>;
} {
  const args: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let command = "";

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--version" || arg === "-v") {
      flags.version = true;
    } else if (arg === "--help" || arg === "-h") {
      flags.help = true;
    } else if (arg === "--json") {
      flags.json = true;
    } else if (arg === "--force") {
      flags.force = true;
    } else if (arg === "--limit" && i + 1 < argv.length) {
      flags.limit = argv[++i];
    } else if (arg === "--project" && i + 1 < argv.length) {
      flags.project = argv[++i];
    } else if (arg === "--tool" && i + 1 < argv.length) {
      flags.tool = argv[++i];
    } else if (arg === "--port" && i + 1 < argv.length) {
      flags.port = argv[++i];
    } else if (arg === "--multi-tenant") {
      flags["multi-tenant"] = true;
    } else if (arg === "--rest") {
      flags["rest"] = true;
    } else if (arg === "--rest-port" && i + 1 < argv.length) {
      flags["rest-port"] = argv[++i];
    } else if (arg === "--rest-token" && i + 1 < argv.length) {
      flags["rest-token"] = argv[++i];
    } else if (arg === "--rest-max-agents" && i + 1 < argv.length) {
      flags["rest-max-agents"] = argv[++i];
    } else if (arg === "--rest-max-worlds" && i + 1 < argv.length) {
      flags["rest-max-worlds"] = argv[++i];
    } else if (arg === "--data-dir" && i + 1 < argv.length) {
      flags["data-dir"] = argv[++i];
    } else if (arg === "--max-dbs" && i + 1 < argv.length) {
      flags["max-dbs"] = argv[++i];
    } else if (arg === "--type" && i + 1 < argv.length) {
      flags.type = argv[++i];
    } else if (arg === "--tags" && i + 1 < argv.length) {
      flags.tags = argv[++i];
    } else if (arg === "--binary") {
      flags.binary = true;
    } else if (arg === "--platform" && i + 1 < argv.length) {
      flags.platform = argv[++i];
    } else if (arg === "--gemini") {
      flags.gemini = true;
    } else if (arg === "--claude") {
      flags.claude = true;
    } else if (arg === "--all") {
      flags.all = true;
    } else if (arg === "--global") {
      flags.global = true;
    } else if (arg === "--no-color") {
      flags["no-color"] = true;
    } else if (arg === "--player-id" && i + 1 < argv.length) {
      flags["player-id"] = argv[++i];
    } else if (arg === "--dry-run") {
      flags["dry-run"] = true;
    } else if (arg === "--status") {
      flags["status"] = true;
    } else if (arg === "--rebuild-turns") {
      flags["rebuild-turns"] = true;
    } else if (arg === "--backfill-junction") {
      flags["backfill-junction"] = true;
    } else if (arg === "--task" && i + 1 < argv.length) {
      flags.task = argv[++i];
    } else if (arg === "--output" && i + 1 < argv.length) {
      flags.output = argv[++i];
    } else if (arg === "--min-quality" && i + 1 < argv.length) {
      flags["min-quality"] = argv[++i];
    } else if (!arg.startsWith("-") && !command) {
      command = arg;
    } else if (!arg.startsWith("-")) {
      args.push(arg);
    }
    i++;
  }

  return { command, args, flags };
}

export async function runSearch(
  query: string,
  flags: Record<string, string | boolean>
): Promise<void> {
  const { SqliteIndexManager } = await import(
    "./indexing/sqlite-index-manager.js"
  );
  const { SqliteSearchEngine } = await import(
    "./search/sqlite-search-engine.js"
  );
  const fmt = await import("./cli/formatter.js");
  fmt.initColor(flags);

  const indexManager = new SqliteIndexManager();

  // Ensure index is populated
  const stats = indexManager.getStats();
  if (stats.documents === 0) {
    indexManager.buildFullIndex();
  } else {
    indexManager.incrementalUpdate();
  }

  const searchEngine = new SqliteSearchEngine(indexManager.documents);

  // Build query with tool filter if specified
  let searchQuery = query;
  if (flags.tool) {
    searchQuery += ` tool:${flags.tool}`;
  }

  const limit = flags.limit ? parseInt(String(flags.limit), 10) : 20;
  const project = flags.project ? String(flags.project) : undefined;

  const start = performance.now();

  // Query 1: FTS5 conversation index (existing behavior)
  const docResults = await searchEngine.search(searchQuery, { limit, project });

  // Query 2: knowledge table (stored memories via store-memory)
  // The knowledge store is the source of truth for explicit memories; it is
  // never indexed into the FTS5 document store so must be queried separately.
  const { knowledgeEntriesToSearchResults } = await import(
    "./search/knowledge-to-search-result.js"
  );
  let knowledgeResults: typeof docResults = [];
  try {
    // Pass the raw `query` here, NOT `searchQuery` — the FTS5 engine understands
    // `tool:X` inline filters, but the knowledge store does plain-text search over
    // summary+details and would treat "tool:X" as a literal substring (zero matches).
    const entries = await indexManager.knowledge.search(query, project, undefined);
    knowledgeResults = knowledgeEntriesToSearchResults(entries);
  } catch {
    // If the knowledge table query fails, continue with document results only.
  }

  // Merge and sort by score descending; apply the --limit cap to the combined list.
  const merged = [...docResults, ...knowledgeResults]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const elapsed = ((performance.now() - start) / 1000).toFixed(2);

  if (merged.length === 0) {
    console.log("No results found.");
    indexManager.close();
    process.exit(1);
  }

  // Shadow `results` with the merged list for the formatter below.
  const results = merged;

  if (flags.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    const sessionCount = new Set(results.map((r) => r.sessionId)).size;
    console.log(fmt.success(`  Found ${results.length} results across ${sessionCount} sessions (${elapsed}s)`));
    console.log();

    const boxWidth = 80;
    // Inner content width: boxWidth - 2 (left/right │) - 3 (left pad) - 3 (right pad)
    const contentMax = boxWidth - 8;

    for (const r of results) {
      const date = new Date(r.timestamp).toISOString().slice(0, 10);
      const snippetText = r.text.replace(/\n/g, " ").trim();
      const wrappedLines = fmt.wordWrap(snippetText, contentMax);

      console.log(`  ${fmt.topBorder(`Session ${date}`, boxWidth)}`);
      for (const line of wrappedLines) {
        console.log(`  ${fmt.boxLine(fmt.text(line), contentMax)}`);
      }
      console.log(`  ${fmt.boxLine(`${fmt.dim("Score: ")}${fmt.active(r.score.toFixed(2))}  ${fmt.dim(fmt.BOX.vertical)}  ${fmt.dim("Project: ")}${fmt.text(r.project)}`, contentMax)}`);
      console.log(`  ${fmt.bottomBorder(boxWidth)}`);
    }
  }

  indexManager.close();
}

function proFeatureMessage(feature: string): void {
  console.log(`The "${feature}" command requires Strata Pro.`);
  console.log("Visit strata.kytheros.dev/pricing to upgrade.");
  process.exit(1);
}

export async function runStoreMemory(
  memoryText: string,
  flags: Record<string, string | boolean>
): Promise<void> {
  const { SqliteIndexManager } = await import("./indexing/sqlite-index-manager.js");
  const { handleStoreMemory } = await import("./tools/store-memory.js");
  const fmt = await import("./cli/formatter.js");
  fmt.initColor(flags);

  const indexManager = new SqliteIndexManager();
  const knowledgeStore = indexManager.knowledge;

  const type = String(flags.type || "");
  const tags = flags.tags ? String(flags.tags).split(",").map((t) => t.trim()).filter(Boolean) : [];
  const project = flags.project ? String(flags.project) : undefined;

  const result = await handleStoreMemory(knowledgeStore, {
    memory: memoryText,
    type: type as any,
    tags,
    project,
  });

  indexManager.close();

  if (result.startsWith("Error:")) {
    console.log(result);
    process.exit(1);
  }

  if (flags.json) {
    console.log(JSON.stringify({ result, type, tags, project: project ?? "global" }, null, 2));
    return;
  }

  // Colorize the result
  if (result.startsWith("Stored")) {
    // "Stored decision: "Use bcrypt..." [tags: ...] (replaced N conflicting...)"
    const storedMatch = result.match(/^Stored (\w+): "(.*?)"(.*)$/);
    if (storedMatch) {
      console.log(`  ${fmt.success(`Stored ${storedMatch[1]}:`)} ${fmt.text(`"${storedMatch[2]}"`)}`);
      if (storedMatch[3].trim()) {
        // Conflict info like "(replaced 1 conflicting entry)"
        console.log(`  ${fmt.active(storedMatch[3].trim())}`);
      }
    } else {
      console.log(`  ${fmt.success(result)}`);
    }
  } else if (result.startsWith("Skipped")) {
    console.log(`  ${fmt.dim(result)}`);
  } else {
    console.log(`  ${fmt.text(result)}`);
  }
}

async function runMigrate(
  flags: Record<string, string | boolean>
): Promise<void> {
  const { migrate } = await import("./cli/migrate.js");
  await migrate({ force: Boolean(flags.force) });
}

async function runStatus(): Promise<void> {
  const { SqliteIndexManager } = await import(
    "./indexing/sqlite-index-manager.js"
  );
  const { getDbPath } = await import("./storage/database.js");

  const indexManager = new SqliteIndexManager();
  const stats = indexManager.getStats();
  const parsers = indexManager.registry.getAll();
  const detected = indexManager.registry.detectAvailable();

  const version = getVersion();
  console.log(`Strata v${version}`);
  console.log(`Database: ${getDbPath()}`);
  console.log(`Sessions: ${stats.sessions}`);
  console.log(`Documents: ${stats.documents} chunks`);
  console.log(`Projects: ${stats.projects}`);
  console.log(
    `Parsers: ${parsers.map((p) => `${p.name} (${detected.some((d) => d.id === p.id) ? "detected" : "not found"})`).join(", ")}`
  );

  indexManager.close();
}

/**
 * Detect whether a key is a Polar license key (download flow)
 * or a JWT (direct activation).
 */
function isPolarKey(key: string): boolean {
  return key.startsWith("STRATA-") || key.includes("pol_lic_");
}

async function runActivateJwt(key: string): Promise<void> {
  const { validateLicense } = await import("./extensions/license-validator.js");
  const { mkdirSync, writeFileSync } = await import("fs");
  const { join: pathJoin } = await import("path");
  const { homedir: getHomedir } = await import("os");

  const result = validateLicense(key);
  if (!result.valid) {
    console.log(`License validation failed: ${result.error}`);
    process.exit(1);
  }

  const strataDir = pathJoin(getHomedir(), ".strata");
  mkdirSync(strataDir, { recursive: true });
  const licensePath = pathJoin(strataDir, "license.key");
  writeFileSync(licensePath, key, { encoding: "utf-8", mode: 0o600 });

  const expDate = result.expiresAt
    ? new Date(result.expiresAt * 1000).toISOString().slice(0, 10)
    : "unknown";

  console.log("License activated successfully!");
  console.log(`  Tier: ${result.tier}`);
  console.log(`  Email: ${result.email}`);
  console.log(`  Features: ${result.features?.join(", ")}`);
  console.log(`  Expires: ${expDate}`);
  console.log(`  Saved to: ${licensePath}`);

  console.log("");
  console.log("Next steps:");
  console.log("  Set up semantic search (recommended):");
  console.log("  Get a free Gemini API key at https://aistudio.google.com/apikey");
  console.log("  Then: export GEMINI_API_KEY=<your-key>");
  console.log("  Or set it in the Strata dashboard settings.");
}

async function runActivatePolar(
  key: string,
  flags: Record<string, string | boolean>
): Promise<void> {
  const { fetchVersionInfo, downloadAndInstall } = await import("./cli/download.js");

  // 1. Fetch tier / version info
  let info;
  try {
    info = await fetchVersionInfo(key);
  } catch (err: any) {
    console.log(`Activation failed: ${err.message}`);
    process.exit(1);
  }

  const tier = info.tier;
  const binary = Boolean(flags.binary);
  const platformOverride = flags.platform
    ? (String(flags.platform) as PlatformId)
    : undefined;

  console.log(`Tier: ${tier}`);
  console.log(`Latest version: ${info.latest}`);
  console.log(`Format: ${binary ? "binary" : "tarball"}`);

  // 2. Download and install
  try {
    const result = await downloadAndInstall({
      key,
      tier,
      binary,
      platform: platformOverride,
    });

    console.log("");
    console.log("Activation complete!");
    console.log(`  Tier:     ${tier}`);
    console.log(`  Version:  ${result.version}`);
    console.log(`  Format:   ${binary ? "binary" : "tarball"}`);
    console.log(`  Path:     ${result.installPath}`);
    console.log("");
    if (binary) {
      console.log("Add to your MCP config:");
      console.log(`  claude mcp add strata-${tier} -- "${result.installPath}"`);
    } else {
      console.log("The global strata command has been updated.");
      console.log(`Run 'strata status' to verify the ${tier} installation.`);
    }

    console.log("");
    console.log("Next steps:");
    console.log("  1. Set up semantic search (recommended):");
    console.log("     Get a free Gemini API key at https://aistudio.google.com/apikey");
    console.log("     Then either:");
    console.log("       export GEMINI_API_KEY=<your-key>     (add to shell profile)");
    console.log("       — or set it in the dashboard at http://localhost:3100/settings");
    console.log("");
    console.log("  2. Open the dashboard:");
    console.log("     strata dashboard");
  } catch (err: any) {
    console.log(`Download/install failed: ${err.message}`);
    process.exit(1);
  }
}

async function runActivate(
  key: string,
  flags: Record<string, string | boolean>
): Promise<void> {
  if (isPolarKey(key)) {
    await runActivatePolar(key, flags);
  } else if (key.startsWith("eyJ")) {
    await runActivateJwt(key);
  } else {
    console.log("Unrecognized key format.");
    console.log("  - Polar keys start with STRATA- or contain pol_lic_");
    console.log("  - JWT keys start with eyJ");
    process.exit(1);
  }
}

async function runUpdate(): Promise<void> {
  const { readPolarKey, readInstallConfig, fetchVersionInfo, downloadAndInstall } =
    await import("./cli/download.js");

  // 1. Read saved key
  const key = readPolarKey();
  if (!key) {
    console.log("No Polar license key found.");
    console.log("  Run 'strata activate <key>' first to set up your license.");
    process.exit(1);
  }

  // 2. Read current install config
  const config = readInstallConfig();
  if (!config) {
    console.log("No install config found at ~/.strata/config.json");
    console.log("  Run 'strata activate <key>' to do a fresh install.");
    process.exit(1);
  }

  // 3. Check latest version
  let info;
  try {
    info = await fetchVersionInfo(key);
  } catch (err: any) {
    console.log(`Update check failed: ${err.message}`);
    process.exit(1);
  }

  // 4. Compare versions
  if (info.latest === config.version) {
    console.log(`Already up to date (${config.tier} v${config.version}).`);
    return;
  }

  console.log(`Update available: ${config.version} -> ${info.latest}`);

  // 5. Download same format as original install
  const binary = config.format === "binary";
  try {
    const result = await downloadAndInstall({
      key,
      tier: config.tier,
      binary,
      platform: config.platform,
    });

    console.log("");
    console.log("Update complete!");
    console.log(`  Tier:     ${config.tier}`);
    console.log(`  Version:  ${result.version}`);
    console.log(`  Format:   ${config.format}`);
    console.log(`  Path:     ${result.installPath}`);
  } catch (err: any) {
    console.log(`Update failed: ${err.message}`);
    process.exit(1);
  }
}

async function runLicenseStatus(): Promise<void> {
  const { initLicense, getLicenseInfo, getRawLicenseResult } = await import("./extensions/feature-gate.js");

  initLicense();
  const info = getLicenseInfo();

  if (info) {
    const expDate = new Date(info.expiresAt * 1000).toISOString().slice(0, 10);
    console.log("License: active");
    console.log(`  Tier: ${info.tier}`);
    console.log(`  Email: ${info.email}`);
    console.log(`  Features: ${info.features.join(", ")}`);
    console.log(`  Expires: ${expDate}`);
  } else {
    const raw = getRawLicenseResult();
    if (raw?.error === "License expired") {
      const expDate = raw.expiresAt
        ? new Date(raw.expiresAt * 1000).toISOString().slice(0, 10)
        : "unknown";
      console.log(`License: expired (${expDate})`);
      console.log(`  Tier: ${raw.tier}`);
      console.log(`  Email: ${raw.email}`);
      console.log("  Visit strata.kytheros.dev to renew.");
    } else {
      console.log("License: none");
      console.log("  Visit strata.kytheros.dev/pricing to get a Strata Pro license.");
    }
  }
}

async function runEmbed(): Promise<void> {
  proFeatureMessage("embed");
}

async function runServe(
  flags: Record<string, string | boolean>
): Promise<void> {
  // Task 13: Refuse to start REST transport if legacy FS-tree layout is present.
  // Check early — before any server binds a port — so the error is clean.
  if (flags["rest"]) {
    const { getDataDir: _getDataDir } = await import("./storage/database.js");
    const { hasLegacyLayout } = await import("./storage/legacy-layout.js");
    const _restBaseDir = flags["data-dir"]
      ? String(flags["data-dir"])
      : process.env.STRATA_DATA_DIR || _getDataDir();
    if (hasLegacyLayout(_restBaseDir)) {
      console.error(
        "[strata] Legacy Strata layout detected (pre-refactor JSON files found).\n" +
        "Please migrate your data before starting the server:\n" +
        `  strata world-migrate --data-dir ${_restBaseDir}\n` +
        "Then restart the server."
      );
      process.exit(1);
    }
  }

  const port = flags.port
    ? parseInt(String(flags.port), 10)
    : process.env.PORT
      ? parseInt(process.env.PORT, 10)
      : 3000;

  if (flags["multi-tenant"]) {
    const databaseUrl = process.env.DATABASE_URL;

    if (databaseUrl) {
      // Tier B: Postgres-backed multi-tenant transport.
      // DATABASE_URL routes all users through pg.Pool with row-level scoping.
      const { startPgMultiTenantHttpTransport } = await import(
        "./transports/pg-multi-tenant-http-transport.js"
      );

      const maxDbsFlag = flags["max-dbs"]
        ? parseInt(String(flags["max-dbs"]), 10)
        : undefined;

      const handle = await startPgMultiTenantHttpTransport({
        port,
        connectionString: databaseUrl,
        maxDbs: maxDbsFlag, // emits deprecation warning inside transport if set
      });

      // Graceful shutdown
      const shutdownPg = async () => {
        console.log("\nShutting down pg multi-tenant server...");
        await handle.close();
        process.exit(0);
      };

      process.on("SIGTERM", shutdownPg);
      process.on("SIGINT", shutdownPg);
    } else {
      // Tier A: SQLite multi-tenant transport (default, no DATABASE_URL).
      const { startMultiTenantHttpTransport } = await import(
        "./transports/multi-tenant-http-transport.js"
      );
      const { getDataDir } = await import("./storage/database.js");

      const baseDir = flags["data-dir"]
        ? String(flags["data-dir"])
        : process.env.STRATA_DATA_DIR || getDataDir();
      const maxDbs = flags["max-dbs"]
        ? parseInt(String(flags["max-dbs"]), 10)
        : 200;

      const handle = await startMultiTenantHttpTransport({
        port,
        baseDir,
        maxDbs,
      });

      // Graceful shutdown
      const shutdown = async () => {
        console.log("\nShutting down multi-tenant server...");
        await handle.close();
        process.exit(0);
      };

      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);
    } // end else (SQLite path)
  } else {
    const { startHttpTransport } = await import("./transports/http-transport.js");

    const handle = await startHttpTransport({ port });

    // Graceful shutdown
    const shutdown = async () => {
      console.log("\nShutting down...");
      await handle.close();
      process.exit(0);
    };

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  }

  // REST API server (can run alongside MCP transport or standalone)
  if (flags["rest"]) {
    const { startRestTransport } = await import("./transports/rest-transport.js");
    const { getDataDir } = await import("./storage/database.js");

    const restPort = flags["rest-port"]
      ? parseInt(String(flags["rest-port"]), 10)
      : 3001;
    const restToken = flags["rest-token"]
      ? String(flags["rest-token"])
      : process.env.STRATA_REST_TOKEN || undefined;
    const restBaseDir = flags["data-dir"]
      ? String(flags["data-dir"])
      : process.env.STRATA_DATA_DIR || getDataDir();
    const restMaxAgents = flags["rest-max-agents"]
      ? parseInt(String(flags["rest-max-agents"]), 10)
      : undefined;
    const restMaxWorlds = flags["rest-max-worlds"]
      ? parseInt(String(flags["rest-max-worlds"]), 10)
      : undefined;

    let restHandle;
    try {
      restHandle = await startRestTransport({
        port: restPort,
        token: restToken,
        baseDir: restBaseDir,
        maxAgents: restMaxAgents,
        maxWorlds: restMaxWorlds,
      });
    } catch (err) {
      console.error(
        `[strata] Failed to start REST transport: ${(err as Error).message}`
      );
      process.exit(1);
    }

    // Extend shutdown to close REST server too
    const origShutdown = process.listeners("SIGTERM").pop() as (() => void) | undefined;
    const restShutdown = async () => {
      console.log("\nShutting down REST server...");
      await restHandle.close();
      if (origShutdown) origShutdown();
      else process.exit(0);
    };

    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
    process.on("SIGTERM", restShutdown);
    process.on("SIGINT", restShutdown);
  }
}

async function startServer(): Promise<void> {
  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );
  const { createServer } = await import("./server.js");

  const { server } = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function main(): Promise<void> {
  const { command, args, flags } = parseArgs(process.argv.slice(2));

  if (flags.version) {
    console.log(getVersion());
    return;
  }

  if (flags.help) {
    printHelp();
    return;
  }

  switch (command) {
    case "search": {
      const query = args[0];
      if (!query) {
        console.log("Usage: strata search <query> [--limit N] [--project NAME] [--tool NAME] [--json]");
        process.exit(1);
      }
      await runSearch(query, flags);
      break;
    }
    case "find-procedures":
      proFeatureMessage("find-procedures");
      break;
    case "entities":
      proFeatureMessage("entities");
      break;
    case "store-memory": {
      const memoryText = args[0];
      if (!memoryText) {
        console.log("Usage: strata store-memory <text> --type <type> [--tags <tags>] [--project NAME] [--json]");
        process.exit(1);
      }
      if (!flags.type) {
        console.log("Error: --type is required. Valid types: decision, solution, error_fix, pattern, learning, procedure, fact, preference, episodic");
        process.exit(1);
      }
      await runStoreMemory(memoryText, flags);
      break;
    }
    case "migrate":
      if (args[0] === "pg") {
        // strata migrate pg [--status] [--dry-run]
        const { runPgMigrateCli } = await import("./cli/pg-migrate.js");
        await runPgMigrateCli(process.argv.slice(3));
      } else {
        await runMigrate(flags);
      }
      break;
    case "activate": {
      const key = args[0];
      if (!key) {
        console.log("Usage: strata activate <key> [--binary] [--platform <id>]");
        process.exit(1);
      }
      await runActivate(key, flags);
      break;
    }
    case "update":
      await runUpdate();
      break;
    case "license":
      await runLicenseStatus();
      break;
    case "embed":
      await runEmbed();
      break;
    case "distill": {
      const subcommand = args[0];
      const distillArgs = args.slice(1);
      const {
        runDistillStatus,
        runDistillExport,
        runDistillActivate,
        runDistillDeactivate,
        runDistillSetup,
        runDistillTest,
      } = await import("./cli/distill.js");

      switch (subcommand) {
        case "status":
          await runDistillStatus(flags);
          break;
        case "export-data":
          await runDistillExport(distillArgs, flags);
          break;
        case "activate":
          await runDistillActivate();
          break;
        case "deactivate":
          await runDistillDeactivate();
          break;
        case "setup":
          await runDistillSetup({ skipPull: flags["skip-pull"] === true });
          break;
        case "test":
          await runDistillTest();
          break;
        default:
          console.log(
            "Usage: strata distill <status|export-data|activate|deactivate|setup|test>"
          );
          console.log("");
          console.log("Subcommands:");
          console.log("  status        Show training data statistics and readiness");
          console.log("  export-data   Export training data to JSONL for fine-tuning");
          console.log("  activate      Enable local model distillation mode");
          console.log("  deactivate    Disable local model distillation mode");
          console.log("  setup         One-step Gemma 4 local inference setup");
          console.log("  test          Verify local inference pipeline");
          process.exit(subcommand ? 1 : 0);
      }
      break;
    }
    case "backup": {
      const backupSubcommand = args[0];
      const backupArgs = args.slice(1);
      const { runBackup } = await import("./cli/backup.js");
      await runBackup(backupSubcommand, backupArgs, flags);
      break;
    }
    case "dashboard":
      proFeatureMessage("dashboard");
      break;
    case "init": {
      const initForce = Boolean(flags.force);
      const initGlobal = Boolean(flags.global);

      if (flags.gemini) {
        // Explicit Gemini-only init
        const { runInitGemini } = await import("./cli/init-gemini.js");
        await runInitGemini({ force: initForce, global: initGlobal });
      } else if (flags.claude) {
        // Explicit Claude-only init
        const { runInit } = await import("./cli/init.js");
        await runInit({ force: initForce });
      } else if (flags.all) {
        // Init all supported CLIs regardless of detection
        const { runInit } = await import("./cli/init.js");
        await runInit({ force: initForce });
        console.log("");
        const { runInitGemini } = await import("./cli/init-gemini.js");
        await runInitGemini({ force: initForce, global: initGlobal });
      } else {
        // Auto-detect installed CLIs
        const { execSync: execSyncDetect } = await import("child_process");
        let hasClaude = false;
        let hasGemini = false;

        try {
          execSyncDetect("claude --version", { stdio: "pipe", timeout: 10_000 });
          hasClaude = true;
        } catch { /* not installed */ }

        try {
          execSyncDetect("gemini --version", { stdio: "pipe", timeout: 10_000 });
          hasGemini = true;
        } catch { /* not installed */ }

        if (hasClaude) {
          const { runInit } = await import("./cli/init.js");
          await runInit({ force: initForce });
          if (hasGemini) console.log("");
        }

        if (hasGemini) {
          const { runInitGemini } = await import("./cli/init-gemini.js");
          await runInitGemini({ force: initForce, global: initGlobal });
        }

        if (!hasClaude && !hasGemini) {
          console.log("No supported AI CLI detected.\n");
          console.log("Install one of:");
          console.log("  Claude Code:  npm install -g @anthropic-ai/claude-code");
          console.log("  Gemini CLI:   npm install -g @anthropic-ai/gemini-cli");
          console.log("\nThen run 'strata init' again.");
        }
      }
      break;
    }
    case "hook": {
      const hookName = args[0];
      if (!hookName) {
        console.log("Usage: strata hook <session-start|session-stop|subagent-start|post-tool-failure|user-prompt|teammate-idle|post-tool-use>");
        process.exit(1);
      }
      const hookMap: Record<string, string> = {
        "session-start": "./hooks/session-start-hook.js",
        "session-stop": "./hooks/session-stop-hook.js",
        "subagent-start": "./hooks/subagent-start-hook.js",
        "post-tool-failure": "./hooks/post-tool-failure-hook.js",
        "user-prompt": "./hooks/user-prompt-hook.js",
        "teammate-idle": "./hooks/teammate-idle-hook.js",
        "post-tool-use": "./hooks/post-tool-use-hook.js",
      };
      const hookModule = hookMap[hookName];
      if (!hookModule) {
        console.log(`Unknown hook: ${hookName}`);
        console.log("Available hooks: session-start, session-stop, subagent-start, post-tool-failure, user-prompt, teammate-idle, post-tool-use");
        process.exit(1);
      }
      await import(hookModule);
      break;
    }
    case "deploy": {
      const target = args[0];
      if (target === "cloudflare") {
        const { runDeployCloudflare } = await import("./cli/deploy.js");
        await runDeployCloudflare(flags);
      } else if (target === "gcp") {
        const { deployGcp } = await import("./cli/deploy-gcp.js");
        await deployGcp(args.slice(1), flags);
      } else {
        console.log("Usage: strata deploy <target> [options]");
        console.log("");
        console.log("Supported targets:");
        console.log("  cloudflare    Deploy to Cloudflare Workers + D1");
        console.log("  gcp           Deploy to Google Cloud Platform (Cloud Run)");
        console.log("");
        console.log("Examples:");
        console.log("  strata deploy cloudflare [--account-id ID] [--db-name NAME]");
        console.log("  strata deploy gcp [--multi-tenant] [--project ID] [--region REGION]");
        process.exit(target ? 1 : 0);
      }
      break;
    }
    case "index": {
      if (flags["rebuild-turns"]) {
        const { runRebuildTurns } = await import("./cli/rebuild-turns.js");
        await runRebuildTurns(flags);
      } else if (flags["backfill-junction"]) {
        const { runBackfillJunction } = await import("./cli/backfill-junction.js");
        await runBackfillJunction(flags);
      } else {
        console.log("Usage: strata index <subcommand> [options]");
        console.log("");
        console.log("Subcommands:");
        console.log("  --rebuild-turns       Backfill knowledge_turns from all indexed sessions");
        console.log("  --backfill-junction   Backfill knowledge_entities junction from knowledge entries");
        console.log("");
        console.log("Flags:");
        console.log("  --project=<name>    Restrict to a single project");
        console.log("  --dry-run           Report counts without writing");
        process.exit(1);
      }
      break;
    }
    case "world-migrate": {
      const baseDir = flags["data-dir"]
        ? String(flags["data-dir"])
        : process.env.STRATA_DATA_DIR ||
          join(process.env.HOME || process.env.USERPROFILE || ".", ".strata");
      const { worldMigrate } = await import("./cli/world-migrate.js");
      const result = worldMigrate({ basePath: baseDir });
      if (result.migrated) {
        console.log(`Migration complete: ${result.summary}`);
      } else {
        console.log(result.summary);
      }
      process.exit(result.migrated ? 0 : 1);
      break;
    }
    case "serve":
      await runServe(flags);
      break;
    case "status":
      await runStatus();
      break;
    case "rest-migrate": {
      const { runRestMigrate } = await import("./cli/rest-migrate.js");
      const playerId = flags["player-id"] ? String(flags["player-id"]) : null;
      if (!playerId) {
        console.error("Usage: strata rest-migrate --player-id <uuid-or-name> [--dry-run]");
        process.exit(1);
      }
      const baseDir = flags["data-dir"]
        ? String(flags["data-dir"])
        : join(process.env.HOME || process.env.USERPROFILE || ".", ".strata");
      const dryRun = !!flags["dry-run"];
      try {
        const result = runRestMigrate({ baseDir, playerId, dryRun });
        console.log(
          `${dryRun ? "[dry-run] " : ""}Moved ${result.moved.length} agent director${result.moved.length === 1 ? "y" : "ies"} to ${result.targetDir}`
        );
        for (const name of result.moved) console.log(`  - ${name}`);
        if (result.skipped.length > 0) {
          console.log(`Skipped ${result.skipped.length}:`);
          for (const name of result.skipped) console.log(`  - ${name}`);
        }
        process.exit(0);
      } catch (err) {
        console.error(`rest-migrate failed: ${(err as Error).message}`);
        process.exit(1);
      }
      break;
    }
    default:
      // No command = start MCP server (default behavior)
      await startServer();
      break;
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
