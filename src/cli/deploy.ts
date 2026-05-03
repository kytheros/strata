/**
 * `strata deploy cloudflare` — scaffolds, creates D1, deploys Worker.
 *
 * Uses Node.js readline for interactive prompts (no external dependencies).
 * Shells out to `wrangler` for Cloudflare operations.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { execSync } from "child_process";
import { createInterface } from "readline";
import { randomBytes } from "crypto";

// ─── Helpers (exported for testing) ───

/** Find the templates/cloudflare-d1 directory relative to this module. */
export function resolveTemplateDir(): string {
  // When running from source: strata/templates/cloudflare-d1/
  // When running from dist: strata/templates/cloudflare-d1/ (same relative to package root)
  let dir = dirname(new URL(import.meta.url).pathname);
  // On Windows, URL pathname starts with /C:/... — strip leading slash
  if (process.platform === "win32" && dir.startsWith("/")) {
    dir = dir.slice(1);
  }
  // Walk up from src/cli/ or dist/cli/ to package root
  const pkgRoot = join(dir, "..", "..");
  const templateDir = join(pkgRoot, "templates", "cloudflare-d1");
  if (!existsSync(templateDir)) {
    throw new Error(`Template directory not found: ${templateDir}`);
  }
  return templateDir;
}

/** Replace {{PLACEHOLDER}} tokens in a template string. */
export function patchTemplate(
  template: string,
  vars: Record<string, string>
): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

/** Generate a cryptographically random 64-char hex token. */
export function generateGatewayToken(): string {
  return randomBytes(32).toString("hex");
}

/** Detect installed tier from ~/.strata/config.json. */
export function detectTier(configPath?: string): "community" | "pro" {
  const p = configPath ?? join(homedir(), ".strata", "config.json");
  if (!existsSync(p)) return "community";
  try {
    const config = JSON.parse(readFileSync(p, "utf-8"));
    if (config.tier === "pro") return "pro";
  } catch { /* malformed */ }
  return "community";
}

/** Read Polar license key from ~/.strata/polar.key. */
function readPolarKey(): string | null {
  const p = join(homedir(), ".strata", "polar.key");
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf-8").trim() || null;
}

