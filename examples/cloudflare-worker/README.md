# Strata Cloudflare Worker Example

A minimal Cloudflare Worker that deploys Strata as a serverless MCP memory server on Cloudflare Workers + D1.

## Quick Setup

1. **Create a D1 database:**
   ```bash
   wrangler d1 create strata-db
   ```

2. **Update `wrangler.toml`** with the `database_id` from the output above.

3. **Apply the schema:**
   ```bash
   wrangler d1 migrations apply strata-db --local   # local dev
   wrangler d1 migrations apply strata-db --remote  # production
   ```

4. **Set secrets:**
   ```bash
   wrangler secret put MCP_GATEWAY_TOKEN    # required — gateway auth token
   wrangler secret put GEMINI_API_KEY       # optional — enables semantic search
   ```

5. **Run locally:**
   ```bash
   npm install
   npm run dev
   ```

6. **Deploy:**
   ```bash
   npm run deploy
   ```

## Connecting Claude Code

Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "strata": {
      "type": "url",
      "url": "https://strata-mcp.<subdomain>.workers.dev/strata/<userId>/mcp",
      "headers": {
        "Authorization": "Bearer <your-gateway-token>"
      }
    }
  }
}
```

## Full Documentation

See the complete deployment guide at [kytheros.dev/docs/cloudflare-workers-d1](https://kytheros.dev/docs/cloudflare-workers-d1).
