import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface CacheKey {
  provider: string;
  modelVersion: string;
  promptHash: string;
  sessionHash: string;
}

export interface CacheKeyInput {
  provider: string;
  modelVersion: string;
  promptTemplate: string;
  sessionContent: string;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export function cacheKeyFor(input: CacheKeyInput): CacheKey {
  return {
    provider: input.provider,
    modelVersion: input.modelVersion,
    promptHash: sha256Hex(input.promptTemplate),
    sessionHash: sha256Hex(input.sessionContent),
  };
}

export function cachePath(root: string, key: CacheKey): string {
  return join(root, key.provider, key.modelVersion, key.promptHash, `${key.sessionHash}.json`);
}

export function readCache<T = unknown>(root: string, key: CacheKey): T | null {
  const p = cachePath(root, key);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as T;
}

export function writeCache(root: string, key: CacheKey, payload: unknown): void {
  const p = cachePath(root, key);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(payload, null, 2));
}
