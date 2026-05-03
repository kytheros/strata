/**
 * Download and install paid-tier Strata packages from the releases Worker.
 *
 * Handles two artifact formats:
 *   - Tarball: installed globally via `npm install -g <file>`
 *   - Binary: copied to ~/.strata/bin/strata-{tier}[.exe]
 *
 * Uses only Node.js built-in modules — no external dependencies.
 */

import { createHash } from "crypto";
import { execSync } from "child_process";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  chmodSync,
  unlinkSync,
  existsSync,
} from "fs";
import https from "https";
import http from "http";
import { join } from "path";
import { homedir, tmpdir } from "os";
import { detectPlatform, type PlatformId } from "./platform.js";

export const RELEASES_BASE_URL = "https://releases.kytheros.dev";

/** Shape of the /versions endpoint response. */
export interface VersionInfo {
  tier: string;
  latest: string;
  versions: string[];
}

/** Config persisted to ~/.strata/config.json after successful activation. */
export interface InstallConfig {
  tier: string;
  version: string;
  format: "tarball" | "binary";
  platform?: PlatformId;
  installedAt: string;
  installPath: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function strataDir(): string {
  return join(homedir(), ".strata");
}

function configPath(): string {
  return join(strataDir(), "config.json");
}

function polarKeyPath(): string {
  return join(strataDir(), "polar.key");
}

/**
 * Simple promise-based HTTPS GET that follows redirects (up to 5).
 * Returns { statusCode, headers, body } where body is a Buffer.
 */
function httpsGet(
  url: string,
  maxRedirects = 5
): Promise<{ statusCode: number; headers: Record<string, string>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? https : http;
    proto.get(url, (res: any) => {
      // Follow redirects
      if (
        (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) &&
        res.headers.location &&
        maxRedirects > 0
      ) {
        const redirectUrl = res.headers.location.startsWith("http")
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        resolve(httpsGet(redirectUrl, maxRedirects - 1));
        return;
      }

      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const headers: Record<string, string> = {};
        for (const [key, val] of Object.entries(res.headers)) {
          if (typeof val === "string") headers[key] = val;
          else if (Array.isArray(val)) headers[key] = val[0];
        }
        resolve({
          statusCode: res.statusCode ?? 0,
          headers,
          body: Buffer.concat(chunks),
        });
      });
      res.on("error", reject);
    }).on("error", reject);
  });
}

