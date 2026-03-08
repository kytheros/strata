import { describe, it, expect } from "vitest";
import { execSync } from "child_process";
import { join } from "path";
import { readFileSync } from "fs";

const projectRoot = join(import.meta.dirname, "../..");
const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf-8"));
const cliPath = join(projectRoot, "src/cli.ts").replace(/\\/g, "/");

/**
 * Run the CLI via tsx for testing (avoids needing a build step).
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

describe("CLI: package.json bin alias", () => {
  it("has both strata and strata-mcp bin entries", () => {
    expect(pkg.bin).toHaveProperty("strata");
    expect(pkg.bin).toHaveProperty("strata-mcp");
    expect(pkg.bin.strata).toBe(pkg.bin["strata-mcp"]);
  });
});

describe("CLI: help text", () => {
  it("lists all subcommands including new ones", () => {
    const result = runCli(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("store-memory");
    expect(result.stdout).toContain("search");
    expect(result.stdout).toContain("migrate");
    expect(result.stdout).toContain("status");
  });

  it("documents new flags", () => {
    const result = runCli(["--help"]);
    expect(result.stdout).toContain("--type");
    expect(result.stdout).toContain("--tags");
    expect(result.stdout).toContain("--no-color");
    expect(result.stdout).toContain("NO_COLOR");
  });

  it("uses strata as primary command name", () => {
    const result = runCli(["--help"]);
    expect(result.stdout).toMatch(/^strata v/);
    expect(result.stdout).toContain("strata-mcp");
  });
});

describe("CLI: search formatting", () => {
  it("includes box-drawing characters in output", () => {
    const result = runCli(["search", "test"], { timeout: 60_000 });
    if (result.exitCode === 0) {
      // If results found, verify box-drawing chars
      expect(result.stdout).toMatch(/[┌│└─]/);
    }
    // Exit code 0 (results) or 1 (no results) are both valid
    expect([0, 1]).toContain(result.exitCode);
  }, 65_000);

  it("--no-color suppresses ANSI escape codes", () => {
    const result = runCli(["search", "test", "--no-color"], { timeout: 60_000 });
    // No ANSI escape sequences should be present
    expect(result.stdout).not.toMatch(/\x1b\[/);
    expect([0, 1]).toContain(result.exitCode);
  }, 65_000);

  it("--json produces valid JSON", () => {
    const result = runCli(["search", "test", "--json"], { timeout: 60_000 });
    if (result.exitCode === 0) {
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      const parsed = JSON.parse(result.stdout);
      expect(Array.isArray(parsed)).toBe(true);
    }
    expect([0, 1]).toContain(result.exitCode);
  }, 65_000);
});

describe("CLI: pro feature upgrade messages", () => {
  it("find-procedures shows upgrade message", () => {
    const result = runCli(["find-procedures"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Strata Pro");
  });

  it("entities shows upgrade message", () => {
    const result = runCli(["entities"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Strata Pro");
  });
});

describe("CLI: store-memory", () => {
  it("missing text prints usage and exits 1", () => {
    const result = runCli(["store-memory"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Usage:");
  });

  it("missing --type prints error and exits 1", () => {
    const result = runCli(["store-memory", "test memory"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("--type");
  });

  it("stores a memory successfully", () => {
    const result = runCli(
      ["store-memory", "E2E test memory entry for CLI parity", "--type", "fact", "--no-color"],
      { timeout: 30_000 }
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Stored");
  }, 35_000);

  it("--json produces valid JSON", () => {
    const result = runCli(
      ["store-memory", "JSON test memory entry", "--type", "fact", "--json"],
      { timeout: 30_000 }
    );
    expect(result.exitCode).toBe(0);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toHaveProperty("result");
    expect(parsed).toHaveProperty("type", "fact");
  }, 35_000);

  it("--no-color suppresses ANSI codes", () => {
    const result = runCli(
      ["store-memory", "No-color test memory", "--type", "decision", "--no-color"],
      { timeout: 30_000 }
    );
    expect(result.stdout).not.toMatch(/\x1b\[/);
  }, 35_000);
});
