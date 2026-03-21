import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "child_process";
import { join } from "path";
import { mkdirSync, rmSync, existsSync, readFileSync } from "fs";

const projectRoot = join(import.meta.dirname, "../..");
const cliPath = join(projectRoot, "src/cli.ts").replace(/\\/g, "/");
const testDataDir = join(projectRoot, "tests", ".test-distill-data");

/**
 * Run the CLI via tsx for testing (avoids needing a build step).
 */
function runCli(
  args: string[],
  options?: { timeout?: number; env?: Record<string, string> }
): {
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
        STRATA_DATA_DIR: testDataDir,
        // Unset GEMINI_API_KEY for predictable mode detection
        GEMINI_API_KEY: "",
        ...(options?.env ?? {}),
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

describe("CLI: distill subcommand", () => {
  beforeEach(() => {
    // Clean test data directory
    if (existsSync(testDataDir)) {
      rmSync(testDataDir, { recursive: true, force: true });
    }
    mkdirSync(testDataDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDataDir)) {
      rmSync(testDataDir, { recursive: true, force: true });
    }
  });

  it("prints usage when no subcommand given", () => {
    const result = runCli(["distill"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("status");
    expect(result.stdout).toContain("export-data");
    expect(result.stdout).toContain("activate");
    expect(result.stdout).toContain("deactivate");
  });

  it("prints usage for unknown subcommand", () => {
    const result = runCli(["distill", "unknown"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Usage:");
  });
});

describe("CLI: distill status", () => {
  beforeEach(() => {
    if (existsSync(testDataDir)) {
      rmSync(testDataDir, { recursive: true, force: true });
    }
    mkdirSync(testDataDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDataDir)) {
      rmSync(testDataDir, { recursive: true, force: true });
    }
  });

  it("shows status with zero training data", () => {
    const result = runCli(["distill", "status", "--no-color"], { timeout: 30_000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Strata Distillation Status");
    expect(result.stdout).toContain("Training data collected:");
    expect(result.stdout).toContain("Extraction:");
    expect(result.stdout).toContain("Summarization:");
    expect(result.stdout).toContain("0 pairs");
    expect(result.stdout).toContain("Quality breakdown:");
    expect(result.stdout).toContain("Last pair captured:");
    expect(result.stdout).toContain("Local model status:");
    expect(result.stdout).toContain("Current mode:");
  }, 35_000);

  it("shows heuristic mode when no GEMINI_API_KEY", () => {
    const result = runCli(["distill", "status", "--no-color"], {
      timeout: 30_000,
      env: { GEMINI_API_KEY: "" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("heuristic");
  }, 35_000);

  it("shows gemini mode when GEMINI_API_KEY is set", () => {
    const result = runCli(["distill", "status", "--no-color"], {
      timeout: 30_000,
      env: { GEMINI_API_KEY: "test-key-123" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("gemini");
  }, 35_000);

  it("shows --no-color output without ANSI codes", () => {
    const result = runCli(["distill", "status", "--no-color"], { timeout: 30_000 });
    expect(result.stdout).not.toMatch(/\x1b\[/);
  }, 35_000);
});

describe("CLI: distill export-data", () => {
  beforeEach(() => {
    if (existsSync(testDataDir)) {
      rmSync(testDataDir, { recursive: true, force: true });
    }
    mkdirSync(testDataDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDataDir)) {
      rmSync(testDataDir, { recursive: true, force: true });
    }
  });

  it("requires --task flag", () => {
    const output = join(testDataDir, "out.jsonl");
    const result = runCli(["distill", "export-data", "--output", output]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Usage:");
  });

  it("requires --output flag", () => {
    const result = runCli(["distill", "export-data", "--task", "extraction"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Usage:");
  });

  it("rejects invalid task type", () => {
    const output = join(testDataDir, "out.jsonl");
    const result = runCli(["distill", "export-data", "--task", "invalid", "--output", output]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Usage:");
  });

  it("exports zero rows from empty database", () => {
    const output = join(testDataDir, "empty.jsonl").replace(/\\/g, "/");
    const result = runCli(
      ["distill", "export-data", "--task", "extraction", "--output", output],
      { timeout: 30_000 }
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Exported 0 pairs");
    expect(existsSync(output)).toBe(true);
    expect(readFileSync(output, "utf-8")).toBe("");
  }, 35_000);
});

describe("CLI: distill activate/deactivate", () => {
  beforeEach(() => {
    if (existsSync(testDataDir)) {
      rmSync(testDataDir, { recursive: true, force: true });
    }
    mkdirSync(testDataDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDataDir)) {
      rmSync(testDataDir, { recursive: true, force: true });
    }
  });

  it("activate writes config and prints confirmation", () => {
    const result = runCli(["distill", "activate"], { timeout: 15_000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Distillation mode activated");

    // Verify config.json was written
    const configPath = join(testDataDir, "config.json");
    expect(existsSync(configPath)).toBe(true);
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.distillation).toEqual({ enabled: true });
  });

  it("deactivate writes config and prints confirmation", () => {
    // First activate
    runCli(["distill", "activate"], { timeout: 15_000 });

    // Then deactivate
    const result = runCli(["distill", "deactivate"], { timeout: 15_000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Distillation mode deactivated");

    const configPath = join(testDataDir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.distillation).toEqual({ enabled: false });
  });

  it("activate then status shows hybrid mode with GEMINI_API_KEY", () => {
    runCli(["distill", "activate"], { timeout: 15_000 });

    const result = runCli(["distill", "status", "--no-color"], {
      timeout: 30_000,
      env: { GEMINI_API_KEY: "test-key-123" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hybrid");
  }, 35_000);
});

describe("CLI: help includes distill", () => {
  it("--help mentions distill subcommand", () => {
    const result = runCli(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("distill status");
    expect(result.stdout).toContain("distill export-data");
    expect(result.stdout).toContain("distill activate");
    expect(result.stdout).toContain("distill deactivate");
  });
});
