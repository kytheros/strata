/**
 * CLI: Initialize Strata for Gemini CLI in a project directory.
 *
 * Configures MCP server in ~/.gemini/settings.json, registers SessionStart
 * hooks, copies skills to .agents/skills/, copies TOML commands to
 * .gemini/commands/, creates/updates GEMINI.md, and prints verification steps.
 *
 * Usage: npx strata-mcp init --gemini [--force] [--global]
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
} from "fs";
import { join, resolve, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import { execSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface InitGeminiOptions {
  force?: boolean;
  global?: boolean;
  cwd?: string;
}

/**
 * Resolve the templates directory.
 * In both development (src/cli/) and production (dist/cli/),
 * templates/ is two levels up from the current file.
 */
function getTemplatesDir(): string {
  const templatesPath = join(__dirname, "..", "..", "templates");
  if (existsSync(templatesPath)) return templatesPath;

  throw new Error(
    "Could not find templates directory. Make sure strata-mcp is installed correctly."
  );
}

/**
 * Resolve the absolute path to a hook JS file in the dist/ directory.
 */
function resolveHookPath(hookFile: string): string {
  // In production: __dirname is dist/cli/, hooks are in dist/hooks/
  const distPath = join(__dirname, "..", "hooks", hookFile);
  if (existsSync(distPath)) return resolve(distPath);

  // Fallback: use npx-style invocation
  return `npx strata-mcp hook ${hookFile.replace(".js", "").replace("-hook", "")}`;
}

/**
 * Extract a human-readable project name from the directory.
 */
function extractProjectName(projectDir: string): string {
  const pkgPath = join(projectDir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.name) return pkg.name;
    } catch {
      /* ignore */
    }
  }

  const parts = projectDir.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || "my-project";
}

/**
 * Safely read and parse a JSON file. Returns an empty object on any failure.
 */
function readJsonFile(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    console.log(
      `  Warning: could not parse ${basename(filePath)}, creating fresh.`
    );
    return {};
  }
}

/**
 * Step 1: Check prerequisites — verify Gemini CLI is installed and ~/.gemini/ exists.
 * Returns the detected version string, or null if not installed.
 */
