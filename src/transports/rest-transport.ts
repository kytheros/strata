/**
 * REST transport for the Strata server.
 *
 * Provides a simple HTTP REST API for game engines and non-MCP consumers.
 * Agent-generic vocabulary (/api/agents/:agentId/...) with bearer token auth.
 * Each agentId maps to an isolated Strata database via the multi-tenant pool.
 */

import { createServer as createHttpServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { buildHealthResponse } from "./health.js";
import { createServer, type CreateServerResult } from "../server.js";
import { KNOWLEDGE_TYPES, type KnowledgeType } from "../knowledge/knowledge-store.js";

export interface RestTransportOptions {
  port: number;
  host?: string;
  /** Bearer token for auth. If unset, auth is disabled (local dev convenience). */
  token?: string;
  /** Base directory for per-agent databases. Defaults to STRATA_DATA_DIR or ~/.strata */
  baseDir?: string;
}

export interface RestTransportHandle {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

/** Per-agent server cache (LRU-style, keyed by agentId) */
const agentServers = new Map<string, CreateServerResult>();

function getOrCreateAgentServer(agentId: string, baseDir: string): CreateServerResult {
  let entry = agentServers.get(agentId);
  if (entry) return entry;

  const agentDir = join(baseDir, agentId);
  mkdirSync(agentDir, { recursive: true });
  entry = createServer({ dataDir: agentDir });
  agentServers.set(agentId, entry);
  return entry;
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
      } catch (err) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
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

export async function startRestTransport(
  options: RestTransportOptions
): Promise<RestTransportHandle> {
  const {
    port,
    host = "0.0.0.0",
    token,
    baseDir = process.env.STRATA_DATA_DIR || join(
      process.env.HOME || process.env.USERPROFILE || ".",
      ".strata"
    ),
  } = options;

  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;
    const method = req.method ?? "GET";

    // CORS headers for game engine dev tools
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health endpoint (no auth required)
    if (pathname === "/api/health" && method === "GET") {
      const health = buildHealthResponse();
      json(res, 200, { ...health, agents: agentServers.size });
      return;
    }

    // Auth check (skip if no token configured)
    if (token) {
      const authHeader = req.headers.authorization ?? "";
      const bearerToken = authHeader.startsWith("Bearer ")
        ? authHeader.slice(7).trim()
        : "";
      if (bearerToken !== token) {
        json(res, 401, { error: "Unauthorized — invalid or missing bearer token", code: 401 });
        return;
      }
    }

    try {
      // Route: POST /api/agents/:agentId/store
      let params = matchRoute(pathname, method, "/api/agents/:agentId/store", "POST");
      if (params) {
        const body = await parseBody(req);
        const result = await handleStore(params.agentId, body, baseDir);
        json(res, 200, result);
        return;
      }

      // Route: POST /api/agents/:agentId/search
      params = matchRoute(pathname, method, "/api/agents/:agentId/search", "POST");
      if (params) {
        const body = await parseBody(req);
        const result = await handleSearch(params.agentId, body, baseDir);
        json(res, 200, result);
        return;
      }

      // Route: POST /api/agents/:agentId/recall
      params = matchRoute(pathname, method, "/api/agents/:agentId/recall", "POST");
      if (params) {
        const body = await parseBody(req);
        const result = await handleRecall(params.agentId, body, baseDir);
        json(res, 200, result);
        return;
      }

      // Route: POST /api/agents/:agentId/ingest
      params = matchRoute(pathname, method, "/api/agents/:agentId/ingest", "POST");
      if (params) {
        const body = await parseBody(req);
        const result = await handleIngest(params.agentId, body, baseDir);
        json(res, 200, result);
        return;
      }

      // Route: GET /api/agents/:agentId/profile
      params = matchRoute(pathname, method, "/api/agents/:agentId/profile", "GET");
      if (params) {
        const result = await handleProfile(params.agentId, baseDir);
        json(res, 200, result);
        return;
      }

      // Route: DELETE /api/agents/:agentId/memory/:memoryId
      params = matchRoute(pathname, method, "/api/agents/:agentId/memory/:memoryId", "DELETE");
      if (params) {
        const result = await handleDelete(params.agentId, params.memoryId, baseDir);
        json(res, 200, result);
        return;
      }

      // Route: POST /api/agents/:agentId/training
      params = matchRoute(pathname, method, "/api/agents/:agentId/training", "POST");
      if (params) {
        const body = await parseBody(req);
        const result = await handleTraining(params.agentId, body, baseDir);
        json(res, 200, result);
        return;
      }

      // No route matched
      json(res, 404, { error: "Not found", code: 404 });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal server error";
      console.error(`[REST] ${method} ${pathname}: ${message}`);
      json(res, message.includes("Missing required") || message.includes("Invalid") ? 400 : 500,
        { error: message, code: message.includes("Missing required") || message.includes("Invalid") ? 400 : 500 });
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
          // Close all agent servers
          for (const [, entry] of agentServers) {
            await entry.storage.close();
          }
          agentServers.clear();
          return new Promise<void>((res) => httpServer.close(() => res()));
        },
      });
    });
  });
}

// -- Endpoint handlers ----------------------------------------------------------

