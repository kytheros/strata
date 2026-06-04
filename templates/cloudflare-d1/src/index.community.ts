import {
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createD1Storage, D1KnowledgeTurnStore, D1VectorSearch } from "strata-mcp/d1";
import { createServer } from "strata-mcp/server";

interface WorkerEnv {
  STRATA_DB: D1Database;
  MCP_GATEWAY_TOKEN?: string;
  GEMINI_API_KEY?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function extractUserId(pathname: string): string | null {
  const match = pathname.match(/^\/strata\/([^/]+)\/mcp$/);
  if (!match) return null;
  const userId = match[1];
  if (!UUID_RE.test(userId)) return null;
  return userId;
}

function validateAuth(request: Request, gatewayToken: string | undefined): boolean {
  if (!gatewayToken) return false;
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7) === gatewayToken;
  }
  const url = new URL(request.url);
  return url.searchParams.get("token") === gatewayToken;
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "ok", server: "strata-community" });
    }

    if (!validateAuth(request, env.MCP_GATEWAY_TOKEN)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    const userId = extractUserId(url.pathname);
    if (!userId) {
      return Response.json(
        { error: "Not found. Expected /strata/{userId}/mcp" },
        { status: 404 },
      );
    }

    const storage = await createD1Storage({ d1: env.STRATA_DB, userId });
    // Dense turn-lane: construct turn store + vector search with null embedder.
    // initEmbedder() (called inside createServer) late-injects the Gemini provider
    // via setEmbedder() when GEMINI_API_KEY is present (resolved through
    // createEmbeddingProvider → loadGeminiApiKeyFromConfig → process.env).
    // The turn store starts empty (no turn-write path in Community D1 yet) and
    // degrades gracefully to FTS5-only search until a future ingest API populates it.
    // DEFERRED: Worker env.GEMINI_API_KEY → process.env plumbing is deferred to the
    // future Community ingest API work (the dense turn-lane requires turns to exist
    // before vector search adds value; D1 has no ingest path today).
    const turnStore = new D1KnowledgeTurnStore(env.STRATA_DB, null);
    const vectorSearch = new D1VectorSearch(env.STRATA_DB);
    const { server } = createServer({
      storage,
      externalTurnStore: turnStore,
      externalVectorSearch: vectorSearch,
    });

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await server.connect(transport);
    return transport.handleRequest(request);
  },
};
