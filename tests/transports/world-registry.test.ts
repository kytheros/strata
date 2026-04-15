import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorldRegistry } from "../../src/transports/world-registry.js";

let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "world-registry-"));
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe("WorldRegistry — create + list + get", () => {
  it("creates a world and retrieves it by id", () => {
    const reg = new WorldRegistry(baseDir);
    const rec = reg.create("story-1", "Story One");
    expect(rec.worldId).toBe("story-1");
    expect(rec.name).toBe("Story One");
    expect(rec.createdAt).toBeGreaterThan(0);

    const got = reg.get("story-1");
    expect(got).not.toBeNull();
    expect(got!.worldId).toBe("story-1");
  });

  it("list() returns all created worlds", () => {
    const reg = new WorldRegistry(baseDir);
    reg.create("w1", "World One");
    reg.create("w2", "World Two");
    const list = reg.list();
    expect(list.length).toBe(2);
    expect(list.map((r) => r.worldId)).toContain("w1");
    expect(list.map((r) => r.worldId)).toContain("w2");
  });

  it("get() returns null for unknown worldId", () => {
    const reg = new WorldRegistry(baseDir);
    expect(reg.get("nope")).toBeNull();
  });

  it("persists across registry instances (survives reload)", () => {
    const reg1 = new WorldRegistry(baseDir);
    reg1.create("persistent-world", "Persistent");
    const reg2 = new WorldRegistry(baseDir);
    expect(reg2.get("persistent-world")).not.toBeNull();
  });
});

describe("WorldRegistry — duplicate and invalid IDs", () => {
  it("throws on duplicate worldId", () => {
    const reg = new WorldRegistry(baseDir);
    reg.create("dupe", "First");
    expect(() => reg.create("dupe", "Second")).toThrow(/world exists/);
  });

  it("rejects empty worldId", () => {
    const reg = new WorldRegistry(baseDir);
    expect(() => reg.create("", "Name")).toThrow(/invalid worldId/);
  });

  it("rejects worldId with forward slash", () => {
    const reg = new WorldRegistry(baseDir);
    expect(() => reg.create("foo/bar", "Name")).toThrow(/invalid worldId/);
  });

  it("rejects worldId with backslash", () => {
    const reg = new WorldRegistry(baseDir);
    expect(() => reg.create("foo\\bar", "Name")).toThrow(/invalid worldId/);
  });

  it("rejects worldId with path traversal (..)", () => {
    const reg = new WorldRegistry(baseDir);
    expect(() => reg.create("../evil", "Name")).toThrow(/invalid worldId/);
  });

  it("rejects worldId longer than 128 characters", () => {
    const reg = new WorldRegistry(baseDir);
    expect(() => reg.create("a".repeat(129), "Name")).toThrow(/invalid worldId/);
  });

  it("accepts worldId exactly 128 characters", () => {
    const reg = new WorldRegistry(baseDir);
    const id = "a".repeat(128);
    expect(() => reg.create(id, "Name")).not.toThrow();
  });
});

describe("WorldRegistry — delete", () => {
  it("delete() removes the world from list", () => {
    const reg = new WorldRegistry(baseDir);
    reg.create("to-delete", "Gone");
    reg.delete("to-delete");
    expect(reg.get("to-delete")).toBeNull();
    expect(reg.list().length).toBe(0);
  });

  it("delete() removes the world directory if present", () => {
    const reg = new WorldRegistry(baseDir);
    reg.create("to-delete", "Gone");
    // Manually create the world directory to verify it gets removed
    const worldDir = join(baseDir, "worlds", "to-delete");
    mkdirSync(worldDir, { recursive: true });
    reg.delete("to-delete");
    expect(existsSync(worldDir)).toBe(false);
  });

  it("delete() throws on unknown worldId", () => {
    const reg = new WorldRegistry(baseDir);
    expect(() => reg.delete("nope")).toThrow(/no such world/);
  });

  it("delete persists after reload", () => {
    const reg1 = new WorldRegistry(baseDir);
    reg1.create("ephemeral", "Temp");
    reg1.delete("ephemeral");
    const reg2 = new WorldRegistry(baseDir);
    expect(reg2.get("ephemeral")).toBeNull();
  });
});

describe("WorldRegistry — ensureDefault", () => {
  it("creates 'default' world when registry is empty", () => {
    const reg = new WorldRegistry(baseDir);
    reg.ensureDefault();
    const def = reg.get("default");
    expect(def).not.toBeNull();
    expect(def!.name).toBe("Default World");
  });

  it("does not create duplicate when default already exists", () => {
    const reg = new WorldRegistry(baseDir);
    reg.create("default", "My Default");
    reg.ensureDefault();
    expect(reg.list().length).toBe(1);
  });

  it("does not create default when other worlds exist", () => {
    const reg = new WorldRegistry(baseDir);
    reg.create("other", "Other");
    reg.ensureDefault();
    expect(reg.get("default")).toBeNull();
    expect(reg.list().length).toBe(1);
  });
});
