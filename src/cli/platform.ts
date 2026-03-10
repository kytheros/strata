/**
 * Platform detection for binary artifact downloads.
 * Maps Node.js process.platform + process.arch to release platform IDs.
 */

export type PlatformId = "linux-x64" | "darwin-arm64" | "darwin-x64" | "win-x64";

const PLATFORM_MAP: Record<string, Record<string, PlatformId>> = {
  linux: { x64: "linux-x64" },
  darwin: { arm64: "darwin-arm64", x64: "darwin-x64" },
  win32: { x64: "win-x64" },
};

/**
 * Detect the current platform for binary downloads.
 * Returns null for unsupported platform/arch combinations.
 */
export function detectPlatform(): PlatformId | null {
  const platformEntry = PLATFORM_MAP[process.platform];
  if (!platformEntry) return null;
  return platformEntry[process.arch] ?? null;
}
