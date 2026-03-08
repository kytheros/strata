import { describe, it, expect, afterEach } from "vitest";
import { SqliteIndexManager } from "../../src/indexing/sqlite-index-manager.js";

describe("SqliteIndexManager", () => {
  let manager: SqliteIndexManager;

  afterEach(() => {
    if (manager) manager.close();
  });

  it("should create with in-memory database", () => {
    manager = new SqliteIndexManager(":memory:");
    expect(manager.db.open).toBe(true);
  });

  it("should expose all stores", () => {
    manager = new SqliteIndexManager(":memory:");
    expect(manager.documents).toBeDefined();
    expect(manager.knowledge).toBeDefined();
    expect(manager.summaries).toBeDefined();
    expect(manager.meta).toBeDefined();
  });

  it("should report zero stats for empty database", () => {
    manager = new SqliteIndexManager(":memory:");
    const stats = manager.getStats();
    expect(stats.documents).toBe(0);
    expect(stats.sessions).toBe(0);
    expect(stats.projects).toBe(0);
    expect(stats.buildTimeMs).toBe(0);
  });

  it("should store and retrieve metadata", () => {
    manager = new SqliteIndexManager(":memory:");
    manager.meta.set("version", "1");
    expect(manager.meta.get("version")).toBe("1");
  });

  it("should close database", () => {
    manager = new SqliteIndexManager(":memory:");
    manager.close();
    expect(manager.db.open).toBe(false);
    // Prevent double-close in afterEach
    manager = undefined as unknown as SqliteIndexManager;
  });
});
