/**
 * Regression tests for store_document file_path confinement.
 *
 * Bug: file_path was passed straight to readFileSync with no validation,
 * letting a malicious or prompt-injected MCP client index arbitrary files
 * (~/.ssh/id_rsa, .env) and exfiltrate them through search_history.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { openDatabase } from "../../src/storage/database.js";
import { DocumentChunkStore } from "../../src/storage/document-chunk-store.js";
import { handleStoreDocument } from "../../src/tools/store-document.js";

describe("store_document file_path confinement", () => {
  let db: Database.Database;
  let store: DocumentChunkStore;
  let outsideDir: string; // outside the default root (cwd)
  let insideDir: string; // inside the default root (cwd)
  let savedRoots: string | undefined;

  beforeEach(() => {
    db = openDatabase(":memory:");
    store = new DocumentChunkStore(db);
    savedRoots = process.env.STRATA_DOCUMENT_ROOTS;
    delete process.env.STRATA_DOCUMENT_ROOTS;

    outsideDir = mkdtempSync(join(tmpdir(), "strata-doc-confinement-"));
    writeFileSync(join(outsideDir, "secret.txt"), "pretend this is an ssh key");

    insideDir = join(process.cwd(), "tests", ".tmp-doc-confinement");
    mkdirSync(insideDir, { recursive: true });
    writeFileSync(join(insideDir, "allowed.txt"), "a perfectly ordinary document");
  });

  afterEach(() => {
    db.close();
    if (savedRoots === undefined) delete process.env.STRATA_DOCUMENT_ROOTS;
    else process.env.STRATA_DOCUMENT_ROOTS = savedRoots;
    rmSync(outsideDir, { recursive: true, force: true });
    rmSync(insideDir, { recursive: true, force: true });
  });

  it("rejects a file_path outside the allowed roots by default", async () => {
    const result = await handleStoreDocument(store, null, {
      file_path: join(outsideDir, "secret.txt"),
      mime_type: "text/plain",
      title: "Exfil Attempt",
    });

    expect(result).toContain("Error");
    expect(result).toContain("allowed document roots");
    expect(db.prepare("SELECT COUNT(*) AS c FROM stored_documents").get()).toEqual({ c: 0 });
  });

  it("rejects traversal that resolves outside the allowed roots without leaking existence", async () => {
    const result = await handleStoreDocument(store, null, {
      file_path: join(process.cwd(), "..", "outside-the-root.txt"),
      mime_type: "text/plain",
      title: "Traversal",
    });

    expect(result).toContain("allowed document roots");
    // Confinement must be checked before existence — no existence oracle outside roots.
    expect(result).not.toContain("File not found");
  });

  it("allows a file inside the default root (cwd)", async () => {
    const result = await handleStoreDocument(store, null, {
      file_path: join(insideDir, "allowed.txt"),
      mime_type: "text/plain",
      title: "Allowed Doc",
    });

    expect(result).toContain("Stored");
    expect(db.prepare("SELECT COUNT(*) AS c FROM stored_documents").get()).toEqual({ c: 1 });
  });

  it("allows additional roots via STRATA_DOCUMENT_ROOTS", async () => {
    process.env.STRATA_DOCUMENT_ROOTS = outsideDir;

    const result = await handleStoreDocument(store, null, {
      file_path: join(outsideDir, "secret.txt"),
      mime_type: "text/plain",
      title: "Explicitly Allowed",
    });

    expect(result).toContain("Stored");
  });

  it('disables confinement with STRATA_DOCUMENT_ROOTS="*"', async () => {
    process.env.STRATA_DOCUMENT_ROOTS = "*";

    const result = await handleStoreDocument(store, null, {
      file_path: join(outsideDir, "secret.txt"),
      mime_type: "text/plain",
      title: "Opt-Out",
    });

    expect(result).toContain("Stored");
  });
});
