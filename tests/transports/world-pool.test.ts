import { test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { WorldPool } from '../../src/transports/world-pool.js';

let base: string;
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'worldpool-')); });
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

test('open creates world.db and applies schema', () => {
  const pool = new WorldPool(base, 4);
  const db = pool.open('default');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  expect(tables.length).toBeGreaterThan(3);
  pool.close();
});

test('LRU evicts least recently used when over max', () => {
  const pool = new WorldPool(base, 2);
  pool.open('a'); pool.open('b'); pool.open('c');
  expect(pool.isOpen('a')).toBe(false);
  expect(pool.isOpen('b')).toBe(true);
  expect(pool.isOpen('c')).toBe(true);
  pool.close();
});

test('open returns same handle on second call (no re-open)', () => {
  const pool = new WorldPool(base, 4);
  const h1 = pool.open('default');
  const h2 = pool.open('default');
  expect(h1).toBe(h2);
  pool.close();
});