/** Compute SHA-256 hex digest of a file. */
function sha256File(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch version/tier information for a given license key.
 * Throws with a user-friendly message on auth failure.
 */
export async function fetchVersionInfo(key: string): Promise<VersionInfo> {
  const url = `${RELEASES_BASE_URL}/versions?key=${encodeURIComponent(key)}`;
  const res = await httpsGet(url);

  if (res.statusCode === 401 || res.statusCode === 403) {
    throw new Error(
      "License key not recognized or expired.\n" +
        "  - Verify the key at https://strata.kytheros.dev/account\n" +
        "  - Contact support@kytheros.dev if you believe this is an error."
    );
  }
  if (res.statusCode !== 200) {
    throw new Error(`Releases server returned HTTP ${res.statusCode}: ${res.body.toString("utf-8").slice(0, 200)}`);
  }

  return JSON.parse(res.body.toString("utf-8")) as VersionInfo;
}

/**
 * Download an artifact from the releases Worker and install it.
 *
 * @param options.key      - Polar license key
 * @param options.tier     - Package tier (pro)
 * @param options.binary   - If true, download standalone binary; otherwise tarball
 * @param options.platform - Override auto-detected platform (binary mode only)
 */
export async function downloadAndInstall(options: {
  key: string;
  tier: string;
  binary: boolean;
  platform?: PlatformId;
}): Promise<{ version: string; installPath: string }> {
  const { key, tier, binary } = options;

  // 1. Build download URL
  let url = `${RELEASES_BASE_URL}/${encodeURIComponent(tier)}/latest?key=${encodeURIComponent(key)}`;

  let platform: PlatformId | undefined;
  if (binary) {
    platform = options.platform ?? detectPlatform() ?? undefined;
    if (!platform) {
      throw new Error(
        `Unsupported platform: ${process.platform}-${process.arch}\n` +
          "  Use --platform to specify manually, or omit --binary to download the tarball."
      );
    }
    url += `&platform=${platform}`;
  }

  // 2. Download
  console.log(`Downloading ${tier} (${binary ? `binary/${platform}` : "tarball"})...`);
  const res = await httpsGet(url);

  if (res.statusCode === 401 || res.statusCode === 403) {
    throw new Error("License key rejected. Check your key and try again.");
  }
  if (res.statusCode !== 200) {
    throw new Error(`Download failed with HTTP ${res.statusCode}: ${res.body.toString("utf-8").slice(0, 200)}`);
  }

  // 3. Read expected checksum from header
  const expectedHash = (res.headers["x-checksum-sha256"] || "").toLowerCase();

  // 4. Save to temp file
  const ext = binary ? (process.platform === "win32" ? ".exe" : "") : ".tgz";
  const tempFile = join(tmpdir(), `strata-${tier}-${Date.now()}${ext}`);
  writeFileSync(tempFile, res.body);

  // 5. Verify SHA-256
  if (expectedHash) {
    const actualHash = sha256File(tempFile);
    if (actualHash !== expectedHash) {
      unlinkSync(tempFile);
      throw new Error(
        `Checksum mismatch!\n` +
          `  Expected: ${expectedHash}\n` +
          `  Got:      ${actualHash}\n` +
          "  The download may be corrupted. Please try again."
      );
    }
    console.log("Checksum verified.");
  } else {
    console.log("Warning: Server did not provide a checksum header. Skipping verification.");
  }

  // 6. Determine version from response header or fallback
  const version = res.headers["x-strata-version"] || "latest";

  // 7. Install
  let installPath: string;

  if (binary) {
    // Binary: copy to ~/.strata/bin/strata-{tier}[.exe]
    const binDir = join(strataDir(), "bin");
    mkdirSync(binDir, { recursive: true });

    const binaryName = process.platform === "win32" ? `strata-${tier}.exe` : `strata-${tier}`;
    installPath = join(binDir, binaryName);
    copyFileSync(tempFile, installPath);

    // chmod +x on Unix
    if (process.platform !== "win32") {
      chmodSync(installPath, 0o755);
    }
    unlinkSync(tempFile);

    console.log(`Installed binary to ${installPath}`);
  } else {
    // Tarball: npm install -g
    console.log("Installing tarball globally via npm...");
    try {
      execSync(`npm install -g "${tempFile}"`, { stdio: "inherit" });
    } catch {
      unlinkSync(tempFile);
      throw new Error(
        "npm install -g failed. You may need to run with elevated permissions\n" +
          "  (sudo on macOS/Linux, or an admin shell on Windows)."
      );
    }
    unlinkSync(tempFile);

    // Resolve install location via npm
    installPath = `(global npm prefix)/strata-${tier}`;
    try {
      const prefix = execSync("npm prefix -g", { encoding: "utf-8" }).trim();
      installPath = join(prefix, "lib", "node_modules", `@kytheros/strata-${tier}`);
    } catch {
      // non-critical — the path is informational
    }

    console.log(`Installed @kytheros/strata-${tier} globally.`);
  }

  // 8. Save config
  const config: InstallConfig = {
    tier,
    version,
    format: binary ? "binary" : "tarball",
    platform: platform,
    installedAt: new Date().toISOString(),
    installPath,
  };
  mkdirSync(strataDir(), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(config, null, 2), { encoding: "utf-8" });

  // 9. Save Polar key for future updates
  writeFileSync(polarKeyPath(), key, { encoding: "utf-8", mode: 0o600 });

  return { version, installPath };
}

/**
 * Read the saved install config. Returns null if not found.
 */
export function readInstallConfig(): InstallConfig | null {
  const p = configPath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as InstallConfig;
  } catch {
    return null;
  }
}

/**
 * Read the saved Polar license key. Returns null if not found.
 */
export function readPolarKey(): string | null {
  const p = polarKeyPath();
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, "utf-8").trim();
  } catch {
    return null;
  }
}
