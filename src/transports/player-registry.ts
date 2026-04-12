/**
 * Player registry for the REST transport's two-tier auth model.
 *
 * Stores provisioned players (admin-token-authed) and their hashed
 * bearer tokens (player-token-authed). Backed by an atomic-write
 * JSON file at {baseDir}/players.json.
 *
 * See specs/2026-04-11-per-player-npc-scoping-design.md Sections 1–3.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface PlayerEntry {
  playerId: string;
  tokenHash: string;
  externalId: string | null;
  createdAt: number;
  expiresAt: number | null;
  lastAccess: number;
}

export interface PlayerRegistryFile {
  version: 1;
  players: Record<string, PlayerEntry>;
  externalIdIndex: Record<string, string>;
}

export interface ProvisionResult {
  playerId: string;
  playerToken: string;
  externalId: string | null;
  createdAt: number;
  isNew: boolean;
}

/**
 * In-memory registry with disk persistence.
 *
 * - `auth(token)` — O(1) lookup for the data-endpoint auth middleware.
 * - `provision(externalId?)` — idempotent on externalId; returns the
 *   raw player token exactly once (at issue time), then forgets it.
 * - `remove(playerId)` — deletes the entry and purges the externalIdIndex.
 * - `touch(playerId)` — updates lastAccess in memory; disk flush is debounced.
 */
export class PlayerRegistry {
  private players = new Map<string, PlayerEntry>();           // playerId -> entry
  private tokenHashIndex = new Map<string, PlayerEntry>();    // tokenHash -> entry
  private externalIdIndex = new Map<string, string>();        // externalId -> playerId
  private provisionLocks = new Map<string, Promise<ProvisionResult>>();
  private lastAccessDirty = false;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly filePath: string;

  constructor(private readonly baseDir: string) {
    this.filePath = join(baseDir, "players.json");
    mkdirSync(baseDir, { recursive: true });
    this.load();
    this.flushTimer = setInterval(() => this.flushIfDirty(), 10_000);
    if (typeof this.flushTimer.unref === "function") {
      this.flushTimer.unref();
    }
  }

  /** Hash a raw token for registry lookup and storage. */
  static hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  /** Generate a new opaque player token: `pt_<32 hex chars>`. */
  static generateToken(): string {
    return `pt_${randomBytes(16).toString("hex")}`;
  }

  /** Authenticate a raw bearer token. Returns the player entry or null. */
  auth(rawToken: string): PlayerEntry | null {
    if (!rawToken) return null;
    const hash = PlayerRegistry.hashToken(rawToken);
    const entry = this.tokenHashIndex.get(hash) ?? null;
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt < Date.now()) {
      return null;
    }
    return entry;
  }

  /**
   * Provision or retrieve a player by externalId.
   * Idempotent: the same externalId returns the existing token with
   * `isNew: false`. Omitted externalId always creates a new random player.
   */
  async provision(externalId: string | null): Promise<ProvisionResult> {
    // Idempotent fast path
    if (externalId) {
      const existingId = this.externalIdIndex.get(externalId);
      if (existingId) {
        const existing = this.players.get(existingId);
        if (existing) {
          return {
            playerId: existing.playerId,
            playerToken: "", // registry never reveals existing raw tokens
            externalId: existing.externalId,
            createdAt: existing.createdAt,
            isNew: false,
          };
        }
      }

      // Serialize concurrent provisions on the same externalId
      const pending = this.provisionLocks.get(externalId);
      if (pending) return pending;

      const promise = this.doProvision(externalId);
      this.provisionLocks.set(externalId, promise);
      try {
        return await promise;
      } finally {
        this.provisionLocks.delete(externalId);
      }
    }

    return this.doProvision(null);
  }

  private async doProvision(externalId: string | null): Promise<ProvisionResult> {
    const playerId = randomUUID();
    const rawToken = PlayerRegistry.generateToken();
    const entry: PlayerEntry = {
      playerId,
      tokenHash: PlayerRegistry.hashToken(rawToken),
      externalId,
      createdAt: Date.now(),
      expiresAt: null,
      lastAccess: Date.now(),
    };

    this.players.set(playerId, entry);
    this.tokenHashIndex.set(entry.tokenHash, entry);
    if (externalId) this.externalIdIndex.set(externalId, playerId);
    this.save();

    return {
      playerId,
      playerToken: rawToken,
      externalId,
      createdAt: entry.createdAt,
      isNew: true,
    };
  }

  /** Look up a player by playerId (for GET /api/players/:playerId). */
  get(playerId: string): PlayerEntry | null {
    return this.players.get(playerId) ?? null;
  }

  /** Remove a player. Returns true if removed, false if not found. */
  remove(playerId: string): boolean {
    const entry = this.players.get(playerId);
    if (!entry) return false;
    this.players.delete(playerId);
    this.tokenHashIndex.delete(entry.tokenHash);
    if (entry.externalId) this.externalIdIndex.delete(entry.externalId);
    this.save();
    return true;
  }

  /** Update lastAccess in memory. Disk flush is debounced (every 10s). */
  touch(playerId: string): void {
    const entry = this.players.get(playerId);
    if (!entry) return;
    entry.lastAccess = Date.now();
    this.lastAccessDirty = true;
  }

  /** Stop the background flush timer and flush one last time. */
  close(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushIfDirty();
  }

  // ── Persistence ──────────────────────────────────────────────────

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const data = JSON.parse(raw) as PlayerRegistryFile;
      if (data.version !== 1 || !data.players) return;
      for (const [playerId, entry] of Object.entries(data.players)) {
        this.players.set(playerId, entry);
        this.tokenHashIndex.set(entry.tokenHash, entry);
        if (entry.externalId) {
          this.externalIdIndex.set(entry.externalId, playerId);
        }
      }
    } catch (err) {
      console.error(
        `[player-registry] Failed to load ${this.filePath}: ${(err as Error).message}`
      );
    }
  }

  private save(): void {
    const file: PlayerRegistryFile = {
      version: 1,
      players: Object.fromEntries(this.players),
      externalIdIndex: Object.fromEntries(this.externalIdIndex),
    };
    const tmp = `${this.filePath}.tmp`;
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(tmp, JSON.stringify(file, null, 2), "utf-8");
    renameSync(tmp, this.filePath);
    this.lastAccessDirty = false;
  }

  private flushIfDirty(): void {
    if (!this.lastAccessDirty) return;
    try {
      this.save();
    } catch (err) {
      console.error(
        `[player-registry] lastAccess flush failed: ${(err as Error).message}`
      );
    }
  }
}
