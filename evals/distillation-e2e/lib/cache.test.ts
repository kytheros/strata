import { describe, expect, test, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  cacheKeyFor, cachePath, readCache, writeCache, type CacheKey
} from "./cache.js";

describe("extraction cache", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cache-test-"));
  });

  test("cacheKeyFor hashes consistently", () => {
    const k1 = cacheKeyFor({
      provider: "gemini", modelVersion: "2.5-flash",
      promptTemplate: "extract these facts",
      sessionContent: "hello world",
    });
    const k2 = cacheKeyFor({
      provider: "gemini", modelVersion: "2.5-flash",
      promptTemplate: "extract these facts",
      sessionContent: "hello world",
    });
    expect(k1.promptHash).toBe(k2.promptHash);
    expect(k1.sessionHash).toBe(k2.sessionHash);
  });

  test("different prompt produces different promptHash", () => {
    const a = cacheKeyFor({
      provider: "gemini", modelVersion: "v1",
      promptTemplate: "prompt A", sessionContent: "x",
    });
    const b = cacheKeyFor({
      provider: "gemini", modelVersion: "v1",
      promptTemplate: "prompt B", sessionContent: "x",
    });
    expect(a.promptHash).not.toBe(b.promptHash);
  });

  test("read returns null on miss", () => {
    const key: CacheKey = {
      provider: "g", modelVersion: "v", promptHash: "p", sessionHash: "s"
    };
    expect(readCache(root, key)).toBeNull();
  });

  test("write then read roundtrip", () => {
    const key: CacheKey = {
      provider: "g", modelVersion: "v", promptHash: "p", sessionHash: "s"
    };
    const payload = { facts: [{ subject: "x", predicate: "y" }] };
    writeCache(root, key, payload);
    expect(readCache(root, key)).toEqual(payload);
  });

  test("path layout is provider/modelVersion/promptHash/sessionHash.json", () => {
    const key: CacheKey = {
      provider: "gemini", modelVersion: "2.5-flash",
      promptHash: "abc", sessionHash: "def",
    };
    expect(cachePath(root, key)).toBe(
      join(root, "gemini", "2.5-flash", "abc", "def.json")
    );
  });
});
