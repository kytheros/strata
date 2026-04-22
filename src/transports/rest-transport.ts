/**
 * REST transport for the Strata server.
 *
 * Provides an HTTP REST API for game engines and non-MCP consumers.
 * Two-tier auth (spec 2026-04-11-per-player-npc-scoping-design.md):
 *   - Admin token (static, from --rest-token) authenticates /api/players/*
 *   - Player tokens (issued by POST /api/players) authenticate /api/agents/*
 *
 * Each player gets an isolated on-disk directory:
 *   {baseDir}/players/{playerId}/agents/{npcId}/strata.db
 *
 * In no-auth mode (no --rest-token), all data routes to the reserved
 * "default" player at {baseDir}/players/default/agents/{npcId}/strata.db.
 */

import {
  createServer as createHttpServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { buildHealthResponse } from "./health.js";
import { createServer, type CreateServerResult } from "../server.js";
import { KNOWLEDGE_TYPES, type KnowledgeType } from "../knowledge/knowledge-store.js";
import { PlayerRegistry, type PlayerEntry } from "./player-registry.js";
import { NpcProfileStore, type NpcProfile } from "./npc-profile-store.js";
import { CharacterStore } from "./character-store.js";
import { RelationshipStore } from "./relationship-store.js";
import { computeTrustDelta, computeAnchorOutcome, type NpcAlignment, type TagRuleOverrides, type ExtendedTagRule } from "./tag-rule-engine.js";
import { resolveProfile, memoryRetention } from "./decay-engine.js";
import { rollDisclosure, type GossipTrait } from "./gossip-engine.js";
import { NpcAcquaintanceStore } from "./npc-acquaintance-store.js";
import { WorldRegistry } from "./world-registry.js";
import { WorldPool } from "./world-pool.js";
import { mintPlayerToken, verifyPlayerToken, type PlayerTokenClaims } from "./player-token.js";
import { NpcMemoryEngine } from "./npc-memory-engine.js";
import type { LlmProvider } from "../extensions/llm-extraction/llm-provider.js";
import { getExtractionProvider } from "../extensions/llm-extraction/provider-factory.js";
import { ExtractionQueueStore } from "../extensions/extraction-queue/queue-store.js";
import { ExtractionWorker } from "../extensions/extraction-queue/extraction-worker.js";
import { CompositeTenantResolver } from "../extensions/extraction-queue/tenant-db-resolver.js";

const DEFAULT_PLAYER_ID = "default";
const MIN_ADMIN_TOKEN_LEN = 32;
const DEFAULT_MAX_AGENTS = 200;
const DEFAULT_MAX_WORLDS = 16;
/** Dev-only fallback. Always set STRATA_TOKEN_SECRET in production. */
const DEFAULT_TOKEN_SECRET = "strata-dev-secret-not-for-production";

export interface RestTransportOptions {
  port: number;
  host?: string;
  /** Admin bearer token. If unset, auth is disabled (local dev convenience). */
  token?: string;
  /** Base directory for per-player databases. Defaults to STRATA_DATA_DIR or ~/.strata */
  baseDir?: string;
  /** Max per-(player, agent) servers in the LRU cache. Defaults to 200. */
  maxAgents?: number;
  /** Max open world DB handles in the LRU pool. Defaults to 16. */
  maxWorlds?: number;
  /**
   * Optional LLM provider used by the /store route when body.extract === true.
   * In production this is left undefined and the handler lazy-loads via
   * getExtractionProvider(). Tests inject a fake provider here.
   */
  extractionProvider?: LlmProvider;
}

export interface RestTransportHandle {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

interface CacheEntry {
  key: string;
  playerId: string;
  npcId: string;
  srv: CreateServerResult;
  lastAccess: number;
}

/** Compose a composite cache key from playerId and npcId. */
function cacheKey(playerId: string, npcId: string): string {
  return `${playerId}:${npcId}`;
}

/** Send JSON response */
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Extract route params from URL pattern */
function matchRoute(
  pathname: string,
  method: string,
  pattern: string,
  expectedMethod: string
): Record<string, string> | null {
  if (method !== expectedMethod) return null;
  const patternParts = pattern.split("/");
  const pathParts = pathname.split("/");
  if (patternParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(":")) {
      params[patternParts[i].slice(1)] = pathParts[i];
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

/** Parse JSON body from request */
async function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf-8");
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/** Extract the raw bearer token from an Authorization header, or "". */
function extractBearer(req: IncomingMessage): string {
  const authHeader = req.headers.authorization ?? "";
  if (!authHeader.startsWith("Bearer ")) return "";
  return authHeader.slice(7).trim();
}

/** In no-auth mode, treat all requests as having full access (no security boundary). */
function hasAdminAccess(auth: { kind: string }): boolean {
  return auth.kind === "admin" || auth.kind === "none";
}

/** Emit a structured audit log line for admin events. */
function auditLog(event: string, fields: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      component: "rest-transport",
      event,
      ...fields,
    })
  );
}

export async function startRestTransport(
  options: RestTransportOptions
): Promise<RestTransportHandle> {
  const {
    port,
    host = "0.0.0.0",
    token,
    baseDir = process.env.STRATA_DATA_DIR ||
      join(process.env.HOME || process.env.USERPROFILE || ".", ".strata"),
    maxAgents = DEFAULT_MAX_AGENTS,
    maxWorlds = DEFAULT_MAX_WORLDS,
  } = options;

  if (token !== undefined && token.length < MIN_ADMIN_TOKEN_LEN) {
    throw new Error(
      `--rest-token must be at least ${MIN_ADMIN_TOKEN_LEN} characters (got ${token.length})`
    );
  }

  const tokenSecret = process.env.STRATA_TOKEN_SECRET ?? DEFAULT_TOKEN_SECRET;
  if (tokenSecret === DEFAULT_TOKEN_SECRET) {
    console.warn(
      "[strata] WARNING: STRATA_TOKEN_SECRET is not set — using insecure dev fallback. Set it in production."
    );
  }

  // Provider resolution: override (from tests) takes precedence, else lazy-load
  // via getExtractionProvider() on first /store+extract request and cache the
  // result for the lifetime of this server instance. null means "unavailable"
  // (no GEMINI_API_KEY and no distill config) — treated as a no-op.
  let cachedExtractionProvider: LlmProvider | null | undefined;
  async function resolveExtractionProvider(): Promise<LlmProvider | null> {
    if (options.extractionProvider !== undefined) return options.extractionProvider;
    if (cachedExtractionProvider === undefined) {
      cachedExtractionProvider = await getExtractionProvider();
    }
    return cachedExtractionProvider;
  }

  mkdirSync(baseDir, { recursive: true });
  const registry = new PlayerRegistry(baseDir);

  // World registry + pool — single instances for the lifetime of this server.
  const worldRegistry = new WorldRegistry(baseDir);
  worldRegistry.ensureDefault();
  const worldPool = new WorldPool(baseDir, maxWorlds);

  // Legacy (non-world-scoped) stores operate against the "default" world DB for backward compat.
  const defaultDb = worldPool.open("default");
  const profileStore = new NpcProfileStore(defaultDb);
  const characterStore = new CharacterStore(defaultDb);
  const relationshipStore = new RelationshipStore(defaultDb);
  const acquaintanceStore = new NpcAcquaintanceStore(defaultDb);

  // ─── Extraction queue + worker ─────────────────────────────────────────
  const queuePath = join(baseDir, "_queue.db");
  const queueStore = new ExtractionQueueStore(queuePath);

  const tenantResolver = new CompositeTenantResolver({
    v2: async (worldId, _agentId, fn) => {
      const worldDb = worldPool.open(worldId);
      return fn({ kind: "v2", worldDb, agentId: _agentId });
    },
    legacy: async (playerId, agentId, fn) => {
      const srv = getOrCreateAgentServer(playerId, agentId);
      return fn({
        kind: "legacy",
        agentId,
        addEntry: async (text, tags, importance) => {
          const factId = randomUUID();
          await srv.storage.knowledge.addEntry({
            id: factId,
            type: "fact",
            project: agentId,
            sessionId: `rest-extract-${Date.now()}`,
            timestamp: Date.now(),
            summary: text,
            details: "",
            tags,
            importance,
            relatedFiles: [],
          });
          return factId;
        },
      });
    },
  });

  const extractionProvider = options.extractionProvider ?? (await getExtractionProvider());
  const extractionWorker = extractionProvider
    ? new ExtractionWorker({
        queue: queueStore,
        provider: extractionProvider,
        tenantResolver,
        logger: (m) => console.warn(m),
      })
    : null;

  if (extractionWorker && process.env.STRATA_EXTRACTION_WORKER !== "0") {
    extractionWorker.start();
    console.warn("[strata] Extraction worker: active");
  } else if (!extractionProvider) {
    console.warn(
      "[strata] Extraction worker: disabled (no LLM provider). " +
        "Set GEMINI_API_KEY or run `strata activate <key>`; " +
        "`extract: true` store requests will be accepted but not processed.",
    );
  }

  // LRU cache of per-(player, npc) createServer() instances, keyed by "<playerId>:<npcId>".
  // Map iteration order = insertion order; re-inserting on access promotes to MRU.
  const agentCache = new Map<string, CacheEntry>();

  function touchCache(entry: CacheEntry): void {
    entry.lastAccess = Date.now();
    agentCache.delete(entry.key);
    agentCache.set(entry.key, entry);
  }

  async function evictLru(): Promise<void> {
    while (agentCache.size > maxAgents) {
      const firstKey = agentCache.keys().next().value;
      if (!firstKey) break;
      const entry = agentCache.get(firstKey);
      if (!entry) break;
      agentCache.delete(firstKey);
      try {
        await entry.srv.storage.close();
      } catch {
        // ignore cleanup errors
      }
    }
  }

  function getOrCreateAgentServer(playerId: string, npcId: string): CreateServerResult {
    const key = cacheKey(playerId, npcId);
    const existing = agentCache.get(key);
    if (existing) {
      touchCache(existing);
      return existing.srv;
    }
    const agentDir = join(baseDir, "players", playerId, "agents", npcId);
    mkdirSync(agentDir, { recursive: true });
    const srv = createServer({ dataDir: agentDir });
    const entry: CacheEntry = { key, playerId, npcId, srv, lastAccess: Date.now() };
    agentCache.set(key, entry);
    void evictLru();
    return srv;
  }

  function closeCacheEntriesForPlayer(playerId: string): Promise<void[]> {
    const toClose: Promise<void>[] = [];
    for (const [key, entry] of agentCache) {
      if (entry.playerId === playerId) {
        agentCache.delete(key);
        toClose.push(entry.srv.storage.close().catch(() => undefined));
      }
    }
    return Promise.all(toClose);
  }

  type AuthKind = "none" | "admin" | "player" | "player-v2";
  interface AuthResult {
    kind: AuthKind;
    player: PlayerEntry | null;
    /** Set when kind === "player-v2" — the verified v2 token claims. */
    v2Claims?: PlayerTokenClaims;
  }

  function authenticate(req: IncomingMessage): AuthResult | null {
    if (!token) {
      // No-auth mode: all data routes to the default player.
      return { kind: "none", player: null };
    }
    const bearer = extractBearer(req);
    if (!bearer) return null;
    if (bearer === token) {
      return { kind: "admin", player: null };
    }
    // Detect v2 HMAC token by prefix.
    if (bearer.startsWith("strata_v2.")) {
      try {
        const claims = verifyPlayerToken(bearer, tokenSecret);
        return { kind: "player-v2", player: null, v2Claims: claims };
      } catch {
        return null; // tampered or wrong secret
      }
    }
    // Legacy pt_ token.
    const player = registry.auth(bearer);
    if (player) {
      return { kind: "player", player };
    }
    return null;
  }

  /** Resolve the playerId used for data-endpoint routing. */
  function resolvePlayerId(auth: AuthResult): string | null {
    if (auth.kind === "none") return DEFAULT_PLAYER_ID;
    if (auth.kind === "player") return auth.player!.playerId;
    if (auth.kind === "player-v2") return auth.v2Claims!.playerId;
    return null; // admin token is not allowed on data endpoints
  }

  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;
    const method = req.method ?? "GET";

    // CORS for game-engine dev tools
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health (unauthenticated)
    if (pathname === "/api/health" && method === "GET") {
      const health = buildHealthResponse();
      json(res, 200, { ...health, agents: agentCache.size });
      return;
    }

    const auth = authenticate(req);
    if (!auth) {
      auditLog("auth.reject", { pathname, reason: "invalid_or_missing_token" });
      json(res, 401, { error: "Unauthorized — invalid or missing bearer token", code: 401 });
      return;
    }

    try {
      // ── World lifecycle endpoints (admin-only) ───────────────────────
      if (pathname === "/api/worlds" && method === "GET") {
        if (!hasAdminAccess(auth)) {
          json(res, 403, { error: "World listing requires the admin token", code: 403 });
          return;
        }
        json(res, 200, { worlds: worldRegistry.list() });
        return;
      }

      if (pathname === "/api/worlds" && method === "POST") {
        if (!hasAdminAccess(auth)) {
          json(res, 403, { error: "World creation requires the admin token", code: 403 });
          return;
        }
        const body = await parseBody(req);
        const worldId = typeof body.worldId === "string" ? body.worldId : "";
        const name = typeof body.name === "string" ? body.name : worldId;
        try {
          const rec = worldRegistry.create(worldId, name);
          auditLog("world.create", { worldId, name });
          json(res, 201, rec);
        } catch (err) {
          const msg = (err as Error).message;
          if (msg.startsWith("world exists")) {
            json(res, 409, { error: msg, code: 409 });
          } else {
            json(res, 400, { error: msg, code: 400 });
          }
        }
        return;
      }

      {
        const worldParams = matchRoute(pathname, method, "/api/worlds/:id", "DELETE");
        if (worldParams) {
          if (!hasAdminAccess(auth)) {
            json(res, 403, { error: "World deletion requires the admin token", code: 403 });
            return;
          }
          try {
            // Close the pool handle first so the DB file is not locked when the directory is removed.
            worldPool.closeWorld(worldParams.id);
            worldRegistry.delete(worldParams.id);
            auditLog("world.delete", { worldId: worldParams.id });
            res.writeHead(204);
            res.end();
          } catch (err) {
            json(res, 404, { error: (err as Error).message, code: 404 });
          }
          return;
        }
      }

      // ── Admin endpoints ─────────────────────────────────────────────
      let params = matchRoute(pathname, method, "/api/players", "POST");
      if (params) {
        if (!hasAdminAccess(auth)) {
          json(res, 403, {
            error: "Admin endpoint requires the admin token — not a player token",
            code: 403,
          });
          return;
        }
        const body = await parseBody(req);
        const externalId = typeof body.externalId === "string" ? body.externalId : null;
        const worldHeader = req.headers["x-strata-world"];
        const worldId = typeof worldHeader === "string" ? worldHeader : null;

        // v2 path: if X-Strata-World header present, issue HMAC token scoped to that world.
        if (worldId !== null) {
          if (!worldRegistry.get(worldId)) {
            json(res, 404, { error: `Unknown world: ${worldId}`, code: 404 });
            return;
          }
          const result = await registry.provision(externalId);
          const v2Token = mintPlayerToken({ playerId: result.playerId, worldId }, tokenSecret);
          auditLog("player.provision.v2", { playerId: result.playerId, worldId, externalId, isNew: result.isNew });
          json(res, 200, {
            playerId: result.playerId,
            playerToken: v2Token,
            worldId,
            externalId: result.externalId,
            createdAt: result.createdAt,
            isNew: result.isNew,
          });
          return;
        }

        // Legacy path: issue pt_ token.
        const result = await registry.provision(externalId);
        auditLog("player.provision", {
          playerId: result.playerId,
          externalId,
          isNew: result.isNew,
        });
        json(res, 200, {
          playerId: result.playerId,
          playerToken: result.playerToken || null, // empty on idempotent re-fetch
          externalId: result.externalId,
          createdAt: result.createdAt,
          isNew: result.isNew,
        });
        return;
      }

      params = matchRoute(pathname, method, "/api/players/:playerId", "GET");
      if (params) {
        if (!hasAdminAccess(auth)) {
          json(res, 403, {
            error: "Admin endpoint requires the admin token",
            code: 403,
          });
          return;
        }
        const entry = registry.get(params.playerId);
        if (!entry) {
          json(res, 404, { error: "Player not found", code: 404 });
          return;
        }
        json(res, 200, {
          playerId: entry.playerId,
          externalId: entry.externalId,
          createdAt: entry.createdAt,
          lastAccess: entry.lastAccess,
          memoryCount: null, // derived on demand; not tracked in registry
          npcCount: null,
        });
        return;
      }

      params = matchRoute(pathname, method, "/api/players/:playerId", "DELETE");
      if (params) {
        if (!hasAdminAccess(auth)) {
          json(res, 403, {
            error: "Admin endpoint requires the admin token",
            code: 403,
          });
          return;
        }
        await closeCacheEntriesForPlayer(params.playerId);
        const removed = registry.remove(params.playerId);
        if (!removed) {
          json(res, 404, { error: "Player not found", code: 404 });
          return;
        }
        const playerDir = join(baseDir, "players", params.playerId);
        try {
          rmSync(playerDir, { recursive: true, force: true });
        } catch (err) {
          auditLog("player.delete.rmdir_error", {
            playerId: params.playerId,
            error: (err as Error).message,
          });
        }
        auditLog("player.delete", { playerId: params.playerId });
        json(res, 200, { deleted: true });
        return;
      }

      // ── Profile endpoint (admin-write) ──────────────────────────────
      // Admin can target a specific world via X-Strata-World header.
      // When header is absent, falls back to "default" world for backward compat.
      {
        const worldHeaderRaw = req.headers["x-strata-world"];
        const adminWorldId = typeof worldHeaderRaw === "string" ? worldHeaderRaw : "default";
        const adminWorldEntry = worldRegistry.get(adminWorldId);
        const adminProfileStore = adminWorldEntry
          ? new NpcProfileStore(worldPool.open(adminWorldId))
          : profileStore;

        params = matchRoute(pathname, method, "/api/agents/:agentId/profile", "PUT");
        if (params) {
          if (!hasAdminAccess(auth)) {
            json(res, 403, { error: "Profile write requires the admin token", code: 403 });
            return;
          }
          if (!adminWorldEntry) {
            json(res, 404, { error: `Unknown world: ${adminWorldId}`, code: 404 });
            return;
          }
          const body = await parseBody(req);
          try {
            const profile = adminProfileStore.put(params.agentId, body);
            auditLog("profile.update", { npcId: params.agentId, worldId: adminWorldId });
            json(res, 200, { updated: true, npcId: params.agentId, profile });
          } catch (err) {
            json(res, 422, { error: (err as Error).message, code: 422 });
          }
          return;
        }

        // ── Profile read (player OR admin) ──────────────────────────────
        params = matchRoute(pathname, method, "/api/agents/:agentId/profile", "GET");
        if (params) {
          const profile = adminProfileStore.get(params.agentId);
          let memoryCount = 0;
          let lastInteraction: number | null = null;
          const pid = resolvePlayerId(auth);
          if (pid) {
            try {
              const srv = getOrCreateAgentServer(pid, params.agentId);
              const all = await srv.storage.knowledge.search("");
              memoryCount = all.length;
              lastInteraction = all.length > 0 ? Math.max(...all.map((r) => r.timestamp)) : null;
            } catch { /* ignore */ }
          }
          json(res, 200, {
            agent_id: params.agentId,
            ...(profile ?? {}),
            memory_count: memoryCount,
            last_interaction: lastInteraction,
          });
          return;
        }
      } // end admin-world-scoped profile block

      // ── Character card (player writes own, admin writes any) ─────────
      params = matchRoute(pathname, method, "/api/players/:playerId/character", "PUT");
      if (params) {
        const pid = resolvePlayerId(auth);
        const isPlayer = auth.kind === "player" || auth.kind === "player-v2";
        if (isPlayer && pid !== params.playerId) {
          json(res, 403, { error: "Players can only update their own character card", code: 403 });
          return;
        }
        if (!hasAdminAccess(auth) && !isPlayer) {
          json(res, 403, { error: "Character card write requires a player or admin token", code: 403 });
          return;
        }
        const body = await parseBody(req);
        const card = characterStore.write(params.playerId, body);
        json(res, 200, { playerId: params.playerId, ...card });
        return;
      }

      params = matchRoute(pathname, method, "/api/players/:playerId/character", "GET");
      if (params) {
        const pid = resolvePlayerId(auth);
        const isPlayer = auth.kind === "player" || auth.kind === "player-v2";
        if (isPlayer && pid !== params.playerId) {
          json(res, 403, { error: "Players can only read their own character card", code: 403 });
          return;
        }
        if (!hasAdminAccess(auth) && !isPlayer) {
          json(res, 403, { error: "Character card read requires a player or admin token", code: 403 });
          return;
        }
        const card = characterStore.read(params.playerId);
        json(res, 200, { playerId: params.playerId, ...card });
        return;
      }

      // ── Data endpoints ──────────────────────────────────────────────
      const playerId = resolvePlayerId(auth);
      if (playerId === null) {
        json(res, 403, {
          error: "Admin token cannot access data endpoints — use a player token",
          code: 403,
        });
        return;
      }
      if (auth.kind === "player") registry.touch(auth.player!.playerId);
      if (auth.kind === "player-v2") registry.touch(auth.v2Claims!.playerId);

      // v2 path: resolve world-scoped stores from token's worldId claim.
      // If the world was deleted after the token was issued → 403.
      let activeProfileStore = profileStore;
      let activeCharacterStore = characterStore;
      let activeRelationshipStore = relationshipStore;
      let activeAcquaintanceStore = acquaintanceStore;
      // For v2 tokens, NPC memories are world-scoped (shared across all PCs in the world).
      // null means fall back to per-player KnowledgeStore (legacy/no-auth path).
      let activeWorldDb: import("better-sqlite3").Database | null = null;
      if (auth.kind === "player-v2") {
        const claimedWorldId = auth.v2Claims!.worldId;
        if (!worldRegistry.get(claimedWorldId)) {
          json(res, 403, { error: `World '${claimedWorldId}' no longer exists`, code: 403 });
          return;
        }
        const worldDb = worldPool.open(claimedWorldId);
        activeWorldDb = worldDb;
        activeProfileStore = new NpcProfileStore(worldDb);
        activeCharacterStore = new CharacterStore(worldDb);
        activeRelationshipStore = new RelationshipStore(worldDb);
        activeAcquaintanceStore = new NpcAcquaintanceStore(worldDb);
      }

      params = matchRoute(pathname, method, "/api/agents/:agentId/store", "POST");
      if (params) {
        const body = await parseBody(req);
        let result: { id: string; stored: boolean };

        if (activeWorldDb !== null) {
          // v2 world-scoped path: NPC memories live in world.db (shared across all PCs).
          const memory = body.memory;
          if (typeof memory !== "string" || memory.length < 5) {
            json(res, 400, { error: "Missing required field: memory (string, min 5 chars)", code: 400 });
            return;
          }
          const storeTags = Array.isArray(body.tags)
            ? (body.tags as unknown[]).filter((t): t is string => typeof t === "string")
            : [];
          const importance = typeof body.importance === "number" ? body.importance : 50;
          const engine = new NpcMemoryEngine(activeWorldDb, params.agentId);
          const id = engine.add({ content: memory, tags: storeTags, importance });
          result = { id, stored: true };

          // Tag-rule side effect: compute trust delta and record per-player observation.
          // Always record when tags are present — familiarity is an interaction count,
          // not a trust-change count. Even dialogue-tagged stores (delta.trust=0) must
          // increment familiarity so returning players are recognised across restarts.
          if (storeTags.length > 0) {
            const profile = activeProfileStore.get(params.agentId);
            const delta = profile?.alignment
              ? computeTrustDelta(storeTags, profile.alignment, profile.tagRules as TagRuleOverrides | null | undefined)
              : { trust: 0 };
            const anchorOutcome = profile?.alignment
              ? computeAnchorOutcome(storeTags, profile.tagRules as Record<string, ExtendedTagRule> | null | undefined)
              : { shouldPromote: false, shouldBreak: false, minAnchorDepth: 0 };
            const character = activeCharacterStore.read(playerId);
            activeRelationshipStore.addObservation(
              playerId, params.agentId,
              { event: `auto:${storeTags[0]}`, timestamp: Date.now(), tags: storeTags, delta, source: "tag-rule" },
              profile ?? null,
              character,
              anchorOutcome
            );
          }
        } else {
          // Legacy per-player path.
          const srv = getOrCreateAgentServer(playerId, params.agentId);
          result = await handleStore(params.agentId, body, srv);

          const storeTags = Array.isArray(body.tags)
            ? (body.tags as unknown[]).filter((t): t is string => typeof t === "string")
            : [];
          // Always record when tags are present — familiarity is an interaction count,
          // not a trust-change count.
          if (storeTags.length > 0) {
            const profile = activeProfileStore.get(params.agentId);
            const delta = profile?.alignment
              ? computeTrustDelta(storeTags, profile.alignment, profile.tagRules as TagRuleOverrides | null | undefined)
              : { trust: 0 };
            const anchorOutcome = profile?.alignment
              ? computeAnchorOutcome(storeTags, profile.tagRules as Record<string, ExtendedTagRule> | null | undefined)
              : { shouldPromote: false, shouldBreak: false, minAnchorDepth: 0 };
            const character = activeCharacterStore.read(playerId);
            activeRelationshipStore.addObservation(
              playerId, params.agentId,
              { event: `auto:${storeTags[0]}`, timestamp: Date.now(), tags: storeTags, delta, source: "tag-rule" },
              profile ?? null,
              character,
              anchorOutcome
            );
          }
        }

        // Extraction pass — opt-in via body.extract === true.
        // Enqueues job; worker processes async. Returns in <100ms.
        const extractEnabled = process.env.STRATA_REST_EXTRACT_ENABLED !== "false";
        if (extractEnabled && body.extract === true && extractionWorker !== null) {
          const userTags = Array.isArray(body.tags)
            ? (body.tags as unknown[]).filter((t): t is string => typeof t === "string")
            : [];
          const memoryStr = typeof body.memory === "string" ? body.memory : "";
          const tenantId = activeWorldDb !== null
            ? `v2:${auth.v2Claims!.worldId}`
            : `legacy:${playerId}`;
          queueStore.enqueue({
            tenantId,
            agentId: params.agentId,
            memoryId: result.id,
            text: memoryStr,
            userTags,
            importance: typeof body.importance === "number" ? body.importance : undefined,
          });
          json(res, 200, { ...result, extractionQueued: true });
          return;
        }

        json(res, 200, result);
        return;
      }

      params = matchRoute(pathname, method, "/api/agents/:agentId/search", "POST");
      if (params) {
        const body = await parseBody(req);
        const npcProfile = activeProfileStore.get(params.agentId);

        if (activeWorldDb !== null) {
          // v2 world-scoped path: search world.db npc_memories.
          const query = body.query;
          if (typeof query !== "string" || query.length === 0) {
            json(res, 400, { error: "Missing required field: query", code: 400 });
            return;
          }
          const limit = typeof body.limit === "number" ? Math.min(body.limit, 100) : 20;
          const engine = new NpcMemoryEngine(activeWorldDb, params.agentId);
          const memories = engine.search(query);
          const limited = memories.slice(0, limit);
          const results = limited.map((m) => ({
            id: m.id,
            text: m.content,
            type: "fact" as const,
            confidence: m.importance / 100,
            source: "world-fts5" as const,
            tags: m.tags,
          }));
          json(res, 200, { results });
        } else {
          // Legacy per-player path.
          const relData = activeRelationshipStore.get(playerId, params.agentId, npcProfile, activeCharacterStore.read(playerId));
          const srv = getOrCreateAgentServer(playerId, params.agentId);
          const result = await handleSearch(body, srv, npcProfile, relData.anchor?.depth ?? 0);
          json(res, 200, result);
        }
        return;
      }

      params = matchRoute(pathname, method, "/api/agents/:agentId/recall", "POST");
      if (params) {
        const body = await parseBody(req);
        const npcProfile = activeProfileStore.get(params.agentId);
        const relData = activeRelationshipStore.get(playerId, params.agentId, npcProfile, activeCharacterStore.read(playerId));

        if (activeWorldDb !== null) {
          // v2 world-scoped path: recall from world.db npc_memories (shared NPC memory).
          const situation = body.situation;
          if (typeof situation !== "string" || situation.length === 0) {
            json(res, 400, { error: "Missing required field: situation", code: 400 });
            return;
          }
          const limit = typeof body.limit === "number" ? Math.min(body.limit, 50) : 10;
          const engine = new NpcMemoryEngine(activeWorldDb, params.agentId);
          const memories = engine.search(situation);
          const limited = memories.slice(0, limit);
          const context = limited.map((m) => ({
            text: m.content,
            type: "fact" as const,
            confidence: m.importance / 100,
            source: "world-fts5" as const,
            tags: m.tags,
          }));
          const topFacts = context.slice(0, 3).map((r) => r.text).join(". ");
          json(res, 200, { context, summary: topFacts || "No relevant memories found." });
        } else {
          // Legacy per-player path.
          const srv = getOrCreateAgentServer(playerId, params.agentId);
          const result = await handleRecall(params.agentId, body, srv, npcProfile, relData.anchor?.depth ?? 0);
          json(res, 200, result);
        }
        return;
      }

      params = matchRoute(pathname, method, "/api/agents/:agentId/ingest", "POST");
      if (params) {
        const body = await parseBody(req);
        const srv = getOrCreateAgentServer(playerId, params.agentId);
        const result = await handleIngest(params.agentId, body, srv);
        json(res, 200, result);
        return;
      }

      params = matchRoute(pathname, method, "/api/agents/:agentId/relationship", "GET");
      if (params) {
        const profile = activeProfileStore.get(params.agentId);
        const character = activeCharacterStore.read(playerId);
        const result = activeRelationshipStore.get(playerId, params.agentId, profile, character);
        json(res, 200, result);
        return;
      }

      params = matchRoute(pathname, method, "/api/agents/:agentId/relationship/observe", "POST");
      if (params) {
        const body = await parseBody(req);
        const event = typeof body.event === "string" ? body.event : "unknown";
        const tags = Array.isArray(body.tags)
          ? (body.tags as unknown[]).filter((t): t is string => typeof t === "string")
          : [];

        const profile = activeProfileStore.get(params.agentId);
        const character = activeCharacterStore.read(playerId);
        const alignment: NpcAlignment = profile?.alignment ?? { ethical: "neutral" as const, moral: "neutral" as const };

        const delta = computeTrustDelta(tags, alignment, profile?.tagRules as TagRuleOverrides | null | undefined);
        const anchorOutcome = computeAnchorOutcome(tags, profile?.tagRules as Record<string, ExtendedTagRule> | null | undefined);
        const observation = {
          event,
          timestamp: Date.now(),
          tags,
          delta,
          source: "manual" as const,
        };
        const result = activeRelationshipStore.addObservation(
          playerId, params.agentId, observation, profile, character, anchorOutcome
        );
        json(res, 200, result);
        return;
      }

      // PUT /anchor — admin-only explicit anchor control
      params = matchRoute(pathname, method, "/api/agents/:agentId/anchor", "PUT");
      if (params) {
        if (!hasAdminAccess(auth)) {
          json(res, 403, { error: "Anchor write requires the admin token", code: 403 });
          return;
        }
        const body = await parseBody(req);
        const state = typeof body.state === "string" ? body.state : "none";
        const depth = typeof body.depth === "number" ? body.depth : 0;
        const targetPlayer = typeof body.playerId === "string" ? body.playerId : DEFAULT_PLAYER_ID;

        if (!["friend", "rival", "none"].includes(state)) {
          json(res, 422, { error: "state must be friend, rival, or none", code: 422 });
          return;
        }

        const pid = auth.kind === "none" ? DEFAULT_PLAYER_ID : targetPlayer;
        const profile = activeProfileStore.get(params.agentId);
        const character = activeCharacterStore.read(pid);
        const result = activeRelationshipStore.setAnchor(
          pid,
          params.agentId,
          state as "friend" | "rival" | "none",
          depth,
          profile,
          character
        );
        json(res, 200, result);
        return;
      }

      params = matchRoute(pathname, method, "/api/agents/:agentId/memory/:memoryId", "DELETE");
      if (params) {
        const srv = getOrCreateAgentServer(playerId, params.agentId);
        const result = await handleDelete(params.memoryId, srv);
        json(res, 200, result);
        return;
      }

      params = matchRoute(pathname, method, "/api/agents/:agentId/training", "POST");
      if (params) {
        const body = await parseBody(req);
        const srv = getOrCreateAgentServer(playerId, params.agentId);
        const result = await handleTraining(body, srv);
        json(res, 200, result);
        return;
      }

      if (pathname === "/api/interactions" && method === "POST") {
        const body = await parseBody(req);
        const npcA = typeof body.npcA === "string" ? body.npcA : "";
        const npcB = typeof body.npcB === "string" ? body.npcB : "";
        if (!npcA || !npcB) {
          json(res, 400, { error: "npcA and npcB are required", code: 400 });
          return;
        }
        if (npcA === npcB) {
          json(res, 400, { error: "npcA and npcB must differ", code: 400 });
          return;
        }
        const seed = typeof body.seed === "number" ? body.seed : Math.floor(Math.random() * 0xffffffff);

        const profileA = activeProfileStore.get(npcA);
        const profileB = activeProfileStore.get(npcB);

        if (!profileA || !profileB) {
          json(res, 200, { disclosures: [], seed });
          return;
        }

        const propagateTags = profileA.propagateTags ?? [];
        const trait: GossipTrait = profileA.gossipTrait ?? "normal";

        // A's acquaintance trust toward B (listener trust, for roll bonus)
        const ack = activeAcquaintanceStore.get(npcA, npcB);
        const trustListener = ack?.trust ?? 50;

        // Update interaction counts for both directions
        activeAcquaintanceStore.recordInteraction(npcA, npcB);
        activeAcquaintanceStore.recordInteraction(npcB, npcA);

        const disclosures: unknown[] = [];

        if (propagateTags.length > 0) {
          // v2 world-scoped path: NPC memories live in world.db (shared across PCs).
          // Legacy path: per-player KnowledgeStore.
          const useWorldMemory = activeWorldDb !== null;

          interface MemoryLike {
            id: string;
            type: string;
            content: string;
            tags: string[];
          }

          let allMemories: MemoryLike[];
          if (useWorldMemory) {
            const engineA = new NpcMemoryEngine(activeWorldDb!, npcA);
            allMemories = engineA.getAll().map((m) => ({
              id: m.id,
              type: "fact",
              content: m.content,
              tags: m.tags,
            }));
          } else {
            const srvA = getOrCreateAgentServer(playerId, npcA);
            const raw = await srvA.storage.knowledge.getProjectEntries(npcA);
            allMemories = raw.map((m) => ({
              id: m.id,
              type: m.type,
              content: m.summary,
              tags: Array.isArray(m.tags) ? m.tags : (typeof m.tags === "string" ? JSON.parse(m.tags) : []),
            }));
          }

          let rollSeed = seed;
          for (const mem of allMemories) {
            const memTags: string[] = mem.tags;
            const alreadyHearsay = memTags.some((t: string) => t.startsWith("heard-from-"));

            const outcome = rollDisclosure({
              discloserTrait: trait,
              discloserTrustToListener: trustListener,
              // TODO: derive from NPC subject-relationship model when that ships (v2)
              discloserTrustToSubject: 50, // no subject model in v1 — midpoint
              memoryTags: memTags,
              propagateTags,
              alreadyHearsay,
              seed: rollSeed,
            });
            // Advance the roll seed deterministically so distinct memories roll distinctly
            // within one interaction — but the whole sequence is still reproducible.
            rollSeed = (Math.imul(rollSeed, 1664525) + 1013904223) >>> 0;

            if (outcome.reason) continue; // skip non-propagable memories silently

            if (outcome.disclosed) {
              const newTags = [...memTags, `heard-from-${npcA}`];
              if (useWorldMemory) {
                const engineB = new NpcMemoryEngine(activeWorldDb!, npcB);
                engineB.add({ content: mem.content, tags: newTags, importance: 50 });
              } else {
                const srvB = getOrCreateAgentServer(playerId, npcB);
                await srvB.storage.knowledge.addEntry({
                  id: randomUUID(),
                  type: "fact",
                  project: npcB,
                  sessionId: `gossip-${Date.now()}`,
                  timestamp: Date.now(),
                  summary: mem.content,
                  details: "",
                  tags: newTags,
                  relatedFiles: [],
                });
              }
              disclosures.push({
                memoryId: mem.id,
                from: npcA,
                to: npcB,
                roll: outcome.roll,
                dc: outcome.dc,
                modifiers: outcome.modifiers,
                result: "disclosed",
              });
            } else {
              disclosures.push({
                memoryId: mem.id,
                from: npcA,
                to: npcB,
                roll: outcome.roll,
                dc: outcome.dc,
                modifiers: outcome.modifiers,
                result: "kept",
              });
            }
          }
        }

        json(res, 200, { disclosures, seed });
        return;
      }

      json(res, 404, { error: "Not found", code: 404 });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal server error";
      console.error(`[REST] ${method} ${pathname}: ${message}`);
      const isClientError = message.includes("Missing required") || message.includes("Invalid");
      json(res, isClientError ? 400 : 500, {
        error: message,
        code: isClientError ? 400 : 500,
      });
    }
  });

  return new Promise((resolve) => {
    httpServer.listen(port, host, () => {
      const addr = httpServer.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      console.log(`Strata REST API listening on http://${host}:${actualPort}`);
      resolve({
        server: httpServer,
        port: actualPort,
        close: async () => {
          if (extractionWorker) await extractionWorker.stop();
          queueStore.close();
          for (const [, entry] of agentCache) {
            try {
              await entry.srv.storage.close();
            } catch {
              // ignore
            }
          }
          agentCache.clear();
          registry.close();
          worldPool.close();
          return new Promise<void>((res) => httpServer.close(() => res()));
        },
      });
    });
  });
}

