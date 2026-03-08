/**
 * Token-optimized response builders for MCP tool output.
 *
 * Follows patterns from mcp-best-practices.md:
 * 1. Compact JSON (no pretty-print) — saves ~30% tokens
 * 2. CHARACTER_LIMIT enforcement — max 25,000 tokens
 * 3. Metadata (_meta) for tool tracking
 * 4. Conditional guidance — only when actionable
 */

/** ~25,000 tokens at ~4 chars/token */
const CHARACTER_LIMIT = 25_000 * 4;

/**
 * Truncate response if it exceeds CHARACTER_LIMIT.
 */
export function enforceCharacterLimit(text: string): {
  text: string;
  truncated: boolean;
} {
  if (text.length <= CHARACTER_LIMIT) {
    return { text, truncated: false };
  }
  return {
    text:
      text.substring(0, CHARACTER_LIMIT) +
      "\n\n[TRUNCATED: Response exceeded 25,000 token limit]",
    truncated: true,
  };
}

/**
 * Build a compact MCP tool response.
 */
export function buildToolResponse(
  toolName: string,
  data: Record<string, unknown>,
  opts?: {
    cached?: boolean;
    guidance?: string;
  }
): { content: Array<{ type: "text"; text: string }> } {
  const response: Record<string, unknown> = {
    _meta: { tool: toolName, ts: new Date().toISOString() },
    data,
  };

  if (opts?.cached) {
    (response._meta as Record<string, unknown>).cached = true;
  }
  if (opts?.guidance) {
    response.next = opts.guidance;
  }

  // Compact JSON — no pretty-print
  const raw = JSON.stringify(response);
  const { text } = enforceCharacterLimit(raw);
  return { content: [{ type: "text" as const, text }] };
}

/**
 * Build a text-based MCP tool response with character limit.
 */
export function buildTextResponse(
  text: string,
  guidance?: string
): { content: Array<{ type: "text"; text: string }> } {
  let output = text;
  if (guidance) {
    output += `\n\n💡 ${guidance}`;
  }
  const { text: limited } = enforceCharacterLimit(output);
  return { content: [{ type: "text" as const, text: limited }] };
}

/**
 * Truncate text to preview length with word count.
 */
export function truncatePreview(
  text: string,
  maxLen: number = 500
): string {
  if (text.length <= maxLen) return text;
  const wordCount = text.split(/\s+/).length;
  return `${text.substring(0, maxLen)}... [${wordCount} words total]`;
}
