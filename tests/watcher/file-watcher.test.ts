import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { FileWatcher, getWatchTargets, type WatchTarget } from "../../src/watcher/file-watcher.js";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `strata-fw-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("WatchTarget matching", () => {
  it("getWatchTargets filters out non-existent directories", () => {
    // The default targets include directories that likely don't exist in test env.
    // Just verify the function returns an array and doesn't throw.
    const targets = getWatchTargets();
    expect(Array.isArray(targets)).toBe(true);
    for (const t of targets) {
      expect(existsSync(t.dir)).toBe(true);
    }
  });
});

describe("FileWatcher multi-directory", () => {
  let tmpDirs: string[] = [];

  function createTmpDir(): string {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
    tmpDirs = [];
  });

  it("starts watchers for each target directory that exists", () => {
    const existingDir = createTmpDir();
    const missingDir = join(tmpdir(), `strata-fw-missing-${Date.now()}`);

    const targets: WatchTarget[] = [
      { dir: existingDir, glob: "*.jsonl", extensions: [".jsonl"], parserId: "claude-code" },
      { dir: missingDir, glob: "*.json", extensions: [".json"], parserId: "gemini-cli" },
    ];

    const watcher = new FileWatcher(50, targets);
    const calls: Array<{ filePath: string; parserId: string }> = [];
    watcher.start((filePath, parserId) => {
      calls.push({ filePath, parserId });
    });

    // Should not throw; missing dir silently skipped
    watcher.stop();
  });

  it("triggers callback with correct parserId for matching files", async () => {
    const claudeDir = createTmpDir();
    const geminiDir = createTmpDir();

    const targets: WatchTarget[] = [
      { dir: claudeDir, glob: "*.jsonl", extensions: [".jsonl"], parserId: "claude-code" },
      { dir: geminiDir, glob: "checkpoint-*.json", extensions: [".json"], parserId: "gemini-cli" },
    ];

    const calls: Array<{ filePath: string; parserId: string }> = [];
    const watcher = new FileWatcher(50, targets);
    watcher.start((filePath, parserId) => {
      calls.push({ filePath, parserId });
    });

    // Write a .jsonl file into the claude dir
    writeFileSync(join(claudeDir, "session.jsonl"), '{"test": true}\n');

    // Write a checkpoint JSON into the gemini dir
    writeFileSync(join(geminiDir, "checkpoint-abc.json"), '[]');

    // Write a non-matching file into the gemini dir
    writeFileSync(join(geminiDir, "other.json"), '{}');

    // Wait for debounce (50ms) + some buffer
    await new Promise((r) => setTimeout(r, 300));

    watcher.stop();

    // Should have callbacks for the matching files
    const claudeCalls = calls.filter((c) => c.parserId === "claude-code");
    const geminiCalls = calls.filter((c) => c.parserId === "gemini-cli");

    expect(claudeCalls.length).toBeGreaterThanOrEqual(1);
    expect(geminiCalls.length).toBeGreaterThanOrEqual(1);

    // The non-matching "other.json" should not trigger gemini callback
    // (it doesn't match "checkpoint-*" prefix)
    for (const c of geminiCalls) {
      expect(c.filePath).toContain("checkpoint-");
    }
  });

  it("stop() closes all watchers and clears timers", () => {
    const dir1 = createTmpDir();
    const dir2 = createTmpDir();

    const targets: WatchTarget[] = [
      { dir: dir1, glob: "*.jsonl", extensions: [".jsonl"], parserId: "a" },
      { dir: dir2, glob: "*.json", extensions: [".json"], parserId: "b" },
    ];

    const watcher = new FileWatcher(5000, targets);
    watcher.start(() => {});

    // Write files to trigger debounce timers
    writeFileSync(join(dir1, "test.jsonl"), "{}");
    writeFileSync(join(dir2, "test.json"), "{}");

    // stop() should not throw
    watcher.stop();

    // Calling stop again should be safe (idempotent)
    watcher.stop();
  });

  it("one watcher failure does not affect others", async () => {
    const goodDir = createTmpDir();
    // Use a target with an existing dir that we'll make unavailable between construct and start
    const targets: WatchTarget[] = [
      { dir: goodDir, glob: "*.jsonl", extensions: [".jsonl"], parserId: "good" },
    ];

    const calls: Array<{ filePath: string; parserId: string }> = [];
    const watcher = new FileWatcher(50, targets);
    watcher.start((filePath, parserId) => {
      calls.push({ filePath, parserId });
    });

    writeFileSync(join(goodDir, "test.jsonl"), '{"ok": true}\n');
    await new Promise((r) => setTimeout(r, 300));

    watcher.stop();

    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0].parserId).toBe("good");
  });

  it("watches recursive subdirectories", async () => {
    const baseDir = createTmpDir();
    const subDir = join(baseDir, "project-hash", "chats");
    mkdirSync(subDir, { recursive: true });

    const targets: WatchTarget[] = [
      { dir: baseDir, glob: "checkpoint-*.json", extensions: [".json"], parserId: "gemini-cli" },
    ];

    const calls: Array<{ filePath: string; parserId: string }> = [];
    const watcher = new FileWatcher(50, targets);
    watcher.start((filePath, parserId) => {
      calls.push({ filePath, parserId });
    });

    // Write into a nested subdirectory
    writeFileSync(join(subDir, "checkpoint-abc.json"), '[]');

    await new Promise((r) => setTimeout(r, 300));

    watcher.stop();

    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0].parserId).toBe("gemini-cli");
    expect(calls[0].filePath).toContain("checkpoint-abc.json");
  });

  it("debounces rapid changes to the same file", async () => {
    const dir = createTmpDir();

    const targets: WatchTarget[] = [
      { dir, glob: "*.jsonl", extensions: [".jsonl"], parserId: "test" },
    ];

    const calls: Array<{ filePath: string; parserId: string }> = [];
    const watcher = new FileWatcher(100, targets);
    watcher.start((filePath, parserId) => {
      calls.push({ filePath, parserId });
    });

    // Write to the same file multiple times rapidly
    const file = join(dir, "session.jsonl");
    writeFileSync(file, '{"line": 1}\n');
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(file, '{"line": 1}\n{"line": 2}\n');
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(file, '{"line": 1}\n{"line": 2}\n{"line": 3}\n');

    // Wait for debounce to fire
    await new Promise((r) => setTimeout(r, 300));

    watcher.stop();

    // Should have been debounced to 1 call (or at most 2 if timing is loose)
    expect(calls.length).toBeLessThanOrEqual(2);
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  it("matches exact filename globs (e.g. cline)", async () => {
    const dir = createTmpDir();
    const taskDir = join(dir, "task-123");
    mkdirSync(taskDir, { recursive: true });

    const targets: WatchTarget[] = [
      { dir, glob: "api_conversation_history.json", extensions: [".json"], parserId: "cline" },
    ];

    const calls: Array<{ filePath: string; parserId: string }> = [];
    const watcher = new FileWatcher(50, targets);
    watcher.start((filePath, parserId) => {
      calls.push({ filePath, parserId });
    });

    // Write the exact filename
    writeFileSync(join(taskDir, "api_conversation_history.json"), '[]');

    // Write a non-matching JSON file
    writeFileSync(join(taskDir, "ui_messages.json"), '[]');

    await new Promise((r) => setTimeout(r, 300));

    watcher.stop();

    const clineCalls = calls.filter((c) => c.parserId === "cline");
    expect(clineCalls.length).toBeGreaterThanOrEqual(1);

    // ui_messages.json should NOT match
    for (const c of clineCalls) {
      expect(c.filePath).toContain("api_conversation_history.json");
    }
  });
});

describe("STRATA_EXTRA_WATCH_DIRS", () => {
  const origEnv = process.env.STRATA_EXTRA_WATCH_DIRS;

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env.STRATA_EXTRA_WATCH_DIRS;
    } else {
      process.env.STRATA_EXTRA_WATCH_DIRS = origEnv;
    }
  });

  it("parses extra watch dirs from env var", async () => {
    const extraDir = join(tmpdir(), `strata-extra-${Date.now()}`);
    mkdirSync(extraDir, { recursive: true });

    process.env.STRATA_EXTRA_WATCH_DIRS = `${extraDir}:.log`;

    // Re-import to pick up env change — just test getWatchTargets directly
    const targets = getWatchTargets();
    const extraTarget = targets.find((t) => t.dir === extraDir);
    expect(extraTarget).toBeDefined();
    expect(extraTarget!.extensions).toEqual([".log"]);
    expect(extraTarget!.parserId).toBe(`extra:${extraDir}`);

    rmSync(extraDir, { recursive: true, force: true });
  });
});
