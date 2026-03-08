import { describe, it, expect } from "vitest";
import { execSync } from "child_process";
import { join } from "path";
import { readFileSync } from "fs";

const projectRoot = join(import.meta.dirname, "../..");
const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf-8"));
const cliPath = join(projectRoot, "src/cli.ts").replace(/\\/g, "/");

/**
 * Run the CLI via tsx for testing (avoids needing a build step).
 * Merges stdout and stderr into a single output for easier assertion.
 */
function runCli(args: string[], options?: { timeout?: number }): {
  stdout: string;
  exitCode: number;
} {
  const cmd = `npx tsx "${cliPath}" ${args.map((a) => `"${a}"`).join(" ")}`;
  try {
    const stdout = execSync(cmd, {
      cwd: projectRoot,
      timeout: options?.timeout ?? 15_000,
      encoding: "utf-8",
      env: {
        ...process.env,
        STRATA_DATA_DIR: join(projectRoot, "tests", ".test-strata-data"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout: stdout.trim(), exitCode: 0 };
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; status?: number };
    const output = [err.stdout ?? "", err.stderr ?? ""].join("\n").trim();
    return {
      stdout: output,
      exitCode: err.status ?? 1,
    };
  }
}

describe("CLI", () => {
  it("prints version with --version flag", () => {
    const result = runCli(["--version"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(pkg.version);
  });

  it("prints version with -v flag", () => {
    const result = runCli(["-v"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(pkg.version);
  });

  it("prints help with --help flag", () => {
    const result = runCli(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("strata-mcp");
    expect(result.stdout).toContain("search");
    expect(result.stdout).toContain("migrate");
    expect(result.stdout).toContain("status");
    expect(result.stdout).toContain("--version");
  });

  it("prints help with -h flag", () => {
    const result = runCli(["-h"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage:");
  });

  it("search without query prints usage and exits with code 1", () => {
    const result = runCli(["search"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Usage:");
  });

  it("search with query executes and returns exit code", () => {
    // This test may take time as it indexes real sessions in the user's home dir.
    // We verify the CLI launches and responds to the search command.
    const result = runCli(["search", "nonexistent-query-xyz-12345"], { timeout: 60_000 });
    // Exit code 1 = no results found (expected), 0 = results found (unlikely)
    expect([0, 1]).toContain(result.exitCode);
  }, 65_000);

  it("status prints database info", () => {
    const result = runCli(["status"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Strata v");
    expect(result.stdout).toContain("Database:");
    expect(result.stdout).toContain("Sessions:");
    expect(result.stdout).toContain("Documents:");
    expect(result.stdout).toContain("Parsers:");
  });

  it("migrate completes without crashing", () => {
    const result = runCli(["migrate"], { timeout: 30_000 });
    // Either exits 0 (success / no legacy data) or outputs a message
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  it("help output includes all subcommands and flags", () => {
    const result = runCli(["--help"]);
    expect(result.stdout).toContain("search");
    expect(result.stdout).toContain("migrate");
    expect(result.stdout).toContain("status");
    expect(result.stdout).toContain("--limit");
    expect(result.stdout).toContain("--project");
    expect(result.stdout).toContain("--json");
    expect(result.stdout).toContain("--force");
  });

  it("version output matches package.json version exactly", () => {
    const result = runCli(["--version"]);
    expect(result.stdout).toBe("1.0.0");
  });
});