async function handleStore(
  agentId: string,
  body: Record<string, unknown>,
  baseDir: string
): Promise<{ id: string; stored: boolean }> {
  const memory = body.memory;
  if (typeof memory !== "string" || memory.length < 5) {
    throw new Error("Missing required field: memory (string, min 5 chars)");
  }
  const rawType = typeof body.type === "string" ? body.type : "fact";
  const type: KnowledgeType = (KNOWLEDGE_TYPES as readonly string[]).includes(rawType)
    ? (rawType as KnowledgeType)
    : "fact";
  const tags = Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === "string") : [];

  const srv = getOrCreateAgentServer(agentId, baseDir);
  const id = randomUUID();
  const entry = {
    id,
    type,
    project: agentId,
    sessionId: `rest-${Date.now()}`,
    timestamp: Date.now(),
    summary: memory,
    details: typeof body.details === "string" ? body.details : "",
    tags,
    relatedFiles: [],
  };
  await srv.storage.knowledge.addEntry(entry);
  return { id, stored: true };
}

async function handleSearch(
  agentId: string,
  body: Record<string, unknown>,
  baseDir: string
): Promise<{ results: unknown[] }> {
  const query = body.query;
  if (typeof query !== "string" || query.length === 0) {
    throw new Error("Missing required field: query");
  }
  const limit = typeof body.limit === "number" ? Math.min(body.limit, 100) : 20;

  const srv = getOrCreateAgentServer(agentId, baseDir);
  const results = await srv.storage.knowledge.search(query);
  const limited = results.slice(0, limit);

  return {
    results: limited.map((r) => ({
      id: r.id,
      text: r.summary,
      type: r.type,
      confidence: 1.0, // FTS5 doesn't produce calibrated scores
      timestamp: r.timestamp,
      tags: typeof r.tags === "string" ? JSON.parse(r.tags) : r.tags,
    })),
  };
}

async function handleRecall(
  agentId: string,
  body: Record<string, unknown>,
  baseDir: string
): Promise<{ context: unknown[]; summary: string }> {
  const situation = body.situation;
  if (typeof situation !== "string" || situation.length === 0) {
    throw new Error("Missing required field: situation");
  }
  const limit = typeof body.limit === "number" ? Math.min(body.limit, 50) : 10;

  const srv = getOrCreateAgentServer(agentId, baseDir);
  const results = await srv.storage.knowledge.search(situation);
  const limited = results.slice(0, limit);

  const context = limited.map((r) => ({
    text: r.summary,
    type: r.type,
    confidence: 1.0,
  }));

  // Build a simple summary from top results
  const topFacts = limited.slice(0, 3).map((r) => r.summary).join(". ");
  const summary = topFacts || "No relevant memories found.";

  return { context, summary };
}

async function handleIngest(
  agentId: string,
  body: Record<string, unknown>,
  baseDir: string
): Promise<{ document_id: string; chunks: number; indexed: boolean }> {
  const title = body.title;
  const content = body.content;
  if (typeof title !== "string" || typeof content !== "string") {
    throw new Error("Missing required fields: title, content");
  }

  const srv = getOrCreateAgentServer(agentId, baseDir);
  const docId = randomUUID();

  // Store as a knowledge entry with the document content
  await srv.storage.knowledge.addEntry({
    id: docId,
    type: "fact",
    project: agentId,
    sessionId: `ingest-${Date.now()}`,
    timestamp: Date.now(),
    summary: title,
    details: content,
    tags: Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === "string") : [],
    relatedFiles: [],
  });

  return { document_id: docId, chunks: 1, indexed: true };
}

async function handleProfile(
  agentId: string,
  baseDir: string
): Promise<{
  agent_id: string;
  memory_count: number;
  last_interaction: number | null;
}> {
  const srv = getOrCreateAgentServer(agentId, baseDir);
  const all = await srv.storage.knowledge.search("");
  const latest = all.length > 0 ? Math.max(...all.map((r) => r.timestamp)) : null;

  return {
    agent_id: agentId,
    memory_count: all.length,
    last_interaction: latest,
  };
}

async function handleDelete(
  agentId: string,
  memoryId: string,
  baseDir: string
): Promise<{ deleted: boolean }> {
  const srv = getOrCreateAgentServer(agentId, baseDir);
  await srv.storage.knowledge.deleteEntry(memoryId);
  return { deleted: true };
}

async function handleTraining(
  agentId: string,
  body: Record<string, unknown>,
  baseDir: string
): Promise<{ stored: boolean; task_type: string; total_pairs: number }> {
  const input = body.input;
  const output = body.output;
  if (typeof input !== "string" || typeof output !== "string") {
    throw new Error("Missing required fields: input, output");
  }

  const model = typeof body.model === "string" ? body.model : "unknown";
  const quality = typeof body.quality === "number" ? body.quality : 0.8;

  const srv = getOrCreateAgentServer(agentId, baseDir);

  // Import training capture dynamically to avoid circular deps
  const { saveTrainingPair, getTrainingDataCount } = await import(
    "../extensions/llm-extraction/training-capture.js"
  );

  // Get the raw SQLite database from the index manager
  // The storage context wraps it, but training capture needs the raw db
  const indexManager = (srv as any).indexManager;
  if (!indexManager?.db) {
    throw new Error("Training capture requires SQLite storage (not available in D1 mode)");
  }

  saveTrainingPair(indexManager.db, {
    taskType: "dialogue",
    inputText: input,
    outputJson: output,
    modelUsed: model,
    qualityScore: quality,
    heuristicDiverged: false,
  });

  const counts = getTrainingDataCount(indexManager.db);
  return {
    stored: true,
    task_type: "dialogue",
    total_pairs: counts.dialogue,
  };
}
