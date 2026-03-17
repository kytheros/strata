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
  strata search <query>                   Search conversation history
  strata find-procedures <query>          Search for procedures (Pro)
  strata entities [query]                 Search entity graph (Pro)
  strata store-memory <text> --type <t>   Store an explicit memory
  strata migrate                          Migrate legacy data to SQLite
  strata status                           Print index statistics
  strata activate <key>                   Activate a license (JWT or Polar key)
  strata update                           Check for and install newer versions
  strata license                          Show current license status
  strata embed                            Generate embeddings for vector search
  strata init                             Set up Strata in the current project
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

Activate flags:
  --binary          Download standalone binary instead of tarball
  --platform <id>   Override platform detection (linux-x64, darwin-arm64,
                    darwin-x64, win-x64)

Init flags:
  --force           Overwrite existing skills, hooks, and CLAUDE.md sections

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
    } else if (arg === "--type" && i + 1 < argv.length) {
      flags.type = argv[++i];
    } else if (arg === "--tags" && i + 1 < argv.length) {
      flags.tags = argv[++i];
    } else if (arg === "--binary") {
      flags.binary = true;
    } else if (arg === "--platform" && i + 1 < argv.length) {
      flags.platform = argv[++i];
    } else if (arg === "--no-color") {
      flags["no-color"] = true;
    } else if (!arg.startsWith("-") && !command) {
      command = arg;
    } else if (!arg.startsWith("-")) {
      args.push(arg);
    }
    i++;
  }

  return { command, args, flags };
}

async function runSearch(
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

  const start = performance.now();
  const results = searchEngine.search(searchQuery, {
    limit: flags.limit ? parseInt(String(flags.limit), 10) : 20,
    project: flags.project ? String(flags.project) : undefined,
  });
  const elapsed = ((performance.now() - start) / 1000).toFixed(2);

  if (results.length === 0) {
    console.log("No results found.");
    indexManager.close();
    process.exit(1);
  }

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

async function runStoreMemory(
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
  const { createServer } = await import("./server.js");
  const { startHttpTransport } = await import("./transports/http-transport.js");

  const port = flags.port
    ? parseInt(String(flags.port), 10)
    : process.env.PORT
      ? parseInt(process.env.PORT, 10)
      : 3000;

  const { server } = createServer();
  const handle = await startHttpTransport(server, { port });

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\nShutting down...");
    await handle.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
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
      await runMigrate(flags);
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
    case "dashboard":
      proFeatureMessage("dashboard");
      break;
    case "init": {
      const { runInit } = await import("./cli/init.js");
      await runInit({ force: Boolean(flags.force) });
      break;
    }
    case "hook": {
      const hookName = args[0];
      if (!hookName) {
        console.log("Usage: strata hook <session-start|session-stop|subagent-start>");
        process.exit(1);
      }
      const hookMap: Record<string, string> = {
        "session-start": "./hooks/session-start-hook.js",
        "session-stop": "./hooks/session-stop-hook.js",
        "subagent-start": "./hooks/subagent-start-hook.js",
      };
      const hookModule = hookMap[hookName];
      if (!hookModule) {
        console.log(`Unknown hook: ${hookName}`);
        console.log("Available hooks: session-start, session-stop, subagent-start");
        process.exit(1);
      }
      await import(hookModule);
      break;
    }
    case "serve":
      await runServe(flags);
      break;
    case "status":
      await runStatus();
      break;
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
