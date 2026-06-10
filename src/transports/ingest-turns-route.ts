/**
 * Shared POST /ingest/turns route handler (#30 conversation-ingest API).
 *
 * Both the SQLite and Postgres multi-tenant HTTP transports expose this REST
 * route. The route MECHANICS — method check, body-size cap (declared + streamed),
 * JSON parse, per-user acquire/release, response shaping — live here once, so the
 * two transports cannot drift. Each transport supplies its own tenant gate
 * (`requireTenant`) and per-user server acquisition (`acquire`), which already
 * differ in structure (LRU SQLite pool vs shared pg.Pool).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Buffer } from "node:buffer";
import type { IngestTurnsInput, IngestTurnsResult } from "../ingest/ingest-turns.js";

/** Larger body cap for conversation-ingest payloads (full sessions can be several MB). */
export const MAX_INGEST_BODY_BYTES = 5 * 1_048_576;

/** Read a request body with a hard streaming cap (defense-in-depth for chunked bodies). */
export function readBodyLarge(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > MAX_INGEST_BODY_BYTES) { req.destroy(); reject(new Error("Request body too large")); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/** A per-user ingest callable plus the release fn to run when the request finishes. */
export interface AcquiredIngest {
  ingestTurns: (input: IngestTurnsInput) => Promise<IngestTurnsResult>;
  release: () => void;
}

export interface IngestRouteDeps {
  /**
   * Validate tenant headers (auth-proxy sentinel + X-Strata-User UUID). On
   * failure the gate writes its own error response and returns null; the route
   * then returns without touching any tenant state.
   */
  requireTenant: (req: IncomingMessage, res: ServerResponse) => string | null;
  /** Resolve the per-user ingest callable + a release fn for the given userId. */
  acquire: (userId: string) => Promise<AcquiredIngest>;
}

/**
 * Handle one POST /ingest/turns request. The caller has already matched the
 * pathname; this owns method/gate/size/parse/ingest/respond.
 */
export async function handleIngestTurnsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: IngestRouteDeps
): Promise<void> {
  if ((req.method ?? "").toUpperCase() !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  const userId = deps.requireTenant(req, res);
  if (!userId) return; // gate already wrote the error response

  // Early, clean 413 on a declared oversized body — before reading the stream.
  const declaredLen = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLen) && declaredLen > MAX_INGEST_BODY_BYTES) {
    res.writeHead(413, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Request body too large" }));
    return;
  }

  try {
    const body = await readBodyLarge(req);
    const payload = JSON.parse(body);
    const { ingestTurns, release } = await deps.acquire(userId);
    try {
      const result = await ingestTurns({
        sessionId: payload.sessionId,
        project: payload.project,
        userId,
        messages: payload.messages,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } finally {
      release();
    }
  } catch (err) {
    const tooLarge = err instanceof Error && /too large/i.test(err.message);
    res.writeHead(tooLarge ? 413 : 400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : "Bad request" }));
  }
}
