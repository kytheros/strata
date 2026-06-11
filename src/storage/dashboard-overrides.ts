/**
 * Dashboard-driven config overrides.
 *
 * The Pro Dashboard's Settings → Configuration editor writes runtime
 * overrides into ~/.strata/dashboard-overrides.json. This module is the
 * single source of truth for reading, writing, and merging them onto the
 * compiled CONFIG defaults.
 *
 * Override format: a flat object keyed by dot-path, value = the override.
 *
 *   {
 *     "search.defaultLimit": 30,
 *     "indexing.maxChunksPerSession": 800,
 *     "health.thresholds.embedding_coverage.ok": 0.90
 *   }
 *
 * Dot-path keeps the file human-editable and avoids the deep-merge edge
 * cases of full-tree shapes. Apply-time, each key is split and walked
 * into the target object; the leaf is replaced.
 *
 * Overrides apply at the next process start (dashboard PUT response
 * advises a restart). Hot-reload is intentionally deferred to v1.3.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export interface OverrideMap {
  [dotPath: string]: unknown;
}

/**
 * Resolved per call (not at module load) so STRATA_DATA_DIR redirection
 * works the same way it does for the database — an env-redirected
 * instance must not read or write the real ~/.strata.
 */
export function getOverridesFilePath(): string {
  const dataDir = process.env.STRATA_DATA_DIR || join(homedir(), ".strata");
  return join(dataDir, "dashboard-overrides.json");
}

export function loadOverrides(): OverrideMap {
  const file = getOverridesFilePath();
  if (!existsSync(file)) return {};
  try {
    const raw = readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as OverrideMap;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Replace the overrides file with the given map (full overwrite, NOT merge).
 * Callers that want to merge with existing should `loadOverrides()` first.
 */
export function saveOverrides(overrides: OverrideMap): void {
  const file = getOverridesFilePath();
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(overrides, null, 2), "utf-8");
}

/**
 * Merge `patch` on top of existing overrides and persist. A null/undefined
 * value clears that key (reverts to compiled default at next restart).
 * Returns the resulting full override map.
 */
export function patchOverrides(patch: OverrideMap): OverrideMap {
  const current = loadOverrides();
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) {
      delete current[k];
    } else {
      current[k] = v;
    }
  }
  saveOverrides(current);
  return current;
}

/**
 * Apply overrides to a copy of `base`. Returns a new object; does NOT
 * mutate the input. Each dot-path key is walked; missing intermediate
 * objects are created.
 */
export function applyOverrides<T extends object>(base: T, overrides: OverrideMap): T {
  const out = deepClone(base);
  for (const [dotPath, value] of Object.entries(overrides)) {
    setPath(out as Record<string, unknown>, dotPath, value);
  }
  return out;
}

function setPath(obj: Record<string, unknown>, dotPath: string, value: unknown): void {
  const parts = dotPath.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    const next = cur[p];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      cur[p] = {};
    }
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

function deepClone<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(deepClone) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = deepClone(v);
  }
  return out as T;
}