// ── Data endpoint handlers (accept CreateServerResult, not baseDir) ─────

async function handleStore(
  agentId: string,
  body: Record<string, unknown>,
  srv: CreateServerResult
): Promise<{ id: string; stored: boolean }> {
  const memory = body.memory;
  if (typeof memory !== "string" || memory.length < 5) {
    throw new Error("Missing required field: memory (string, min 5 chars)");
  }
  const rawType = typeof body.type === "string" ? body.type : "fact";
  const type: KnowledgeType = (KNOWLEDGE_TYPES as readonly string[]).includes(rawType)
    ? (rawType as KnowledgeType)
    : "fact";
  const tags = Array.isArray(body.tags)
    ? body.tags.filter((t): t is string => typeof t === "string")
    : [];

  const id = randomUUID();
  await srv.storage.knowledge.addEntry({
    id,
    type,
    project: agentId,
    sessionId: `rest-${Date.now()}`,
    timestamp: Date.now(),
    summary: memory,
    details: typeof body.details === "string" ? body.details : "",
    tags,
    relatedFiles: [],
  });
  return { id, stored: true };
}

async function handleSearch(
  body: Record<string, unknown>,
  srv: CreateServerResult,
  npcProfile?: NpcProfile | null,
  anchorDepth?: number
): Promise<{ results: unknown[] }> {
  const query = body.query;
  if (typeof query !== "string" || query.length === 0) {
    throw new Error("Missing required field: query");
  }
  const limit = typeof body.limit === "number" ? Math.min(body.limit, 100) : 20;

  // Resolve decay profile for memory retention scoring
  const decayProf = npcProfile ? resolveProfile(
    npcProfile.decayProfile,
    npcProfile.decayConfig as Partial<import("./decay-engine.js").DecayProfile> | undefined
  ) : resolveProfile();
  const now = Date.now();
  const depth = anchorDepth ?? 0;

  // Try hybrid retrieval (FTS5 + vector + RRF) via semanticBridge
  const bridgeResults = await srv.semanticBridge.search(query, { limit });
  if (bridgeResults && bridgeResults.length > 0) {
    const mapped = bridgeResults.map((r) => {
      const ts = r.timestamp ?? 0;
      const ageDays = ts > 0 ? (now - ts) / 86_400_000 : 0;
      const retention = memoryRetention(ageDays, 0, decayProf, depth);
      return {
        id: "",
        text: r.text ?? "",
        type: "fact",
        confidence: (r.score ?? r.confidence ?? 1.0) * retention,
        source: "hybrid",
        timestamp: ts,
        tags: [],
      };
    });
    mapped.sort((a, b) => b.confidence - a.confidence);
    return { results: mapped };
  }

  // Fallback to BM25 via KnowledgeStore
  const results = await srv.storage.knowledge.search(query);
  const limited = results.slice(0, limit);
  const mapped = limited.map((r) => {
    const ageDays = r.timestamp > 0 ? (now - r.timestamp) / 86_400_000 : 0;
    const retention = memoryRetention(ageDays, 0, decayProf, depth);
    return {
      id: r.id,
      text: r.summary,
      type: r.type,
      confidence: 1.0 * retention,
      source: "fts5",
      timestamp: r.timestamp,
      tags: typeof r.tags === "string" ? JSON.parse(r.tags) : r.tags,
    };
  });
  mapped.sort((a, b) => b.confidence - a.confidence);
  return { results: mapped };
}

