import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyOverrides,
  getOverridesFilePath,
  saveOverrides,
  loadOverrides,
} from "../../src/storage/dashboard-overrides.js";

describe("STRATA_DATA_DIR redirection", () => {
  let workDir: string;
  let savedDataDir: string | undefined;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "strata-overrides-"));
    savedDataDir = process.env.STRATA_DATA_DIR;
  });

  afterEach(() => {
    if (savedDataDir === undefined) delete process.env.STRATA_DATA_DIR;
    else process.env.STRATA_DATA_DIR = savedDataDir;
    rmSync(workDir, { recursive: true, force: true });
  });

  it("resolves the overrides file under STRATA_DATA_DIR per call", () => {
    process.env.STRATA_DATA_DIR = workDir;
    expect(getOverridesFilePath()).toBe(join(workDir, "dashboard-overrides.json"));
    // Per-call resolution: changing the env changes the path.
    delete process.env.STRATA_DATA_DIR;
    expect(getOverridesFilePath()).not.toBe(join(workDir, "dashboard-overrides.json"));
  });

  it("save + load round-trips through the redirected directory", () => {
    process.env.STRATA_DATA_DIR = workDir;
    saveOverrides({ "search.defaultLimit": 30 });
    expect(existsSync(join(workDir, "dashboard-overrides.json"))).toBe(true);
    expect(
      JSON.parse(readFileSync(join(workDir, "dashboard-overrides.json"), "utf-8"))
    ).toEqual({ "search.defaultLimit": 30 });
    expect(loadOverrides()).toEqual({ "search.defaultLimit": 30 });
  });
});

describe("applyOverrides", () => {
  it("replaces a leaf value at the given dot path", () => {
    const base = { search: { defaultLimit: 20, maxLimit: 100 } };
    const out = applyOverrides(base, { "search.defaultLimit": 50 });
    expect(out.search.defaultLimit).toBe(50);
    expect(out.search.maxLimit).toBe(100);
  });

  it("walks into nested objects without mutating base", () => {
    const base = { health: { thresholds: { embedding_coverage: { ok: 0.95, warn: 0.7 } } } };
    const out = applyOverrides(base, { "health.thresholds.embedding_coverage.ok": 0.9 });
    expect(out.health.thresholds.embedding_coverage.ok).toBe(0.9);
    expect(out.health.thresholds.embedding_coverage.warn).toBe(0.7);
    // base untouched
    expect(base.health.thresholds.embedding_coverage.ok).toBe(0.95);
  });

  it("creates missing intermediate paths", () => {
    const base: Record<string, unknown> = {};
    const out = applyOverrides(base, { "a.b.c": 42 });
    expect((out as { a: { b: { c: number } } }).a.b.c).toBe(42);
  });

  it("replaces an entire subtree when the path lands on an object", () => {
    const base = { bm25: { k1: 1.2, b: 0.75 } };
    const out = applyOverrides(base, { "bm25": { k1: 1.5, b: 0.8 } });
    expect(out.bm25.k1).toBe(1.5);
    expect(out.bm25.b).toBe(0.8);
  });

  it("handles multiple overrides in one pass", () => {
    const base = { search: { defaultLimit: 20 }, gaps: { maxPerProject: 100 } };
    const out = applyOverrides(base, {
      "search.defaultLimit": 30,
      "gaps.maxPerProject": 200,
    });
    expect(out.search.defaultLimit).toBe(30);
    expect(out.gaps.maxPerProject).toBe(200);
  });
});
