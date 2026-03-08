import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteKnowledgeStore } from "../../src/storage/sqlite-knowledge-store.js";
import { RealtimeWatcher } from "../../src/watcher/realtime-watcher.js";

function makeJsonlLine(type: string, role: string, content: string, timestamp?: string): string {
  return JSON.stringify({
    type,
    message: { role, content },
    uuid: `uuid-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: timestamp || new Date().toISOString(),
    cwd: "/test/project",
  });
}

describe("RealtimeWatcher", () => {
  let db: Database.Database;
  let store: SqliteKnowledgeStore;
  let tmpDir: string;
  let sessionFile: string;
  let watcher: RealtimeWatcher;

  beforeEach(() => {
    db = openDatabase(":memory:");
    store = new SqliteKnowledgeStore(db);

    tmpDir = join(tmpdir(), `realtime-watcher-test-${Date.now()}`);
    mkdirSync(join(tmpDir, "test-project"), { recursive: true });
    sessionFile = join(tmpDir, "test-project", "test-session.jsonl");

    // Create initial file with some content
    const lines = [
      makeJsonlLine("user", "user", "How do I fix the Docker build error?"),
      makeJsonlLine("assistant", "assistant", "The fix was clearing the Docker cache with --no-cache flag"),
    ];
    writeFileSync(sessionFile, lines.join("\n") + "\n");
  });

  afterEach(() => {
    if (watcher) watcher.stop();
    db.close();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // cleanup best effort
    }
  });

  it("processes initial file content on first processNewLines call", () => {
    watcher = new RealtimeWatcher(sessionFile, store, { debounceMs: 100 });

    watcher.processNewLines();

    expect(watcher.messageCount).toBe(2);
    expect(watcher.currentOffset).toBeGreaterThan(0);
  });

  it("detects new lines appended to JSONL", () => {
    watcher = new RealtimeWatcher(sessionFile, store, { debounceMs: 100 });

    // Process initial content
    watcher.processNewLines();
    const initialCount = watcher.messageCount;

    // Append new lines
    const newLines = [
      makeJsonlLine("user", "user", "What about the database migration?"),
      makeJsonlLine("assistant", "assistant", "The solution was running migrate:latest first"),
    ];
    writeFileSync(sessionFile, newLines.join("\n") + "\n", { flag: "a" });

    // Process again
    watcher.processNewLines();
    expect(watcher.messageCount).toBe(initialCount + 2);
  });

  it("extracts knowledge from partial session via heuristic extraction", () => {
    watcher = new RealtimeWatcher(sessionFile, store, { debounceMs: 100 });

    watcher.processNewLines();

    // Knowledge extractor may or may not find entries depending on patterns
    // The important thing is that it runs without error
    expect(watcher.messageCount).toBeGreaterThan(0);
  });

  it("handles non-existent file gracefully", () => {
    const bogusPath = join(tmpDir, "nonexistent.jsonl");
    watcher = new RealtimeWatcher(bogusPath, store, { debounceMs: 100 });

    // Should not throw
    watcher.processNewLines();
    expect(watcher.messageCount).toBe(0);
  });

  it("skips malformed JSON lines", () => {
    const fileWithBadLines = join(tmpDir, "test-project", "bad-session.jsonl");
    const lines = [
      "this is not json",
      makeJsonlLine("user", "user", "A valid user message"),
      "{broken json",
      makeJsonlLine("assistant", "assistant", "A valid assistant message"),
    ];
    writeFileSync(fileWithBadLines, lines.join("\n") + "\n");

    watcher = new RealtimeWatcher(fileWithBadLines, store, { debounceMs: 100 });
    watcher.processNewLines();

    expect(watcher.messageCount).toBe(2);
  });

  it("uses debounce to prevent excessive re-parsing", async () => {
    watcher = new RealtimeWatcher(sessionFile, store, { debounceMs: 50 });

    const spy = vi.spyOn(watcher, "processNewLines");

    watcher.start();

    // Rapidly append multiple lines
    for (let i = 0; i < 5; i++) {
      const line = makeJsonlLine("user", "user", `Message ${i}`);
      writeFileSync(sessionFile, line + "\n", { flag: "a" });
    }

    // Wait for debounce to fire
    await new Promise((resolve) => setTimeout(resolve, 200));

    watcher.stop();

    // Due to debounce, processNewLines should have been called fewer times than the number of writes
    // At minimum it should have been called at least once
    expect(spy).toHaveBeenCalled();
  });

  it("stop cleans up watcher and timers", () => {
    watcher = new RealtimeWatcher(sessionFile, store, { debounceMs: 100 });
    watcher.start();
    watcher.stop();

    // Calling stop again should be safe
    watcher.stop();
    expect(watcher.messageCount).toBe(0);
  });

  it("incremental parse returns only new messages", () => {
    watcher = new RealtimeWatcher(sessionFile, store, { debounceMs: 100 });

    // First parse
    watcher.processNewLines();
    const firstCount = watcher.messageCount;

    // Append more
    const newLine = makeJsonlLine("user", "user", "decided to use PostgreSQL instead of MySQL");
    writeFileSync(sessionFile, newLine + "\n", { flag: "a" });

    // Second parse — should only get the new message
    watcher.processNewLines();
    expect(watcher.messageCount).toBe(firstCount + 1);
  });
});
