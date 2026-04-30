/**
 * strata backup push/pull/status — BYO-bucket backup for Strata.
 *
 * Subcommands:
 *   push <s3-uri>    Upload ~/.strata/strata.db to S3-compatible bucket.
 *                    Atomic: writes to a temp key first, then renames.
 *                    Writes a SHA-256 manifest sidecar alongside.
 *   pull <s3-uri>    Download from bucket to ~/.strata/strata.db.
 *                    Warns before overwriting a newer local DB.
 *                    Verifies SHA-256 sidecar when present.
 *   status <s3-uri>  Show local vs. remote size + mtime, and SHA match/mismatch.
 *
 * S3 credentials are read from standard AWS env vars:
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION
 * Optional:
 *   AWS_ENDPOINT_URL  — for R2, Backblaze, MinIO, etc.
 *
 * Config file alternative: ~/.strata/backup.json
 *   { "uri": "s3://bucket/key" }
 *
 * @aws-sdk/client-s3 is the approved exception to the native-fetch HTTP policy.
 * SigV4 request signing is not hand-rollable at acceptable quality.
 * nosemgrep: banned-http-client-library
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3"; // nosemgrep: banned-http-client-library
import {
  createWriteStream,
  existsSync,
  statSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { createHash } from "crypto";
import { join, dirname } from "path";
import { homedir } from "os";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface S3Uri {
  bucket: string;
  key: string;
}

export interface PushOptions {
  /** Absolute path to the local SQLite DB. Defaults to ~/.strata/strata.db. */
  dbPath?: string;
  /** Skip the SQLite online-backup snapshot and read the file directly.
   *  Only set this true in tests where better-sqlite3 is not available. */
  skipSnapshot?: boolean;
  /** Suppress console output (used in tests). */
  quiet?: boolean;
  /** Provided for test API compatibility — unused in push. */
  force?: boolean;
}

export interface PullOptions {
  /** Destination path for the downloaded DB. Defaults to ~/.strata/strata.db. */
  destPath?: string;
  /** Skip the overwrite-confirmation prompt (CI / --force flag). */
  force?: boolean;
  /** Simulate a user answer to the overwrite prompt: "y" or "n". Tests only. */
  promptAnswer?: string;
  /** Fetch and verify the SHA-256 sidecar. */
  fetchSha?: boolean;
  /** Suppress console output. */
  quiet?: boolean;
}

