#!/usr/bin/env node
/**
 * Staleness reporter for the Understand-Anything knowledge graph.
 *
 * Inspects how far HEAD has drifted from the commit the graph was
 * generated against, then prints a tiered recommendation:
 *
 *   silent  (0 changed files)              → no output, exit 0
 *   nudge   (1-20 changed files)           → one-line reminder, exit 0
 *   strong  (>20 changed files OR HEAD     → multi-line reminder, exit 0
 *           ≥10 commits past graph commit)
 *
 * Always exits 0 — never blocks pushes or commits. Designed to be wired
 * into pre-push as an informational tail step.
 *
 * Cost reference (per scripts/query-graph.mjs sibling docs):
 *   1-12 changed files  ~ $0.50, 3-5 min wall, ~6-10 LLM calls
 *   50 files            ~ $2-3, 8-12 min, ~10-13 calls
 *   200 files           ~ $4-5, 15-20 min, ~22-25 calls
 *   Full --full rebuild ~ $25-40, 30-50 min, ~85 calls
 */
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const META_PATH = resolve(process.cwd(), '.understand-anything/meta.json');

if (!existsSync(META_PATH)) {
  // No graph exists yet — silent. The user hasn't opted in to U-A on this repo.
  process.exit(0);
}

let meta;
try {
  meta = JSON.parse(readFileSync(META_PATH, 'utf-8'));
} catch (e) {
  // Malformed; don't block. Silent.
  process.exit(0);
}

const graphCommit = meta.gitCommitHash;
if (!graphCommit) process.exit(0);

let head, behindCount, changedFiles;
try {
  head = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
  if (head === graphCommit) process.exit(0); // current — silent

  // Number of commits from graph commit to HEAD (inclusive of HEAD direction)
  behindCount = parseInt(
    execSync(`git rev-list --count ${graphCommit}..HEAD`, { encoding: 'utf-8' }).trim() || '0',
    10
  );
  changedFiles = execSync(`git diff --name-only ${graphCommit}..HEAD`, { encoding: 'utf-8' })
    .trim()
    .split('\n')
    .filter(Boolean);
} catch (e) {
  // If git fails (e.g., graph commit not in current history — orphan rebase),
  // print a soft warning but don't block.
  console.error('\n[graph-status] Could not compute staleness — graph commit may not be in current branch history.');
  console.error(`[graph-status] Consider /understand --full to regenerate from current HEAD.\n`);
  process.exit(0);
}

const changedCount = changedFiles.length;
if (changedCount === 0) process.exit(0); // commits but no file diffs (e.g., empty merge)

const isStrong = changedCount > 20 || behindCount >= 10;
const isNudge = changedCount >= 1 && !isStrong;

const fileList = changedFiles.slice(0, 5).map((f) => `    ${f}`).join('\n');
const moreFiles = changedCount > 5 ? `\n    ... and ${changedCount - 5} more` : '';

if (isStrong) {
  console.error('');
  console.error('═══════════════════════════════════════════════════════════════════');
  console.error('  📊 Knowledge graph is significantly stale');
  console.error('═══════════════════════════════════════════════════════════════════');
  console.error(`  HEAD:          ${head.slice(0, 12)}`);
  console.error(`  Graph commit:  ${graphCommit.slice(0, 12)} (${behindCount} commits behind)`);
  console.error(`  Files changed: ${changedCount}`);
  console.error('');
  console.error('  Refresh recommended after push:');
  console.error(`    /understand ${process.cwd().replace(/\\/g, '/')}`);
  console.error('');
  console.error(`  Estimated cost: ~${Math.ceil(changedCount / 12) + 6} LLM calls, ~${Math.max(5, Math.ceil(changedCount / 5))} min wall.`);
  console.error('═══════════════════════════════════════════════════════════════════');
  console.error('');
} else if (isNudge) {
  console.error('');
  console.error(`[graph-status] ${changedCount} file${changedCount === 1 ? '' : 's'} changed since the knowledge graph was generated (${behindCount} commit${behindCount === 1 ? '' : 's'} behind).`);
  console.error(`               Changed: ${changedFiles.slice(0, 3).join(', ')}${changedCount > 3 ? `, +${changedCount - 3} more` : ''}`);
  console.error('               Consider `/understand` to refresh when convenient.');
  console.error('');
}

process.exit(0);