async function handleRecall(
  _agentId: string,
  body: Record<string, unknown>,
  srv: CreateServerResult,
  npcProfile?: NpcProfile | null,
  anchorDepth?: number
): Promise<{ context: unknown[]; summary: string }> {
  const situation = body.situation;
  if (typeof situation !== "string" || situation.length === 0) {
    throw new Error("Missing required field: situation");
  }
  const limit = typeof body.limit === "number" ? Math.min(body.limit, 50) : 10;

  // Resolve decay profile for memory retention scoring
  const decayProf = npcProfile ? resolveProfile(
    npcProfile.decayProfile,
    npcProfile.decayConfig as Partial<import("./decay-engine.js").DecayProfile> | undefined
  ) : resolveProfile();
  const now = Date.now();
  const depth = anchorDepth ?? 0;

  // Try hybrid retrieval (FTS5 + vector + RRF) via semanticBridge
  const bridgeResults = await srv.semanticBridge.search(situation, { limit });
  if (bridgeResults && bridgeResults.length > 0) {
    const context = bridgeResults.map((r) => {
      const ts = r.timestamp ?? 0;
      const ageDays = ts > 0 ? (now - ts) / 86_400_000 : 0;
      const retention = memoryRetention(ageDays, 0, decayProf, depth);
      return {
        text: r.text ?? "",
        type: "fact" as const,
        confidence: (r.score ?? r.confidence ?? 1.0) * retention,
        source: "hybrid" as const,
      };
    });
    context.sort((a, b) => b.confidence - a.confidence);
    const topFacts = context
      .slice(0, 3)
      .map((r) => r.text)
      .join(". ");
    return { context, summary: topFacts || "No relevant memories found." };
  }

  // Fallback to BM25 via KnowledgeStore
  const results = await srv.storage.knowledge.search(situation);
  const limited = results.slice(0, limit);
  const context = limited.map((r) => {
    const ageDays = r.timestamp > 0 ? (now - r.timestamp) / 86_400_000 : 0;
    const retention = memoryRetention(ageDays, 0, decayProf, depth);
    return {
      text: r.summary,
      type: r.type,
      confidence: 1.0 * retention,
      source: "fts5" as const,
    };
  });
  context.sort((a, b) => b.confidence - a.confidence);
  const topFacts = context.slice(0, 3).map((r) => r.text).join(". ");
  return { context, summary: topFacts || "No relevant memories found." };
}