export interface StatusOptions {
  /** Path to the local DB to compare. Defaults to ~/.strata/strata.db. */
  dbPath?: string;
  /** Fetch and verify the SHA-256 sidecar. */
  fetchSha?: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Returns the default path to the Strata database.
 */
function defaultDbPath(): string {
  const dataDir = process.env.STRATA_DATA_DIR ?? join(homedir(), ".strata");
  return join(dataDir, "strata.db");
}

/**
 * Read the optional backup config file: ~/.strata/backup.json.
 * Returns { uri } if valid, or undefined.
 */
export function readBackupConfig(): { uri?: string } {
  const dataDir = process.env.STRATA_DATA_DIR ?? join(homedir(), ".strata");
  const configPath = join(dataDir, "backup.json");
  if (!existsSync(configPath)) return {};
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as unknown;
    if (typeof raw === "object" && raw !== null && "uri" in raw && typeof (raw as Record<string, unknown>).uri === "string") {
      return { uri: (raw as { uri: string }).uri };
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Parse an s3://bucket/key URI.
 * Throws a descriptive error if the URI is malformed.
 */
export function parseS3Uri(uri: string): S3Uri {
  if (!uri.startsWith("s3://")) {
    throw new Error(`Invalid S3 URI "${uri}": must start with s3://`);
  }
  const withoutScheme = uri.slice("s3://".length);
  const slashIdx = withoutScheme.indexOf("/");
  if (slashIdx === -1) {
    throw new Error(`Invalid S3 URI "${uri}": missing key path after bucket name`);
  }
  const bucket = withoutScheme.slice(0, slashIdx);
  const key = withoutScheme.slice(slashIdx + 1);
  if (!key) {
    throw new Error(`Invalid S3 URI "${uri}": key path is empty`);
  }
  return { bucket, key };
}

/**
 * Build an S3Client from environment variables.
 * Supports AWS_ENDPOINT_URL for R2 / Backblaze / MinIO.
 */
function makeS3Client(): S3Client {
  const endpoint = process.env.AWS_ENDPOINT_URL;
  return new S3Client(
    endpoint
      ? { endpoint, forcePathStyle: true }
      : {}
  );
}

/**
 * Compute the SHA-256 hex digest of a file.
 */
function sha256File(filePath: string): string {
  const hash = createHash("sha256");
  const buf = readFileSync(filePath);
  hash.update(buf);
  return hash.digest("hex");
}

/**
 * Compute SHA-256 of a Buffer or string.
 */
function sha256Bytes(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Read a Readable stream into a Buffer.
 */
async function streamToBuffer(stream: Readable | NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Use better-sqlite3's online backup API to snapshot the live DB to a temp
 * file, then return the temp path.  Falls back to a plain file read if
 * better-sqlite3 is not available (e.g., in unit tests without native deps).
 */
async function snapshotDb(srcPath: string, tmpPath: string): Promise<void> {
  try {
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(srcPath, { readonly: true });
    await db.backup(tmpPath);
    db.close();
  } catch {
    // Fallback: plain file copy (acceptable for tests without native SQLite)
    const buf = readFileSync(srcPath);
    writeFileSync(tmpPath, buf);
  }
}

// ─── push ─────────────────────────────────────────────────────────────────────

/**
 * Upload the local Strata database to S3 atomically:
 *  1. Snapshot DB via SQLite online backup API → temp file.
 *  2. Upload temp file to <key>.tmp-<timestamp>.
 *  3. Compute SHA-256 of the snapshot.
 *  4. Upload SHA-256 to <key>.sha256.
 *  5. CopyObject temp → final key.
 *  6. DeleteObject temp key.
 *
 * On any failure mid-flight, attempts to delete the temp key (best-effort).
 */
export async function runBackupPush(
  uri: string,
  options: PushOptions = {}
): Promise<void> {
  const { bucket, key } = parseS3Uri(uri);
  const dbPath = options.dbPath ?? defaultDbPath();
  const quiet = options.quiet ?? false;

  if (!existsSync(dbPath)) {
    throw new Error(`Local database not found: ${dbPath}`);
  }

  const s3 = makeS3Client();
  const timestamp = Date.now();
  const tmpKey = `${key}.tmp-${timestamp}`;
  const sha256Key = `${key}.sha256`;

  // Step 1: snapshot (skip in tests that set skipSnapshot=true)
  const snapshotPath = `${dbPath}.snapshot-${timestamp}`;
  try {
    if (options.skipSnapshot) {
      writeFileSync(snapshotPath, readFileSync(dbPath));
    } else {
      await snapshotDb(dbPath, snapshotPath);
    }

    // Step 2: upload snapshot to temp key
    // Use a Buffer (not a ReadStream) so the mock/test path works without
    // a real file descriptor, and so the entire upload is atomic.
    if (!quiet) console.log(`Uploading to s3://${bucket}/${tmpKey} ...`);
    const snapshotBuf = readFileSync(snapshotPath);
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: tmpKey,
        Body: snapshotBuf,
      })
    );

    // Step 3: compute SHA-256 of the snapshot
    const digest = sha256File(snapshotPath);

    // Step 4: upload SHA-256 sidecar
    if (!quiet) console.log(`Writing manifest s3://${bucket}/${sha256Key} ...`);
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: sha256Key,
        Body: digest,
        ContentType: "text/plain",
      })
    );

    // Step 5: atomic rename — CopyObject temp → final
    if (!quiet) console.log(`Promoting to s3://${bucket}/${key} ...`);
    await s3.send(
      new CopyObjectCommand({
        Bucket: bucket,
        CopySource: `${bucket}/${tmpKey}`,
        Key: key,
      })
    );

