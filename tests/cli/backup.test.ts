/**
 * Tests for strata backup push/pull/status subcommands.
 *
 * Uses aws-sdk-client-mock to avoid hitting real S3.
 * All tests exercise backup.ts logic directly (unit), not via the CLI subprocess.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import {
  mkdirSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
} from "fs";
import { join } from "path";
import { Readable } from "stream";
import { createHash } from "crypto";

// Static import — no cache-busting query strings (Vitest/Vite can't handle those)
import {
  parseS3Uri,
  runBackupPush,
  runBackupPull,
  runBackupStatus,
} from "../../src/cli/backup.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

const projectRoot = join(import.meta.dirname, "../..");
const testDataDir = join(projectRoot, "tests", ".test-backup-data");

function makeTestDir(): void {
  if (existsSync(testDataDir)) rmSync(testDataDir, { recursive: true, force: true });
  mkdirSync(testDataDir, { recursive: true });
}

function cleanTestDir(): void {
  if (existsSync(testDataDir)) rmSync(testDataDir, { recursive: true, force: true });
}

/** Readable stream from a string — simulates GetObject body. */
function stringToStream(s: string): Readable {
  const r = new Readable();
  r.push(s);
  r.push(null);
  return r;
}

// ─── 1. URI parsing ──────────────────────────────────────────────────────────

