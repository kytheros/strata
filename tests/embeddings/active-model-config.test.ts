// strata/tests/embeddings/active-model-config.test.ts
//
// Regression: resolveActiveEmbeddingModel() must read ~/.strata/config.json
// and merge with env vars (env wins over file wins over defaults).
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
});
