import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { applySchema } from './world-schema.js';

export class WorldPool {
  private handles = new Map<string, Database.Database>();
  private order: string[] = []; // LRU: oldest first

  constructor(private basePath: string, private maxOpen: number) {
    if (maxOpen < 1) throw new Error('maxOpen must be >= 1');
    mkdirSync(join(basePath, 'worlds'), { recursive: true });
  }

  open(worldId: string): Database.Database {
    const existing = this.handles.get(worldId);
    if (existing) {
      this.touch(worldId);
      return existing;
    }
    const dir = join(this.basePath, 'worlds', worldId);
    mkdirSync(dir, { recursive: true });
    const db = new Database(join(dir, 'world.db'));
    db.pragma('journal_mode = WAL');
    applySchema(db);
    this.handles.set(worldId, db);
    this.order.push(worldId);
    this.evictIfNeeded();
    return db;
  }

  isOpen(worldId: string): boolean {
    return this.handles.has(worldId);
  }

  private touch(worldId: string): void {
    const i = this.order.indexOf(worldId);
    if (i >= 0) this.order.splice(i, 1);
    this.order.push(worldId);
  }

  private evictIfNeeded(): void {
    while (this.order.length > this.maxOpen) {
      const oldest = this.order.shift()!;
      const h = this.handles.get(oldest);
      if (h) { h.close(); this.handles.delete(oldest); }
    }
  }

  /** Close and evict a single world DB handle so its file can be deleted. */
  closeWorld(worldId: string): void {
    const h = this.handles.get(worldId);
    if (h) {
      h.close();
      this.handles.delete(worldId);
      const i = this.order.indexOf(worldId);
      if (i >= 0) this.order.splice(i, 1);
    }
  }

  close(): void {
    for (const h of this.handles.values()) h.close();
    this.handles.clear();
    this.order = [];
  }
}
