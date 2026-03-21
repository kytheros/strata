import {
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createD1Storage } from "strata-mcp/d1";
import { createServer } from "strata-mcp/server";
import { extractUserId, validateAuth } from "./auth.js";

interface WorkerEnv {
  STRATA_DB: D1Database;
  MCP_GATEWAY_TOKEN?: string;
  GEMINI_API_KEY?: string;
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    // Gateway token authentication (Bearer header preferred, query param fallback)
    if (!validateAuth(request, env.MCP_GATEWAY_TOKEN)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    // Extract and validate userId from path: /strata/{userId}/mcp
    const userId = extractUserId(url.pathname);
    if (!userId) {
      return Response.json({ error: "not found" }, { status: 404 });
    }

    // Create per-request storage scoped to this user
    const storage = await createD1Storage({
      d1: env.STRATA_DB,
      userId,
    });

    // Create the MCP server with all 9 community tools
    const { server } = await createServer({ storage });

    // Use the SDK's web-standard transport (stateless mode)
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await server.connect(transport);
    return transport.handleRequest(request);
  },
};
