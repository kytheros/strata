import {
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createD1Storage } from "strata-mcp/d1";
import { createProServer } from "@kytheros/strata-pro/server";

interface WorkerEnv {
  STRATA_DB: D1Database;
  MCP_GATEWAY_TOKEN?: string;
  GEMINI_API_KEY?: string;
  POLAR_LICENSE_KEY?: string;
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
      return Response.json({ status: "ok", server: "strata-pro" });
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
    const { server } = createProServer({ storage, licenseKey: env.POLAR_LICENSE_KEY });

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await server.connect(transport);
    return transport.handleRequest(request);
  },
};
