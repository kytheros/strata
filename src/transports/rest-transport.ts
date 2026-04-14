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

const DEFAULT_PLAYER_ID = "default";
const MIN_ADMIN_TOKEN_LEN = 32;
const DEFAULT_MAX_AGENTS = 200;

export interface RestTransportOptions {
  port: number;
  host?: string;
  /** Admin bearer token. If unset, auth is disabled (local dev convenience). */
  token?: string;
  /** Base directory for per-player databases. Defaults to STRATA_DATA_DIR or ~/.strata */
  baseDir?: string;
  /** Max per-(player, agent) servers in the LRU cache. Defaults to 200. */
  maxAgents?: number;
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
  } = options;

  if (token !== undefined && token.length < MIN_ADMIN_TOKEN_LEN) {
    throw new Error(
      `--rest-token must be at least ${MIN_ADMIN_TOKEN_LEN} characters (got ${token.length})`
    );
  }

  mkdirSync(baseDir, { recursive: true });
  const registry = new PlayerRegistry(baseDir);
  const profileStore = new NpcProfileStore(baseDir);
  const characterStore = new CharacterStore(baseDir);
  const relationshipStore = new RelationshipStore(baseDir);

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

  type AuthKind = "none" | "admin" | "player";
  interface AuthResult {
    kind: AuthKind;
    player: PlayerEntry | null;
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
      params = matchRoute(pathname, method, "/api/agents/:agentId/profile", "PUT");
      if (params) {
        if (!hasAdminAccess(auth)) {
          json(res, 403, { error: "Profile write requires the admin token", code: 403 });
          return;
        }
        const body = await parseBody(req);
        try {
          const profile = profileStore.write(params.agentId, body);
          auditLog("profile.update", { npcId: params.agentId });
          json(res, 200, { updated: true, npcId: params.agentId, profile });
        } catch (err) {
          json(res, 422, { error: (err as Error).message, code: 422 });
        }
        return;
      }

      // ── Profile read (player OR admin) ──────────────────────────────
      params = matchRoute(pathname, method, "/api/agents/:agentId/profile", "GET");
      if (params) {
        const profile = profileStore.read(params.agentId);
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

      // ── Character card (player writes own, admin writes any) ─────────
      params = matchRoute(pathname, method, "/api/players/:playerId/character", "PUT");
      if (params) {
        const pid = resolvePlayerId(auth);
        if (auth.kind === "player" && pid !== params.playerId) {
          json(res, 403, { error: "Players can only update their own character card", code: 403 });
          return;
        }
        if (!hasAdminAccess(auth) && auth.kind !== "player") {
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
        if (auth.kind === "player" && pid !== params.playerId) {
          json(res, 403, { error: "Players can only read their own character card", code: 403 });
          return;
        }
        if (!hasAdminAccess(auth) && auth.kind !== "player") {
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

      params = matchRoute(pathname, method, "/api/agents/:agentId/store", "POST");
      if (params) {
        const body = await parseBody(req);
        const srv = getOrCreateAgentServer(playerId, params.agentId);
        const result = await handleStore(params.agentId, body, srv);

        // Tag-rule side effect: if tags are present and an NPC profile
        // exists, compute trust delta and anchor outcome, then record observation.
        const storeTags = Array.isArray(body.tags)
          ? (body.tags as unknown[]).filter((t): t is string => typeof t === "string")
          : [];
        if (storeTags.length > 0) {
          const profile = profileStore.read(params.agentId);
          if (profile?.alignment) {
            const delta = computeTrustDelta(storeTags, profile.alignment, profile.tagRules as TagRuleOverrides | null | undefined);
            const anchorOutcome = computeAnchorOutcome(storeTags, profile.tagRules as Record<string, ExtendedTagRule> | null | undefined);
            if (delta.trust !== 0 || anchorOutcome.shouldPromote || anchorOutcome.shouldBreak) {
              const character = characterStore.read(playerId);
              relationshipStore.addObservation(
                playerId, params.agentId,
                {
                  event: `auto:${storeTags[0]}`,
                  timestamp: Date.now(),
                  tags: storeTags,
                  delta,
                  source: "tag-rule",
                },
                profile,
                character,
                anchorOutcome
              );
            }
          }
        }

        json(res, 200, result);
        return;
      }

      params = matchRoute(pathname, method, "/api/agents/:agentId/search", "POST");
      if (params) {
        const body = await parseBody(req);
        const srv = getOrCreateAgentServer(playerId, params.agentId);
        const npcProfile = profileStore.read(params.agentId);
        const relData = relationshipStore.get(playerId, params.agentId, npcProfile, characterStore.read(playerId));
        const result = await handleSearch(body, srv, npcProfile, relData.anchor?.depth ?? 0);
        json(res, 200, result);
        return;
      }

      params = matchRoute(pathname, method, "/api/agents/:agentId/recall", "POST");
      if (params) {
        const body = await parseBody(req);
        const srv = getOrCreateAgentServer(playerId, params.agentId);
        const npcProfile = profileStore.read(params.agentId);
        const relData = relationshipStore.get(playerId, params.agentId, npcProfile, characterStore.read(playerId));
        const result = await handleRecall(params.agentId, body, srv, npcProfile, relData.anchor?.depth ?? 0);
        json(res, 200, result);
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
        const profile = profileStore.read(params.agentId);
        const character = characterStore.read(playerId);
        const result = relationshipStore.get(playerId, params.agentId, profile, character);
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

        const profile = profileStore.read(params.agentId);
        const character = characterStore.read(playerId);
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
        const result = relationshipStore.addObservation(
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
        const profile = profileStore.read(params.agentId);
        const character = characterStore.read(pid);
        const result = relationshipStore.setAnchor(
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
          for (const [, entry] of agentCache) {
            try {
              await entry.srv.storage.close();
            } catch {
              // ignore
            }
          }
          agentCache.clear();
          registry.close();
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