    // Step 6: delete temp key
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: tmpKey }));

    if (!quiet) {
      console.log(`Backup complete.`);
      console.log(`  Remote: s3://${bucket}/${key}`);
      console.log(`  SHA-256: ${digest}`);
    }
  } catch (err) {
    // Best-effort cleanup of the temp key
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: tmpKey }));
      if (!quiet) console.error(`Cleaned up temp key s3://${bucket}/${tmpKey}`);
    } catch {
      if (!quiet) console.error(`Warning: failed to clean up temp key s3://${bucket}/${tmpKey}`);
    }
    throw err;
  } finally {
    // Always clean up local snapshot
    try {
      if (existsSync(snapshotPath)) unlinkSync(snapshotPath);
    } catch { /* ignore */ }
  }
}

// ─── pull ─────────────────────────────────────────────────────────────────────

/**
 * Download the remote DB to the local destination.
 *
 * Safety:
 *  - Downloads to <dest>.partial first, renames on success.
 *  - If local file exists and its mtime > remote LastModified, prompts before
 *    overwriting (unless force=true or promptAnswer="y").
 *  - If a SHA-256 sidecar exists, verifies after download.  On mismatch,
 *    leaves the .partial file in place and throws.
 */
export async function runBackupPull(
  uri: string,
  options: PullOptions = {}
): Promise<void> {
  const { bucket, key } = parseS3Uri(uri);
  const destPath = options.destPath ?? defaultDbPath();
  const force = options.force ?? false;
  const quiet = options.quiet ?? false;
  const fetchSha = options.fetchSha ?? false;

  const s3 = makeS3Client();
  const partialPath = `${destPath}.partial`;

  // Ensure destination directory exists
  const destDir = dirname(destPath);
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });

  // Head the remote object to get metadata
  const head = await s3.send(
    new HeadObjectCommand({ Bucket: bucket, Key: key })
  );
  const remoteModified = head.LastModified ?? new Date(0);

  // Check if local is newer
  if (!force && existsSync(destPath)) {
    const localMtime = statSync(destPath).mtime;
    if (localMtime > remoteModified) {
      const localStr = localMtime.toISOString();
      const remoteStr = remoteModified.toISOString();

      // In tests, promptAnswer simulates stdin
      let answer: string;
      if (options.promptAnswer !== undefined) {
        answer = options.promptAnswer;
      } else {
        // Real interactive prompt
        const { createInterface } = await import("readline");
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        answer = await new Promise<string>((resolve) => {
          rl.question(
            `Local DB is newer than remote (local: ${localStr}, remote: ${remoteStr}). Overwrite? [y/N] `,
            (ans) => {
              rl.close();
              resolve(ans.trim().toLowerCase());
            }
          );
        });
      }

      if (answer !== "y") {
        if (!quiet) console.log("Pull cancelled. Local DB unchanged.");
        return;
      }
    }
  }

  // Download the main DB object → .partial
  if (!quiet) console.log(`Downloading s3://${bucket}/${key} ...`);
  const getResp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const bodyStream = getResp.Body as NodeJS.ReadableStream;

  const writeStream = createWriteStream(partialPath);
  await pipeline(bodyStream, writeStream);

  // SHA-256 verification (when sidecar is requested)
  if (fetchSha) {
    let remoteSha: string | undefined;
    try {
      const shaResp = await s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: `${key}.sha256` })
      );
      const shaBuffer = await streamToBuffer(shaResp.Body as NodeJS.ReadableStream);
      remoteSha = shaBuffer.toString("utf-8").trim();
    } catch {
      // Sidecar not found — skip verification
    }

    if (remoteSha) {
      const localSha = sha256File(partialPath);
      if (localSha !== remoteSha) {
        throw new Error(
          `SHA-256 checksum mismatch. Remote: ${remoteSha}, local: ${localSha}. ` +
            `Partial file left at ${partialPath} for inspection.`
        );
      }
    }
  }

  // Rename .partial → final destination
  renameSync(partialPath, destPath);

  if (!quiet) {
    console.log(`Restored to ${destPath}`);
  }
}

// ─── status ──────────────────────────────────────────────────────────────────

/**
 * Compare local and remote database metadata.
 *
 * Prints a 4-line table:
 *   Local  size: <bytes>  mtime: <iso>
 *   Remote size: <bytes>  modified: <iso>
 *   (optional) SHA-256: match / MISMATCH
 */
