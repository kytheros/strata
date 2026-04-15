/**
 * NPC acquaintance store — tracks NPC-to-NPC familiarity for gossip
 * propagation against the world.db `npc_acquaintances` table.
 *
 * Acquaintances are world-shared (not per-player). There is no playerId
 * parameter — gossip propagates once per world, not per PC.
 *
 * Spec: 2026-04-15-world-scope-refactor-design.md
 */

import type Database from "better-sqlite3";

export interface AcquaintanceCard {
  trust: number;               // 0..100, default 50
  lastInteractionAt: number;
  interactionCount: number;
}

const DEFAULT_TRUST = 50;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export class NpcAcquaintanceStore {
  private readonly db: Database.Database;

  private readonly stmtUpsertCreate: Database.Statement;
  private readonly stmtIncrementInteraction: Database.Statement;
  private readonly stmtGet: Database.Statement;
  private readonly stmtUpdateTrust: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;

    this.stmtUpsertCreate = db.prepare(`
      INSERT INTO npc_acquaintances
        (npc_id, other_npc_id, trust, last_interaction, interaction_count)
      VALUES
        (@npc_id, @other_npc_id, @trust, @now, 1)
      ON CONFLICT(npc_id, other_npc_id) DO UPDATE SET
        last_interaction = excluded.last_interaction,
        interaction_count = npc_acquaintances.interaction_count + 1
    `);

    this.stmtGet = db.prepare(`
      SELECT * FROM npc_acquaintances WHERE npc_id = ? AND other_npc_id = ?
    `);

    this.stmtUpdateTrust = db.prepare(`
      UPDATE npc_acquaintances
      SET trust = MAX(0, MIN(100, trust + ?))
      WHERE npc_id = ? AND other_npc_id = ?
    `);

    // Alias for increment path used below
    this.stmtIncrementInteraction = this.stmtUpsertCreate;
  }

  /** Get the acquaintance card. Returns null if no relationship exists. */
  get(npcId: string, otherNpcId: string): AcquaintanceCard | null {
    const row = this.stmtGet.get(npcId, otherNpcId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      trust: row.trust as number,
      lastInteractionAt: row.last_interaction as number,
      interactionCount: row.interaction_count as number,
    };
  }

  /** Record an interaction between two NPCs. Creates the card if it doesn't exist. */
  recordInteraction(npcId: string, otherNpcId: string): AcquaintanceCard {
    this.stmtUpsertCreate.run({
      npc_id: npcId,
      other_npc_id: otherNpcId,
      trust: DEFAULT_TRUST,
      now: Date.now(),
    });
    return this.get(npcId, otherNpcId)!;
  }

  /** Update trust by delta. Clamps to 0..100. No-op if card does not exist. */
  updateTrust(npcId: string, otherNpcId: string, delta: number): void {
    this.stmtUpdateTrust.run(delta, npcId, otherNpcId);
  }
}