/** Prompt user for input with a default value. */
function prompt(
  rl: ReturnType<typeof createInterface>,
  question: string,
  defaultValue?: string
): Promise<string> {
  const suffix = defaultValue ? ` (${defaultValue})` : "";
  return new Promise((resolve) => {
    rl.question(`  ${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

/** Check that wrangler is installed and authenticated. */
function checkWrangler(): void {
  try {
    execSync("npx wrangler --version", { stdio: "pipe", timeout: 15_000 });
  } catch {
    console.log("\n  Error: Wrangler not found.");
    console.log("  Install it: npm install -g wrangler");
    console.log("  Then authenticate: wrangler login\n");
    process.exit(1);
  }
}

// ─── Main deploy flow ───

export async function runDeployCloudflare(
  flags: Record<string, string | boolean>
): Promise<void> {
  console.log("\n  Strata \u2192 Cloudflare Workers + D1 Deployment");
  console.log("  " + "\u2500".repeat(45) + "\n");

  // Check prerequisites
  checkWrangler();

  // Detect tier
  const tier = detectTier();
  const polarKey = readPolarKey();
  const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1);
  console.log(`  Detected tier: ${tierLabel}${polarKey ? ` (key: ...${polarKey.slice(-4)})` : ""}\n`);

  // Interactive prompts (or flags for non-interactive use)
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const accountId = (flags["account-id"] as string) || await prompt(rl, "Cloudflare account ID");
  if (!accountId) {
    console.log("\n  Error: Account ID is required.");
    rl.close();
    process.exit(1);
  }

  const dbName = (flags["db-name"] as string) || await prompt(rl, "D1 database name", "strata-db");
  const workerName = (flags["worker-name"] as string) || await prompt(rl, "Worker name", "strata-mcp");
  const gatewayToken = (flags["token"] as string) || await prompt(rl, "Gateway token", generateGatewayToken());

  // Gemini key: check config first, then prompt
  let geminiKey = flags["gemini-key"] as string || "";
  if (!geminiKey) {
    try {
      const configPath = join(homedir(), ".strata", "config.json");
      if (existsSync(configPath)) {
        const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
        if (cfg.geminiApiKey) geminiKey = cfg.geminiApiKey;
      }
    } catch { /* */ }
    if (!geminiKey) {
      geminiKey = await prompt(rl, "Gemini API key (optional, Enter to skip)");
    }
  }

  rl.close();

  const outDir = (flags["out-dir"] as string) || "./strata-cloudflare";
  const templateDir = resolveTemplateDir();

  // Resolve migrations dir relative to this module
  let migrationsBase = dirname(new URL(import.meta.url).pathname);
  if (process.platform === "win32" && migrationsBase.startsWith("/")) {
    migrationsBase = migrationsBase.slice(1);
  }
  const migrationsDir = join(migrationsBase, "..", "..", "src", "storage", "d1", "migrations");

  // ─── Scaffold ───
  console.log("\n  Scaffolding project...");
  mkdirSync(join(outDir, "src"), { recursive: true });
  mkdirSync(join(outDir, "migrations"), { recursive: true });

  // Tier-specific deps and secrets
  let tierDeps = "";
  let tierSecretsComment = "";
  if (tier === "pro") {
    tierDeps = ',\n    "@kytheros/strata-pro": "latest"';
    tierSecretsComment = "# POLAR_LICENSE_KEY  -- Pro license key";
  }

  // Patch and write templates
  const pkgTmpl = readFileSync(join(templateDir, "package.json.tmpl"), "utf-8");
  writeFileSync(
    join(outDir, "package.json"),
    patchTemplate(pkgTmpl, { WORKER_NAME: workerName, DB_NAME: dbName, TIER_DEPS: tierDeps })
  );

  // wrangler.toml gets DB_ID filled in after D1 creation
  const wranglerTmpl = readFileSync(join(templateDir, "wrangler.toml.tmpl"), "utf-8");
  // Save template for patching after D1 creation
  const wranglerContent = patchTemplate(wranglerTmpl, {
    WORKER_NAME: workerName,
    DB_NAME: dbName,
    DB_ID: "PENDING",
    TIER_SECRETS_COMMENT: tierSecretsComment,
  });

  // Copy static files
  copyFileSync(join(templateDir, "tsconfig.json"), join(outDir, "tsconfig.json"));

  // Copy tier-specific entry point
  const entryPointSrc = join(templateDir, "src", `index.${tier}.ts`);
  copyFileSync(entryPointSrc, join(outDir, "src", "index.ts"));

  // Copy migrations from source of truth
  if (existsSync(migrationsDir)) {
    for (const file of readdirSync(migrationsDir).filter(f => f.endsWith(".sql"))) {
      copyFileSync(join(migrationsDir, file), join(outDir, "migrations", file));
    }
  }

  console.log(`  \u2713 Created ${outDir}/`);
  console.log("  \u2713 package.json");
  console.log("  \u2713 wrangler.toml");
  console.log(`  \u2713 src/index.ts (${tierLabel})`);
  console.log("  \u2713 migrations/");

  // ─── Install dependencies ───
  console.log("\n  Installing dependencies...");
  try {
    execSync("npm install", { cwd: outDir, stdio: "pipe", timeout: 120_000 });
    console.log("  \u2713 npm install complete");
  } catch (err) {
    console.log("  \u2717 npm install failed. Run manually: cd " + outDir + " && npm install");
    console.log("    " + (err instanceof Error ? err.message : String(err)));
  }

  // ─── Create D1 database ───
  console.log("\n  Creating D1 database...");
  let dbId = "";
  try {
    const output = execSync(
      `npx wrangler d1 create ${dbName} --account-id ${accountId}`,
      { cwd: outDir, encoding: "utf-8", timeout: 30_000 }
    );
    // Parse database_id from output
    const idMatch = output.match(/database_id\s*=\s*"([^"]+)"/);
    if (idMatch) {
      dbId = idMatch[1];
      console.log(`  \u2713 ${dbName} created (database_id: ${dbId})`);
    } else {
      console.log("  \u2713 D1 database created (could not parse ID from output)");
      console.log("    Output: " + output.trim());
    }
  } catch (err) {
    // Database might already exist
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes("already exists")) {
      console.log(`  \u2713 ${dbName} already exists`);
      // Try to get the ID
      try {
        const listOut = execSync(
          `npx wrangler d1 list --account-id ${accountId} --json`,
          { encoding: "utf-8", timeout: 15_000 }
        );
        const dbs = JSON.parse(listOut);
        const existing = dbs.find((d: { name: string }) => d.name === dbName);
        if (existing) dbId = existing.uuid || existing.database_id || "";
      } catch { /* */ }
    } else {
      console.log("  \u2717 D1 creation failed: " + errMsg);
    }
  }

  // Patch wrangler.toml with actual DB_ID
  writeFileSync(
    join(outDir, "wrangler.toml"),
    wranglerContent.replace("PENDING", dbId || "YOUR_DATABASE_ID")
  );

  // ─── Apply migrations ───
  if (dbId) {
    console.log("\n  Applying schema...");
    try {
      execSync(
        `npx wrangler d1 migrations apply ${dbName} --remote --account-id ${accountId}`,
        { cwd: outDir, stdio: "pipe", timeout: 30_000 }
      );
      console.log("  \u2713 Migrations applied");
    } catch (err) {
      console.log("  \u2717 Migration failed. Run manually: cd " + outDir + " && npm run migrate");
      console.log("    " + (err instanceof Error ? err.message : String(err)));
    }
  }

  // ─── Set secrets ───
  console.log("\n  Setting secrets...");
  const secrets: [string, string][] = [["MCP_GATEWAY_TOKEN", gatewayToken]];
  if (geminiKey) secrets.push(["GEMINI_API_KEY", geminiKey]);
  if (tier !== "community" && polarKey) secrets.push(["POLAR_LICENSE_KEY", polarKey]);

  for (const [name, value] of secrets) {
    try {
      execSync(
        `echo "${value}" | npx wrangler secret put ${name} --account-id ${accountId}`,
        { cwd: outDir, stdio: "pipe", timeout: 15_000 }
      );
      console.log(`  \u2713 ${name}`);
    } catch {
      console.log(`  \u2717 ${name} \u2014 set manually: cd ${outDir} && npx wrangler secret put ${name}`);
    }
  }

  // ─── Deploy ───
  console.log("\n  Deploying worker...");
  let workerUrl = "";
  try {
    const output = execSync(
      `npx wrangler deploy --account-id ${accountId}`,
      { cwd: outDir, encoding: "utf-8", timeout: 60_000 }
    );
    const urlMatch = output.match(/https:\/\/[^\s]+\.workers\.dev/);
    if (urlMatch) workerUrl = urlMatch[0];
    console.log(`  \u2713 Deployed to ${workerUrl || "(check wrangler output)"}`);
  } catch (err) {
    console.log("  \u2717 Deploy failed. Run manually: cd " + outDir + " && npx wrangler deploy");
    console.log("    " + (err instanceof Error ? err.message : String(err)));
  }

  // ─── Summary ───
  const endpoint = workerUrl
    ? `${workerUrl}/strata/{userId}/mcp`
    : `https://${workerName}.<subdomain>.workers.dev/strata/{userId}/mcp`;

  console.log("\n  " + "\u2550".repeat(50));
  console.log(`\n  Your Strata MCP endpoint:`);
  console.log(`  ${endpoint}\n`);
  console.log("  Add to Claude Code (~/.claude.json):");
  console.log("  {");
  console.log('    "mcpServers": {');
  console.log('      "strata": {');
  console.log('        "type": "url",');
  console.log(`        "url": "${endpoint}",`);
  console.log('        "headers": {');
  console.log(`          "Authorization": "Bearer ${gatewayToken}"`);
  console.log("        }");
  console.log("      }");
  console.log("    }");
  console.log("  }\n");
}
