/**
 * World registry — persists the list of worlds to {baseDir}/registry/worlds.json.
 *
 * A world is a top-level scope for Strata REST data. One SQLite file per world
 * (`worlds/{worldId}/world.db`) holds all NPC profiles, memories, relationships,
 * acquaintances, and character cards for that playthrough.
 *
 * Spec: 2026-04-15-world-scope-refactor-design.md
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface WorldRecord {
  worldId: string;
  name: string;
  createdAt: number;
}

/**
 * Reject worldIds with path-traversal characters, NUL bytes, empty strings,
 * or lengths over 128. Forward-compat: opaque strings only, no format regex.
 */
const INVALID_WORLD_ID = /[/\\\0]|\.\.|^$/;

export class WorldRegistry {
  private records = new Map<string, WorldRecord>();
  private readonly registryPath: string;

  constructor(private readonly basePath: string) {
    this.registryPath = join(basePath, "registry", "worlds.json");
    this.load();
  }

  private load(): void {
    if (!existsSync(this.registryPath)) return;
    try {
      const data = JSON.parse(readFileSync(this.registryPath, "utf-8")) as WorldRecord[];
      for (const r of data) this.records.set(r.worldId, r);
    } catch {
      // ignore parse errors; start empty
    }
  }

  private persist(): void {
    const dir = join(this.basePath, "registry");
    mkdirSync(dir, { recursive: true });
    writeFileSync(this.registryPath, JSON.stringify([...this.records.values()], null, 2), "utf-8");
  }

  /** Create a new world. Throws if worldId is invalid or already exists. */
  create(worldId: string, name: string): WorldRecord {
    if (worldId.length > 128 || INVALID_WORLD_ID.test(worldId)) {
      throw new Error(`invalid worldId: ${worldId}`);
    }
    if (this.records.has(worldId)) {
      throw new Error(`world exists: ${worldId}`);
    }
    const rec: WorldRecord = { worldId, name, createdAt: Date.now() };
    this.records.set(worldId, rec);
    this.persist();
    return rec;
  }

  /** List all worlds. */
  list(): WorldRecord[] {
    return [...this.records.values()];
  }

  /** Get a world by ID. Returns null if not found. */
  get(worldId: string): WorldRecord | null {
    return this.records.get(worldId) ?? null;
  }

  /**
   * Delete a world record and remove its on-disk directory.
   * Throws if the world does not exist.
   */
  delete(worldId: string): void {
    if (!this.records.has(worldId)) {
      throw new Error(`no such world: ${worldId}`);
    }
    this.records.delete(worldId);
    this.persist();
    // Remove world data directory (world.db + any other files)
    const worldDir = join(this.basePath, "worlds", worldId);
    if (existsSync(worldDir)) {
      rmSync(worldDir, { recursive: true, force: true });
    }
  }

  /**
   * Ensure the "default" world exists. Called on server boot for zero-config
   * single-world deploys.
   */
  ensureDefault(): void {
    if (this.records.size === 0) {
      this.create("default", "Default World");
    }
  }
}
