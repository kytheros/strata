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
  strata activate <key>                   Activate a Strata Pro license
  strata license                          Show current license status
  strata embed                            Generate embeddings for vector search
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

async function runActivate(key: string): Promise<void> {
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
        console.log("Usage: strata-mcp activate <license-key>");
        process.exit(1);
      }
      await runActivate(key);
      break;
    }
    case "license":
      await runLicenseStatus();
      break;
    case "embed":
      await runEmbed();
      break;
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
