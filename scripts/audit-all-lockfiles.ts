#!/usr/bin/env tsx
/**
 * audit-all-lockfiles.ts
 *
 * Runs `npm audit --audit-level=high` against every package-lock.json tracked
 * by git in this repo (root + templates/**). Exits non-zero if any lockfile
 * has a HIGH or CRITICAL advisory.
 *
 * Why this exists: `npm audit` only audits the lockfile next to the cwd it
 * runs in. Shipping templates with their own lockfiles (e.g. templates/aws/**)
 * means a vulnerable transitive can land in the published tarball even when
 * the root project audits clean. This script closes that gap.
 *
 * Wired into:
 *   - .husky/pre-push (gate before push)
 *   - package.json prepublishOnly (gate before npm publish)
 *
 * Bypass intentionally not supported. Add `--skip <path>` if a specific
 * lockfile is allowlisted (e.g. a known-vulnerable demo intentionally
 * shipped behind a "do not deploy" README).
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const REPO_ROOT = resolve(process.cwd());

const SKIP_FLAG = "--skip";
const skips = new Set<string>();
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === SKIP_FLAG && process.argv[i + 1]) {
    skips.add(process.argv[i + 1].replace(/\\/g, "/"));
    i++;
  }
}

function listLockfiles(): string[] {
  const out = execFileSync("git", ["ls-files", "**/package-lock.json", "package-lock.json"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((p) => !p.includes("node_modules/"))
    .map((p) => p.replace(/\\/g, "/"));
}

function auditOne(lockfile: string): { lockfile: string; ok: boolean; output: string } {
  const dir = dirname(resolve(REPO_ROOT, lockfile));
  const hasNodeModules = existsSync(resolve(dir, "node_modules"));
  // `npm audit` needs a resolved tree. If node_modules isn't present (typical
  // for template lockfiles in a fresh clone or in CI), run an offline-prefer
  // install first. We use `--ignore-scripts` to match the rest of the repo's
  // supply-chain hardening posture (CLAUDE.md "Install Script Lockdown").
  if (!hasNodeModules) {
    const install = spawnSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline"], {
      cwd: dir,
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    if (install.status !== 0) {
      return {
        lockfile,
        ok: false,
        output: `npm ci failed before audit:\n${install.stdout}\n${install.stderr}`,
      };
    }
  }
  const audit = spawnSync("npm", ["audit", "--audit-level=high"], {
    cwd: dir,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  return {
    lockfile,
    ok: audit.status === 0,
    output: `${audit.stdout}\n${audit.stderr}`.trim(),
  };
}

function main(): void {
  const lockfiles = listLockfiles();
  if (lockfiles.length === 0) {
    console.log("[audit-all-lockfiles] no tracked package-lock.json files found");
    return;
  }

  const targets = lockfiles.filter((lf) => {
    if (skips.has(lf)) {
      console.log(`[audit-all-lockfiles] skipping ${lf} (--skip)`);
      return false;
    }
    return true;
  });

  console.log(`[audit-all-lockfiles] auditing ${targets.length} lockfile(s) (HIGH+ only)`);
  const failures: { lockfile: string; output: string }[] = [];
  for (const lf of targets) {
    process.stdout.write(`  → ${lf} ... `);
    const result = auditOne(lf);
    if (result.ok) {
      console.log("clean");
    } else {
      console.log("FAILED");
      failures.push({ lockfile: lf, output: result.output });
    }
  }

  if (failures.length > 0) {
    console.error(`\n[audit-all-lockfiles] ${failures.length} lockfile(s) have HIGH+ advisories:\n`);
    for (const f of failures) {
      console.error(`──── ${f.lockfile} ────`);
      console.error(f.output);
      console.error("");
    }
    console.error(
      `[audit-all-lockfiles] fix with: cd <dir> && npm audit fix`,
    );
    console.error(
      `[audit-all-lockfiles] if a CVE is intentionally accepted, add 'tsx scripts/audit-all-lockfiles.ts --skip <path>' to the calling script.`,
    );
    process.exit(1);
  }

  console.log(`\n[audit-all-lockfiles] all ${targets.length} lockfile(s) clean`);
}

main();
