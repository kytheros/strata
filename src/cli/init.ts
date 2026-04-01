/**
 * CLI: Initialize Strata in a project directory.
 *
 * Copies skills to .claude/skills/, registers hooks in settings.json,
 * appends Strata section to CLAUDE.md, and prints verification steps.
 *
 * Usage: npx strata-mcp init [--force]
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface InitOptions {
  force?: boolean;
  cwd?: string;
}

/**
 * Resolve the templates directory.
 * In development: ../../templates (relative to src/cli/)
 * In production: ../../templates (relative to dist/cli/)
 */
function getTemplatesDir(): string {
  // Try production path first (dist/cli/ -> templates/)
  const prodPath = join(__dirname, "..", "..", "templates");
  if (existsSync(prodPath)) return prodPath;

  // Try development path (src/cli/ -> templates/)
  const devPath = join(__dirname, "..", "..", "templates");
  if (existsSync(devPath)) return devPath;

  throw new Error(
    "Could not find templates directory. Make sure strata-mcp is installed correctly."
  );
}

function copySkills(projectDir: string, templatesDir: string, force: boolean): number {
  const skillsSource = join(templatesDir, "skills");
  const skillsDest = join(projectDir, ".claude", "skills");

  if (!existsSync(skillsSource)) {
    console.log("  Warning: skills templates not found, skipping.");
    return 0;
  }

  mkdirSync(skillsDest, { recursive: true });

  const files = readdirSync(skillsSource).filter((f) => f.endsWith(".md"));
  let copied = 0;

  for (const file of files) {
    const dest = join(skillsDest, file);
    if (existsSync(dest) && !force) {
      console.log(`  Skipped ${file} (already exists, use --force to overwrite)`);
      continue;
    }
    copyFileSync(join(skillsSource, file), dest);
    console.log(`  Copied ${file}`);
    copied++;
  }

  return copied;
}

