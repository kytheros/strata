/** Strict UUID v4 regex — rejects loose patterns like "----" or partial matches */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Extract and validate userId from the URL path.
 * Path format: /strata/{userId}/mcp
 */
export function extractUserId(pathname: string): string | null {
  const match = pathname.match(/^\/strata\/([^/]+)\/mcp$/);
  if (!match) return null;
  const userId = match[1];
  if (!UUID_RE.test(userId)) return null;
  return userId;
}

/**
 * Validate gateway token from Authorization header (preferred) or query param (fallback).
 * Returns true if auth passes, false if it fails.
 */
export function validateAuth(request: Request, gatewayToken: string | undefined): boolean {
  // If no token configured, reject — require explicit opt-in to disable auth
  if (!gatewayToken) return false;

  // Prefer Authorization: Bearer header
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7) === gatewayToken;
  }

  // Fallback: query param (backward compat, not recommended)
  const url = new URL(request.url);
  const queryToken = url.searchParams.get("token");
  return queryToken === gatewayToken;
}
