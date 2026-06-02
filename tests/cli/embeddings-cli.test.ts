// strata/tests/cli/embeddings-cli.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runEmbeddingsUse } from "../../src/cli/embeddings.js";

let tempHome: string;

afterEach(() => {
  delete process.env.STRATA_EMBEDDING_PROVIDER;
  delete process.env.HOME;
  delete process.env.USERPROFILE;
  delete process.env.STRATA_DATA_DIR;
  if (tempHome) {
    rmSync(tempHome, { recursive: true, force: true });
  }
});

describe("strata embeddings use", () => {
  it("writes the embeddings block to config.json without auto-reindexing", async () => {
    // Override homedir() so the resolver and writer use our temp dir.
    tempHome = mkdtempSync(join(tmpdir(), "strata-emb-cli-"));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;

    await runEmbeddingsUse(["local"], {});

    const configPath = join(tempHome, ".strata", "config.json");
    const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(cfg.embeddings.provider).toBe("local");
  });
});