async function handleIngest(
  agentId: string,
  body: Record<string, unknown>,
  srv: CreateServerResult
): Promise<{ document_id: string; chunks: number; indexed: boolean }> {
  const title = body.title;
  const content = body.content;
  if (typeof title !== "string" || typeof content !== "string") {
    throw new Error("Missing required fields: title, content");
  }
  const docId = randomUUID();
  await srv.storage.knowledge.addEntry({
    id: docId,
    type: "fact",
    project: agentId,
    sessionId: `ingest-${Date.now()}`,
    timestamp: Date.now(),
    summary: title,
    details: content,
    tags: Array.isArray(body.tags)
      ? body.tags.filter((t): t is string => typeof t === "string")
      : [],
    relatedFiles: [],
  });
  return { document_id: docId, chunks: 1, indexed: true };
}

async function handleProfile(
  agentId: string,
  srv: CreateServerResult
): Promise<{ agent_id: string; memory_count: number; last_interaction: number | null }> {
  const all = await srv.storage.knowledge.search("");
  const latest = all.length > 0 ? Math.max(...all.map((r) => r.timestamp)) : null;
  return { agent_id: agentId, memory_count: all.length, last_interaction: latest };
}

async function handleDelete(
  memoryId: string,
  srv: CreateServerResult
): Promise<{ deleted: boolean }> {
  await srv.storage.knowledge.deleteEntry(memoryId);
  return { deleted: true };
}

async function handleTraining(
  body: Record<string, unknown>,
  srv: CreateServerResult
): Promise<{ stored: boolean; task_type: string; total_pairs: number }> {
  const input = body.input;
  const output = body.output;
  if (typeof input !== "string" || typeof output !== "string") {
    throw new Error("Missing required fields: input, output");
  }
  const model = typeof body.model === "string" ? body.model : "unknown";
  const quality = typeof body.quality === "number" ? body.quality : 0.8;

  const { saveTrainingPair, getTrainingDataCount } = await import(
    "../extensions/llm-extraction/training-capture.js"
  );

  const indexManager = (srv as { indexManager?: { db?: unknown } }).indexManager;
  if (!indexManager?.db) {
    throw new Error("Training capture requires SQLite storage (not available in D1 mode)");
  }

  saveTrainingPair(indexManager.db as never, {
    taskType: "dialogue",
    inputText: input,
    outputJson: output,
    modelUsed: model,
    qualityScore: quality,
    heuristicDiverged: false,
  });

  const counts = getTrainingDataCount(indexManager.db as never);
  return { stored: true, task_type: "dialogue", total_pairs: counts.dialogue };
}
