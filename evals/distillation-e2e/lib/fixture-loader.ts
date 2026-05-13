import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Fixture } from "./fixture-types.js";

const REQUIRED_FIELDS: ReadonlyArray<keyof Fixture> = [
  "id", "sessions", "source", "query", "expected_answer",
  "expected_evidence_turns", "min_recall_at_k"
];

export function validateFixture(obj: unknown): Fixture {
  if (!obj || typeof obj !== "object") throw new Error("fixture must be an object");
  const f = obj as Record<string, unknown>;
  for (const field of REQUIRED_FIELDS) {
    if (!(field in f)) throw new Error(`fixture missing required field: ${String(field)}`);
  }
  if (!Array.isArray(f.sessions)) throw new Error("fixture.sessions must be an array");
  if (!Array.isArray(f.expected_evidence_turns)) {
    throw new Error("fixture.expected_evidence_turns must be an array");
  }
  return f as unknown as Fixture;
}

export function loadFixtures(rootDir: string): Fixture[] {
  const out: Fixture[] = [];
  for (const subdir of ["hand-annotated", "longmemeval-borrowed"]) {
    const dir = join(rootDir, subdir);
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const full = join(dir, entry);
      if (!statSync(full).isFile()) continue;
      const obj = JSON.parse(readFileSync(full, "utf8"));
      out.push(validateFixture(obj));
    }
  }
  return out;
}