describe("parseS3Uri", () => {
  it("parses a valid s3:// URI with key", () => {
    const result = parseS3Uri("s3://my-bucket/path/to/db.db");
    expect(result).toEqual({ bucket: "my-bucket", key: "path/to/db.db" });
  });

  it("parses a valid s3:// URI with bucket-root key", () => {
    const result = parseS3Uri("s3://my-bucket/strata.db");
    expect(result).toEqual({ bucket: "my-bucket", key: "strata.db" });
  });

  it("rejects non-s3 URIs", () => {
    expect(() => parseS3Uri("gs://my-bucket/key")).toThrow(/s3:\/\//);
    expect(() => parseS3Uri("https://example.com/key")).toThrow(/s3:\/\//);
  });

  it("rejects URIs with no key path", () => {
    expect(() => parseS3Uri("s3://my-bucket")).toThrow(/key/);
    expect(() => parseS3Uri("s3://my-bucket/")).toThrow(/key/);
  });
});

// ─── 2. Push: atomic temp-key flow ───────────────────────────────────────────

describe("runBackupPush", () => {
  const s3Mock = mockClient(S3Client);

  beforeEach(() => {
    makeTestDir();
    s3Mock.reset();
  });

  afterEach(() => {
    cleanTestDir();
  });

  it("uploads to temp key, writes manifest, copies to final key, deletes temp", async () => {
    // Create a fake local DB
    const dbPath = join(testDataDir, "strata.db");
    writeFileSync(dbPath, "fake-db-content");

    // Mock all S3 calls to succeed
    s3Mock
      .on(PutObjectCommand)
      .resolves({})
      .on(CopyObjectCommand)
      .resolves({})
      .on(DeleteObjectCommand)
      .resolves({});

    await runBackupPush("s3://test-bucket/backup.db", {
      dbPath,
      skipSnapshot: true,
      quiet: true,
      force: true,
    });

    const calls = s3Mock.calls();

    // Helper: identify command type via firstArg constructor name
    const cmdName = (c: (typeof calls)[number]) =>
      (c.firstArg as { constructor?: { name?: string } })?.constructor?.name ?? "";

    // At least 2 PutObject calls: temp upload + SHA sidecar
    const putCalls = calls.filter((c) => cmdName(c) === "PutObjectCommand");
    expect(putCalls.length).toBeGreaterThanOrEqual(2);

    // 1 CopyObject: temp → final
    const copyCalls = calls.filter((c) => cmdName(c) === "CopyObjectCommand");
    expect(copyCalls.length).toBe(1);

    // 1 DeleteObject: clean up the temp key
    const deleteCalls = calls.filter((c) => cmdName(c) === "DeleteObjectCommand");
    expect(deleteCalls.length).toBe(1);
  });

  it("cleans up temp key when the CopyObject step fails", async () => {
    const dbPath = join(testDataDir, "strata.db");
    writeFileSync(dbPath, "fake-db-content");

    s3Mock
      .on(PutObjectCommand)
      .resolves({})
      .on(CopyObjectCommand)
      .rejectsOnce(new Error("S3 copy failure"))
      .on(DeleteObjectCommand)
      .resolves({});

    await expect(
      runBackupPush("s3://test-bucket/backup.db", {
        dbPath,
        skipSnapshot: true,
        quiet: true,
        force: true,
      })
    ).rejects.toThrow();

    // DeleteObject must have been attempted (best-effort cleanup)
    const calls2 = s3Mock.calls();
    const cmdName2 = (c: (typeof calls2)[number]) =>
      (c.firstArg as { constructor?: { name?: string } })?.constructor?.name ?? "";
    const deleteCalls = calls2.filter((c) => cmdName2(c) === "DeleteObjectCommand");
    expect(deleteCalls.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── 3. Pull: overwrite prompt path ──────────────────────────────────────────

describe("runBackupPull", () => {
  const s3Mock = mockClient(S3Client);

  beforeEach(() => {
    makeTestDir();
    s3Mock.reset();
  });

  afterEach(() => {
    cleanTestDir();
  });

  it("downloads to .partial then renames on success (no existing local file)", async () => {
    const destPath = join(testDataDir, "strata.db");
    const fakeContent = "remote-db-content";

    s3Mock
      .on(HeadObjectCommand)
      .resolves({
        ContentLength: fakeContent.length,
        LastModified: new Date("2026-01-01"),
      })
      .on(GetObjectCommand)
      .resolvesOnce({
        Body: stringToStream(fakeContent) as unknown as ReadableStream,
        ContentLength: fakeContent.length,
      });

    await runBackupPull("s3://test-bucket/backup.db", {
      destPath,
      force: true,
      quiet: true,
    });

    expect(existsSync(destPath)).toBe(true);
    expect(readFileSync(destPath, "utf-8")).toBe(fakeContent);
    // Partial file should be cleaned up after success
    expect(existsSync(destPath + ".partial")).toBe(false);
  });

  it("skips overwrite when force=false and local is newer (promptAnswer=n)", async () => {
    const destPath = join(testDataDir, "strata.db");
    writeFileSync(destPath, "existing-local-db");

    // Remote is old — local file written just now will be newer
    s3Mock.on(HeadObjectCommand).resolves({
      ContentLength: 100,
      LastModified: new Date("2020-01-01"),
    });

    await runBackupPull("s3://test-bucket/backup.db", {
      destPath,
      force: false,
      promptAnswer: "n",
      quiet: true,
    });

    // File should be unchanged
    expect(readFileSync(destPath, "utf-8")).toBe("existing-local-db");
  });

  it("verifies SHA256 and succeeds when checksums match", async () => {
    const destPath = join(testDataDir, "strata.db");
    const fakeContent = "db-with-checksum";
    const expectedSha = createHash("sha256").update(fakeContent).digest("hex");

    s3Mock
      .on(HeadObjectCommand)
      .resolves({
        ContentLength: fakeContent.length,
        LastModified: new Date("2026-01-01"),
      })
      .on(GetObjectCommand)
      // First call: main DB body
      .resolvesOnce({
        Body: stringToStream(fakeContent) as unknown as ReadableStream,
        ContentLength: fakeContent.length,
      })
      // Second call: sha256 sidecar
      .resolvesOnce({
        Body: stringToStream(expectedSha) as unknown as ReadableStream,
        ContentLength: expectedSha.length,
      });

    await runBackupPull("s3://test-bucket/backup.db", {
      destPath,
      force: true,
      fetchSha: true,
      quiet: true,
    });

    expect(existsSync(destPath)).toBe(true);
    expect(existsSync(destPath + ".partial")).toBe(false);
  });

  it("pull, local newer, user answers y — downloads and replaces existing file", async () => {
    const destPath = join(testDataDir, "strata.db");
    writeFileSync(destPath, "old-local-content");

    const remoteContent = "new-remote-content";

    // Remote is older than the just-written local file
    s3Mock
      .on(HeadObjectCommand)
      .resolves({
        ContentLength: remoteContent.length,
        LastModified: new Date("2020-01-01"),
      })
      .on(GetObjectCommand)
      .resolvesOnce({
        Body: stringToStream(remoteContent) as unknown as ReadableStream,
        ContentLength: remoteContent.length,
      });

    await runBackupPull("s3://test-bucket/backup.db", {
      destPath,
      force: false,
      promptAnswer: "y",
      quiet: true,
    });

    // Download should have proceeded and replaced the old file
    expect(existsSync(destPath)).toBe(true);
    expect(readFileSync(destPath, "utf-8")).toBe(remoteContent);
    expect(existsSync(destPath + ".partial")).toBe(false);
  });

  it("pull, remote newer than local — no prompt fires, download proceeds", async () => {
    const destPath = join(testDataDir, "strata.db");
    writeFileSync(destPath, "older-local-content");

    const remoteContent = "fresh-remote-content";

    // Remote LastModified is far in the future relative to the local file
    s3Mock
      .on(HeadObjectCommand)
      .resolves({
        ContentLength: remoteContent.length,
        LastModified: new Date("2099-12-31"),
      })
      .on(GetObjectCommand)
      .resolvesOnce({
        Body: stringToStream(remoteContent) as unknown as ReadableStream,
        ContentLength: remoteContent.length,
      });

    // force=false but no promptAnswer provided — if a prompt were fired and
    // promptAnswer is undefined the code would try readline (which would hang
    // in tests).  The test passing proves no prompt was triggered.
    await runBackupPull("s3://test-bucket/backup.db", {
      destPath,
      force: false,
      quiet: true,
    });

    expect(existsSync(destPath)).toBe(true);
    expect(readFileSync(destPath, "utf-8")).toBe(remoteContent);
    expect(existsSync(destPath + ".partial")).toBe(false);
  });

  it("leaves .partial file and rejects when SHA256 mismatches", async () => {
    const destPath = join(testDataDir, "strata.db");
    const fakeContent = "corrupted-db-content";

    s3Mock
      .on(HeadObjectCommand)
      .resolves({
        ContentLength: fakeContent.length,
        LastModified: new Date("2026-01-01"),
      })
      .on(GetObjectCommand)
      // First call: main DB body
      .resolvesOnce({
        Body: stringToStream(fakeContent) as unknown as ReadableStream,
        ContentLength: fakeContent.length,
      })
      // Second call: sha256 sidecar with WRONG hash
      .resolvesOnce({
        Body: stringToStream("wrong-checksum") as unknown as ReadableStream,
        ContentLength: "wrong-checksum".length,
      });

    await expect(
      runBackupPull("s3://test-bucket/backup.db", {
        destPath,
        force: true,
        fetchSha: true,
        quiet: true,
      })
    ).rejects.toThrow(/checksum|SHA/i);

    // .partial file should remain for inspection
    expect(existsSync(destPath + ".partial")).toBe(true);
    // Final file should NOT exist
    expect(existsSync(destPath)).toBe(false);
  });
});

// ─── 4. Status command ───────────────────────────────────────────────────────

describe("runBackupStatus", () => {
  const s3Mock = mockClient(S3Client);
  let consoleLogs: string[];

  beforeEach(() => {
    makeTestDir();
    s3Mock.reset();
    consoleLogs = [];
    vi.spyOn(console, "log").mockImplementation((...args) => {
      consoleLogs.push(args.join(" "));
    });
  });

  afterEach(() => {
    cleanTestDir();
    vi.restoreAllMocks();
  });

  it("prints local and remote size and mtime", async () => {
    const dbPath = join(testDataDir, "strata.db");
    writeFileSync(dbPath, "local-db-content-12345");

    s3Mock.on(HeadObjectCommand).resolves({
      ContentLength: 9999,
      LastModified: new Date("2026-01-15T10:00:00Z"),
    });

    await runBackupStatus("s3://test-bucket/backup.db", { dbPath });

    const output = consoleLogs.join("\n");
    expect(output).toMatch(/local/i);
    expect(output).toMatch(/remote/i);
    expect(output).toMatch(/\d+/); // some numeric size
  });

  it("shows MISMATCH when remote SHA differs from local", async () => {
    const dbPath = join(testDataDir, "strata.db");
    writeFileSync(dbPath, "local-db-for-sha-test");
    const wrongSha = "deadbeefdeadbeefdeadbeefdeadbeef";

    s3Mock
      .on(HeadObjectCommand)
      .resolves({
        ContentLength: 100,
        LastModified: new Date("2026-01-15"),
      })
      .on(GetObjectCommand)
      .resolvesOnce({
        Body: stringToStream(wrongSha) as unknown as ReadableStream,
        ContentLength: wrongSha.length,
      });

    await runBackupStatus("s3://test-bucket/backup.db", {
      dbPath,
      fetchSha: true,
    });

    const output = consoleLogs.join("\n");
    expect(output).toMatch(/MISMATCH/i);
  });
});
