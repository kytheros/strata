import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createServer, type CreateServerResult } from "../../../src/server.js";

export interface IsolatedHandle {
  dataDir: string;
  runId: string;
  server: CreateServerResult;
}

export async function withIsolatedStrata<T>(
  fn: (handle: IsolatedHandle) => Promise<T>
): Promise<T> {
  const runId = randomUUID();
  const dataDir = mkdtempSync(join(tmpdir(), `strata-e2e-${runId}-`));
  // createServer is synchronous — no await needed
  const server = createServer({ dataDir });
  try {
    return await fn({ dataDir, runId, server });
  } finally {
    // Close DB handles via storage.close() (the close method lives on storage, not on the result)
    try { await server.storage.close(); } catch { /* swallow — teardown */ }
    rmSync(dataDir, { recursive: true, force: true });
  }
}
