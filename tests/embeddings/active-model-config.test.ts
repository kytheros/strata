// strata/tests/embeddings/active-model-config.test.ts
//
// Regression: resolveActiveEmbeddingModel() must read ~/.strata/config.json
// and merge with env vars (env wins over file wins over defaults).
// Also covers STRATA_DATA_DIR path split (IMPORTANT fix).
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { resolveActiveEmbeddingModel } from "../../src/extensions/embeddings/active-model.js";

let tempHome: string;

afterEach(() => {
  delete process.env.STRATA_EMBEDDING_PROVIDER;
  delete process.env.STRATA_EMBEDDING_MODEL;
  delete process.env.STRATA_EMBEDDING_DIMENSIONS;
  delete process.env.HOME;
  delete process.env.USERPROFILE;
  delete process.env.STRATA_DATA_DIR;
  if (tempHome) {
    rmSync(tempHome, { recursive: true, force: true });
  }
});

function makeConfigHome(configData: object): string {
  const dir = mkdtempSync(join(tmpdir(), "strata-test-home-"));
  const strataDir = join(dir, ".strata");
  mkdirSync(strataDir, { recursive: true });
  writeFileSync(join(strataDir, "config.json"), JSON.stringify(configData), "utf-8");
  // Set both HOME and USERPROFILE so homedir() resolves here on any platform.
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  tempHome = dir;
  return dir;
}

describe("resolveActiveEmbeddingModel — config.json integration", () => {
  it("reads provider from config.json when no env var is set", () => {
    makeConfigHome({ embeddings: { provider: "local" } });
    const a = resolveActiveEmbeddingModel();
    expect(a.provider).toBe("local");
    expect(a.model).toBe("nomic-embed-text-v1.5");
    expect(a.dimensions).toBe(768);
  });

  it("env var STRATA_EMBEDDING_PROVIDER wins over config.json", () => {
    makeConfigHome({ embeddings: { provider: "local" } });
    process.env.STRATA_EMBEDDING_PROVIDER = "gemini";
    const a = resolveActiveEmbeddingModel();
    expect(a.provider).toBe("gemini");
    expect(a.model).toBe("gemini-embedding-001");
    expect(a.dimensions).toBe(3072);
  });

  // IMPORTANT fix regression: STRATA_DATA_DIR must be honoured by both the CLI
  // writer (getConfigPath in cli/embeddings.ts) AND the resolver reader
  // (loadEmbeddingsConfigFromFile in active-model.ts). Without the fix, `use`
  // writes to STRATA_DATA_DIR but the resolver reads homedir()/.strata → silent no-op.
  it("reads provider from STRATA_DATA_DIR/config.json when STRATA_DATA_DIR is set", () => {
    // Use a fresh temp dir as the STRATA_DATA_DIR (no .strata subdir needed)
    const dataDir = mkdtempSync(join(tmpdir(), "strata-data-dir-"));
    tempHome = dataDir; // cleaned up in afterEach
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ embeddings: { provider: "local" } }), "utf-8");
    process.env.STRATA_DATA_DIR = dataDir;
    // Point homedir() somewhere else so we can confirm it's NOT reading from there
    const fakeHome = mkdtempSync(join(tmpdir(), "strata-fake-home-"));
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    // No env var for provider — must come from the file in STRATA_DATA_DIR
    const a = resolveActiveEmbeddingModel();
    rmSync(fakeHome, { recursive: true, force: true });
    expect(a.provider).toBe("local");
    expect(a.model).toBe("nomic-embed-text-v1.5");
  });
});