function checkPrerequisites(): string | null {
  try {
    const output = execSync("gemini --version", {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return output.trim();
  } catch {
    console.log("  Gemini CLI is not installed or not in PATH.");
    console.log("");
    console.log("  Install Gemini CLI:");
    console.log("    npm install -g @anthropic-ai/gemini-cli");
    console.log("  Or visit: https://github.com/google-gemini/gemini-cli");
    return null;
  }
}

/**
 * Step 2: Write MCP server configuration to ~/.gemini/settings.json.
 */
function writeMcpConfig(force: boolean): boolean {
  const geminiDir = join(homedir(), ".gemini");
  mkdirSync(geminiDir, { recursive: true });

  const settingsFile = join(geminiDir, "settings.json");
  const settings = readJsonFile(settingsFile);

  const mcpServers = (settings.mcpServers || {}) as Record<string, unknown>;

  if (mcpServers["strata-mcp"] && !force) {
    console.log(
      "  strata-mcp already configured in ~/.gemini/settings.json (use --force to overwrite)."
    );
    return false;
  }

  const mcpEntry: Record<string, unknown> = {
    command: "npx",
    args: ["strata-mcp"],
  };

  // Include environment variables if set
  const env: Record<string, string> = {};
  if (process.env.STRATA_LICENSE_KEY) {
    env.STRATA_LICENSE_KEY = process.env.STRATA_LICENSE_KEY;
  }
  if (process.env.GEMINI_API_KEY) {
    env.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  }
  if (Object.keys(env).length > 0) {
    mcpEntry.env = env;
  }

  mcpServers["strata-mcp"] = mcpEntry;
  settings.mcpServers = mcpServers;
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  console.log("  Added strata-mcp to ~/.gemini/settings.json");
  return true;
}

/**
 * Step 3: Register SessionStart hooks in ~/.gemini/settings.json.
 */
function registerHooks(force: boolean): boolean {
  const settingsFile = join(homedir(), ".gemini", "settings.json");
  const settings = readJsonFile(settingsFile);

  const hooks = (settings.hooks || {}) as Record<string, unknown[]>;
  const sessionStartHooks = (hooks.SessionStart || []) as Array<{
    matcher?: string;
    hooks?: Array<{ name?: string; type?: string; command?: string }>;
  }>;

  const hookPath = resolveHookPath("session-start-hook.js");
  // Use JSON.stringify for Windows-safe quoting in the command string
  const hookCommand = `node ${JSON.stringify(hookPath)}`;

  const matchers = ["startup", "resume"];
  let modified = false;

  for (const matcher of matchers) {
    const alreadyInstalled = sessionStartHooks.some(
      (entry) =>
        entry.matcher === matcher &&
        entry.hooks?.some(
          (h) =>
            h.command?.includes("session-start-hook") ||
            h.name?.startsWith("strata-session")
        )
    );

    if (alreadyInstalled && !force) {
      console.log(`  SessionStart (${matcher}) hook already registered.`);
      continue;
    }

    // Remove existing strata hook entries for this matcher if force-replacing
    if (alreadyInstalled && force) {
      const idx = sessionStartHooks.findIndex(
        (entry) =>
          entry.matcher === matcher &&
          entry.hooks?.some(
            (h) =>
              h.command?.includes("session-start-hook") ||
              h.name?.startsWith("strata-session")
          )
      );
      if (idx >= 0) {
        sessionStartHooks.splice(idx, 1);
      }
    }

    const hookName =
      matcher === "startup"
        ? "strata-session-start"
        : "strata-session-resume";

    sessionStartHooks.push({
      matcher,
      hooks: [
        {
          name: hookName,
          type: "command",
          command: hookCommand,
          timeout: 5000,
        } as { name: string; type: string; command: string },
      ],
    });
    modified = true;
    console.log(`  Registered SessionStart (${matcher}) hook.`);
  }

  if (modified) {
    hooks.SessionStart = sessionStartHooks;
    settings.hooks = hooks;
    writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  }

  return modified;
}

/**
 * Step 4: Install skills to .agents/skills/ (project or global).
 */
function installSkills(
  targetDir: string,
  templatesDir: string,
  force: boolean
): number {
  const skillsSource = join(templatesDir, "gemini-skills");
  const skillsDest = join(targetDir, ".agents", "skills");

  if (!existsSync(skillsSource)) {
    console.log("  Warning: gemini-skills templates not found, skipping.");
    return 0;
  }

  mkdirSync(skillsDest, { recursive: true });

  const skillDirs = readdirSync(skillsSource, { withFileTypes: true }).filter(
    (d) => d.isDirectory()
  );
  let copied = 0;

  for (const dir of skillDirs) {
    const srcSkillDir = join(skillsSource, dir.name);
    const destSkillDir = join(skillsDest, dir.name);
    const srcFile = join(srcSkillDir, "SKILL.md");
    const destFile = join(destSkillDir, "SKILL.md");

    if (!existsSync(srcFile)) continue;

    if (existsSync(destFile) && !force) {
      console.log(
        `  Skipped ${dir.name}/ (already exists, use --force to overwrite)`
      );
      continue;
    }

    mkdirSync(destSkillDir, { recursive: true });
    const content = readFileSync(srcFile, "utf-8");
    writeFileSync(destFile, content);
    console.log(`  Copied ${dir.name}/ to .agents/skills/${dir.name}/`);
    copied++;
  }

  return copied;
}

/**
 * Step 5: Install TOML commands to .gemini/commands/ (project or global).
 *
 * If a command file already exists and force is false, check for namespace
 * conflict and use the strata/ subdirectory instead.
 */
function installCommands(
  targetDir: string,
  templatesDir: string,
  force: boolean
): number {
  const commandsSource = join(templatesDir, "gemini-commands");
  const commandsDest = join(targetDir, ".gemini", "commands");

  if (!existsSync(commandsSource)) {
    console.log("  Warning: gemini-commands templates not found, skipping.");
    return 0;
  }

  mkdirSync(commandsDest, { recursive: true });

  const files = readdirSync(commandsSource).filter((f) => f.endsWith(".toml"));
  let copied = 0;

  for (const file of files) {
    const srcFile = join(commandsSource, file);
    let destFile = join(commandsDest, file);
    let displayPath = `.gemini/commands/${file}`;

    if (existsSync(destFile) && !force) {
      // Check if the existing file is ours (contains strata-related content)
      const existing = readFileSync(destFile, "utf-8");
      if (
        existing.includes("store_memory") ||
        existing.includes("search_history") ||
        existing.includes("find_solutions") ||
        existing.includes("Strata")
      ) {
        // It is ours, skip
        console.log(
          `  Skipped ${file} (already exists, use --force to overwrite)`
        );
        continue;
      }

      // Conflict with non-Strata command — use strata/ namespace
      const namespacedDir = join(commandsDest, "strata");
      mkdirSync(namespacedDir, { recursive: true });
      destFile = join(namespacedDir, file);
      displayPath = `.gemini/commands/strata/${file}`;

      if (existsSync(destFile) && !force) {
        console.log(
          `  Skipped strata/${file} (already exists, use --force to overwrite)`
        );
        continue;
      }
    }

    const content = readFileSync(srcFile, "utf-8");
    writeFileSync(destFile, content);
    console.log(`  Copied ${file} to ${displayPath}`);
    copied++;
  }

  return copied;
}

/**
 * Step 6: Create or update GEMINI.md in the project directory.
 */
function updateGeminiMd(
  projectDir: string,
  templatesDir: string,
  force: boolean
): boolean {
  const geminiMdPath = join(projectDir, "GEMINI.md");
  const templatePath = join(templatesDir, "GEMINI.md.template");
  const toolsTemplatePath = join(
    templatesDir,
    "GEMINI-strata-tools.md.template"
  );

  if (!existsSync(templatePath)) {
    console.log("  Warning: GEMINI.md template not found, skipping.");
    return false;
  }

  const template = readFileSync(templatePath, "utf-8");
  const projectName = extractProjectName(projectDir);

  // Extract the Strata Memory section for appending to existing GEMINI.md
  const memorySection = template
    .split("\n")
    .filter((line) => {
      return !line.startsWith("# {{") && !line.startsWith("{{PROJECT");
    })
    .join("\n")
    .trim();

  if (existsSync(geminiMdPath)) {
    const existing = readFileSync(geminiMdPath, "utf-8");
    if (existing.includes("## Strata Memory") && !force) {
      console.log(
        "  GEMINI.md already has Strata Memory section (use --force to overwrite)."
      );
      return false;
    }
    if (existing.includes("## Strata Memory") && force) {
      // Replace existing section
      const replaced = existing.replace(
        /## Strata Memory[\s\S]*?(?=\n## |\n# |$)/,
        memorySection
      );
      writeFileSync(geminiMdPath, replaced);
      console.log("  Updated Strata Memory section in GEMINI.md.");
    } else {
      // Append
      writeFileSync(
        geminiMdPath,
        existing.trimEnd() + "\n\n" + memorySection + "\n"
      );
      console.log("  Appended Strata Memory section to GEMINI.md.");
    }
  } else {
    // Create new GEMINI.md with full template
    const fullContent = template
      .replace("{{PROJECT_NAME}}", projectName)
      .replace("{{PROJECT_DESCRIPTION}}", "");
    writeFileSync(geminiMdPath, fullContent);
    console.log("  Created GEMINI.md with Strata Memory section.");
  }

  // Also create/update GEMINI-strata-tools.md
  if (existsSync(toolsTemplatePath)) {
    const toolsDest = join(projectDir, "GEMINI-strata-tools.md");
    if (!existsSync(toolsDest) || force) {
      const toolsContent = readFileSync(toolsTemplatePath, "utf-8");
      writeFileSync(toolsDest, toolsContent);
      if (!existsSync(toolsDest)) {
        console.log("  Created GEMINI-strata-tools.md.");
      }
    }
  }

  return true;
}

/**
 * Step 7: Ensure ~/.strata/ data directory exists.
 */
function ensureDataDir(): void {
  const strataDir = join(homedir(), ".strata");
  mkdirSync(strataDir, { recursive: true });
}

/**
 * Main entry point: run the full Gemini CLI init sequence.
 */
export async function runInitGemini(
  options: InitGeminiOptions = {}
): Promise<void> {
  const cwd = options.cwd || process.cwd();
  const force = options.force || false;
  const global = options.global || false;

  // Target directory for skills and commands: project dir or home dir
  const targetDir = global ? homedir() : cwd;

  console.log("Strata — Gemini CLI Setup\n");

  const templatesDir = getTemplatesDir();

  // Step 1: Check prerequisites
  console.log("1. Checking Gemini CLI installation...");
  const geminiVersion = checkPrerequisites();
  if (!geminiVersion) {
    return;
  }
  console.log(`   ${geminiVersion} detected.`);

  // Verify ~/.gemini/ exists
  const geminiDir = join(homedir(), ".gemini");
  if (!existsSync(geminiDir)) {
    console.log(
      "\n  ~/.gemini/ directory not found. Run 'gemini' once to create it, then retry."
    );
    return;
  }

  // Step 2: Write MCP config
  console.log("\n2. Configuring MCP server...");
  writeMcpConfig(force);

  // Step 3: Register hooks
  console.log("\n3. Registering hooks...");
  registerHooks(force);

  // Step 4: Install skills
  console.log("\n4. Installing skills...");
  const skillsCopied = installSkills(targetDir, templatesDir, force);
  if (skillsCopied > 0) {
    console.log(`   ${skillsCopied} skill(s) installed.`);
  }

  // Step 5: Install commands
  console.log("\n5. Installing commands...");
  const commandsCopied = installCommands(targetDir, templatesDir, force);
  if (commandsCopied > 0) {
    console.log(`   ${commandsCopied} command(s) installed.`);
  }

  // Step 6: Create/update GEMINI.md
  console.log("\n6. Updating GEMINI.md...");
  updateGeminiMd(cwd, templatesDir, force);

  // Step 7: Ensure data directory
  console.log("\n7. Ensuring data directory...");
  ensureDataDir();
  console.log("  ~/.strata/ ready.");

  // Step 8: Print verification
  console.log("\n--- Setup Complete ---\n");
  console.log("Verify your setup:");
  console.log("  1. Start a new Gemini CLI session in this project");
  console.log(
    "  2. You should see '[Strata] Previous context for...' on startup"
  );
  console.log("  3. Try /recall, /remember, /gaps, or /strata-status");
  console.log("");
  console.log("If MCP tools are not available:");
  console.log("  Run: gemini mcp list");
  console.log("  Should show: strata-mcp (running)");
}
