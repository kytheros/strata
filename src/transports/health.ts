/**
 * Health check endpoint for Cloud Run and monitoring.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface HealthStatus {
  status: "ok" | "error";
  version: string;
  uptime: number;
}

const startTime = Date.now();
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, "..", "..", "package.json"), "utf-8")
    );
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function buildHealthResponse(): HealthStatus {
  return {
    status: "ok",
    version: getVersion(),
    uptime: Math.floor((Date.now() - startTime) / 1000),
  };
}

export function handleHealthRequest(
  _req: IncomingMessage,
  res: ServerResponse
): void {
  const health = buildHealthResponse();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(health));
}