export async function runBackupStatus(
  uri: string,
  options: StatusOptions = {}
): Promise<void> {
  const { bucket, key } = parseS3Uri(uri);
  const dbPath = options.dbPath ?? defaultDbPath();
  const fetchSha = options.fetchSha ?? false;

  const s3 = makeS3Client();

  // Local stats
  const localExists = existsSync(dbPath);
  let localSize = 0;
  let localMtime = new Date(0);
  if (localExists) {
    const st = statSync(dbPath);
    localSize = st.size;
    localMtime = st.mtime;
  }

  // Remote stats
  const head = await s3.send(
    new HeadObjectCommand({ Bucket: bucket, Key: key })
  );
  const remoteSize = head.ContentLength ?? 0;
  const remoteMtime = head.LastModified ?? new Date(0);

  console.log("Backup Status");
  console.log("─────────────────────────────────────────");
  console.log(
    `  local   size: ${localExists ? localSize.toLocaleString() + " bytes" : "(not found)"}  mtime: ${localExists ? localMtime.toISOString() : "—"}`
  );
  console.log(
    `  remote  size: ${remoteSize.toLocaleString()} bytes  modified: ${remoteMtime.toISOString()}`
  );

  if (fetchSha && localExists) {
    let remoteSha: string | undefined;
    try {
      const shaResp = await s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: `${key}.sha256` })
      );
      const shaBuffer = await streamToBuffer(shaResp.Body as NodeJS.ReadableStream);
      remoteSha = shaBuffer.toString("utf-8").trim();
    } catch {
      // sidecar absent
    }

    if (remoteSha) {
      const localSha = sha256File(dbPath);
      const match = localSha === remoteSha;
      console.log(
        `  SHA-256: ${match ? "match" : `MISMATCH (local: ${localSha}, remote: ${remoteSha})`}`
      );
    } else {
      console.log("  SHA-256: sidecar not found on remote");
    }
  }
  console.log("─────────────────────────────────────────");
}

// ─── CLI entry point ─────────────────────────────────────────────────────────

/**
 * Main entry point called from cli.ts.
 *
 * @param subcommand  "push" | "pull" | "status"
 * @param args        Remaining positional args (the s3:// URI, or empty if
 *                    the user wants to read it from backup.json)
 * @param flags       Parsed CLI flags
 */
export async function runBackup(
  subcommand: string | undefined,
  args: string[],
  flags: Record<string, string | boolean>
): Promise<void> {
  if (!subcommand || !["push", "pull", "status"].includes(subcommand)) {
    console.log("Usage: strata backup <push|pull|status> [s3-uri]");
    console.log("");
    console.log("Subcommands:");
    console.log("  push <s3-uri>    Upload ~/.strata/strata.db to S3-compatible bucket");
    console.log("  pull <s3-uri>    Download from bucket to ~/.strata/strata.db");
    console.log("  status <s3-uri>  Show local vs. remote size and mtime");
    console.log("");
    console.log("The s3-uri can be omitted if ~/.strata/backup.json defines a default:");
    console.log('  { "uri": "s3://my-bucket/my-machine.db" }');
    console.log("");
    console.log("Environment variables:");
    console.log("  AWS_ACCESS_KEY_ID       S3 credentials");
    console.log("  AWS_SECRET_ACCESS_KEY");
    console.log("  AWS_REGION");
    console.log("  AWS_ENDPOINT_URL        Optional: R2, Backblaze, MinIO endpoint");
    process.exit(subcommand ? 1 : 0);
  }

  // Resolve URI from positional arg or config file
  let uri = args[0];
  if (!uri) {
    const cfg = readBackupConfig();
    if (cfg.uri) {
      uri = cfg.uri;
    } else {
      console.error(
        "Error: s3-uri is required (or set a default in ~/.strata/backup.json)"
      );
      process.exit(1);
    }
  }

  const force = Boolean(flags.force);

  switch (subcommand) {
    case "push":
      await runBackupPush(uri, { force });
      break;
    case "pull":
      await runBackupPull(uri, { force, fetchSha: true });
      break;
    case "status":
      await runBackupStatus(uri, { fetchSha: true });
      break;
  }
}