function registerHooks(force: boolean): boolean {
  const settingsFile = join(homedir(), ".claude", "settings.json");
  let settings: Record<string, unknown> = {};

  // Ensure .claude directory exists
  mkdirSync(join(homedir(), ".claude"), { recursive: true });

  if (existsSync(settingsFile)) {
    try {
      settings = JSON.parse(readFileSync(settingsFile, "utf-8"));
    } catch {
      console.log("  Warning: could not parse existing settings.json, creating new one.");
    }
  }

  const hooks = (settings.hooks || {}) as Record<string, unknown[]>;
  let modified = false;

  const hookDefs: Array<{ event: string; hookFile: string; matcher?: string }> = [
    { event: "SessionStart", hookFile: "session-start-hook.js" },
    { event: "Stop", hookFile: "session-stop-hook.js" },
    { event: "SubagentStart", hookFile: "subagent-start-hook.js" },
    { event: "PostToolUseFailure", hookFile: "post-tool-failure-hook.js", matcher: "Bash|Write|Edit" },
    { event: "UserPromptSubmit", hookFile: "user-prompt-hook.js" },
    { event: "TeammateIdle", hookFile: "teammate-idle-hook.js" },
    { event: "PostToolUse", hookFile: "post-tool-use-hook.js", matcher: "Edit|Write" },
  ];

  for (const { event, hookFile, matcher } of hookDefs) {
    const eventHooks = (hooks[event] || []) as Array<{
      hooks?: Array<{ type?: string; command?: string }>;
    }>;

    const alreadyInstalled = eventHooks.some((entry) =>
      entry.hooks?.some((h) => h.command?.includes(hookFile))
    );

    if (alreadyInstalled && !force) {
      console.log(`  ${event} hook already registered.`);
      continue;
    }

    // Remove existing strata hook if force-replacing
    if (alreadyInstalled && force) {
      const filtered = eventHooks.filter(
        (entry) => !entry.hooks?.some((h) => h.command?.includes(hookFile))
      );
      hooks[event] = filtered;
    }

    // Find the installed strata-mcp path for hook commands
    const hookCommand = `node "${resolveHookPath(hookFile)}"`;

    const hookEntry: Record<string, unknown> = {
      hooks: [{ type: "command", command: hookCommand }],
    };
    if (matcher) {
      hookEntry.matcher = matcher;
    }

    const existingHooks = (hooks[event] || []) as Array<unknown>;
    existingHooks.push(hookEntry);
    hooks[event] = existingHooks;
    modified = true;
    console.log(`  Registered ${event} hook.`);
  }

  if (modified) {
    settings.hooks = hooks;
    writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  }

  return modified;
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

function appendClaudeMd(projectDir: string, templatesDir: string, force: boolean): boolean {
  const claudeMdPath = join(projectDir, "CLAUDE.md");
  const templatePath = join(templatesDir, "CLAUDE.md.template");

  if (!existsSync(templatePath)) {
    console.log("  Warning: CLAUDE.md template not found, skipping.");
    return false;
  }

  const template = readFileSync(templatePath, "utf-8");
  const projectName = extractProjectName(projectDir);

  // Extract just the Strata Memory section (for appending to existing CLAUDE.md)
  const memorySection = template
    .split("\n")
    .filter((line) => {
      return !line.startsWith("# {{") && !line.startsWith("{{PROJECT");
    })
    .join("\n")
    .trim();

  if (existsSync(claudeMdPath)) {
    const existing = readFileSync(claudeMdPath, "utf-8");
    if (existing.includes("## Strata Memory") && !force) {
      console.log("  CLAUDE.md already has Strata Memory section (use --force to overwrite).");
      return false;
    }
    if (existing.includes("## Strata Memory") && force) {
      // Replace existing section
      const replaced = existing.replace(
        /## Strata Memory[\s\S]*?(?=\n## |\n# |$)/,
        memorySection
      );
      writeFileSync(claudeMdPath, replaced);
      console.log("  Updated Strata Memory section in CLAUDE.md.");
    } else {
      // Append
      writeFileSync(claudeMdPath, existing.trimEnd() + "\n\n" + memorySection + "\n");
      console.log("  Appended Strata Memory section to CLAUDE.md.");
    }
  } else {
    // Create new CLAUDE.md with full template
    const fullContent = template
      .replace("{{PROJECT_NAME}}", projectName)
      .replace("{{PROJECT_DESCRIPTION}}", "{Your project description here.}");
    writeFileSync(claudeMdPath, fullContent);
    console.log("  Created CLAUDE.md with Strata Memory section.");
  }

  return true;
}

function extractProjectName(projectDir: string): string {
  // Try package.json name
  const pkgPath = join(projectDir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.name) return pkg.name;
    } catch { /* ignore */ }
  }

  // Fall back to directory name
  const parts = projectDir.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || "my-project";
}

function ensureDataDir(): void {
  const strataDir = join(homedir(), ".strata");
  mkdirSync(strataDir, { recursive: true });
}

export async function runInit(options: InitOptions = {}): Promise<void> {
  const cwd = options.cwd || process.cwd();
  const force = options.force || false;

  console.log("Strata — Project Setup\n");

  const templatesDir = getTemplatesDir();

  // Step 1: Copy skills
  console.log("1. Installing skills...");
  const skillsCopied = copySkills(cwd, templatesDir, force);
  if (skillsCopied > 0) {
    console.log(`   ${skillsCopied} skill(s) installed to .claude/skills/`);
  }

  // Step 2: Register hooks
  console.log("\n2. Registering hooks...");
  registerHooks(force);

  // Step 3: Update CLAUDE.md
  console.log("\n3. Updating CLAUDE.md...");
  appendClaudeMd(cwd, templatesDir, force);

  // Step 4: Ensure data directory
  console.log("\n4. Ensuring data directory...");
  ensureDataDir();
  console.log("  ~/.strata/ ready.");

  // Verification
  console.log("\n--- Setup Complete ---\n");
  console.log("Verify your setup:");
  console.log("  1. Start a new Claude Code session in this project");
  console.log("  2. You should see '[Strata] Previous context for...' on startup");
  console.log("  3. Try /recall, /remember, /gaps, or /strata-status");
  console.log("");
  console.log("If the MCP server isn't configured yet:");
  console.log(`  claude mcp add strata -- npx strata-mcp`);
}
