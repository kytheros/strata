/**
 * Claude Code encodes project paths by replacing path separators with '-'.
 * Unix: /Users/jon/dev/ghostty -> -Users-jon-dev-ghostty
 * Windows: E:\Kytheros\src -> E--Kytheros-src (colon removed, backslash → -)
 */

export function encodeProjectPath(absolutePath: string): string {
  // Handle both forward slashes and backslashes, plus colons from drive letters
  return absolutePath.replace(/[:\\/]/g, "-");
}

export function decodeProjectPath(encoded: string): string {
  // Best-effort decode: replace '-' with '/' (loses Windows drive colon)
  return encoded.replace(/-/g, "/");
}

/**
 * Extract a short project name from an encoded path.
 * e.g., -Users-jon-dev-ghostty -> ghostty
 *       E--Kytheros-src -> src
 */
export function extractProjectName(encodedOrPath: string): string {
  // Normalize: if it's a raw path, decode it first
  let decoded: string;
  if (encodedOrPath.includes("/") || encodedOrPath.includes("\\")) {
    decoded = encodedOrPath;
  } else {
    decoded = decodeProjectPath(encodedOrPath);
  }
  const parts = decoded.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || decoded;
}

/**
 * Find which encoded project directory matches a given working directory.
 */
export function matchProjectDir(
  cwd: string,
  projectDirs: string[]
): string | null {
  const encoded = encodeProjectPath(cwd);
  // Exact match first
  if (projectDirs.includes(encoded)) return encoded;
  // Prefix match (cwd might be a subdirectory)
  const match = projectDirs.find(
    (dir) => encoded.startsWith(dir) || dir.startsWith(encoded)
  );
  return match || null;
}
