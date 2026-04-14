/**
 * NPC acquaintance store — tracks NPC-to-NPC familiarity for gossip
 * propagation. Stored as JSON per (playerId, npcId) at
 * {baseDir}/players/{playerId}/agents/{npcId}/acquaintances.json.
 *
 * In single-player v1, playerId is always "default". When the world-scope
 * refactor lands (design queue #5), storage migrates to
 * {baseDir}/worlds/{worldId}/agents/{npcId}/acquaintances.json with no
 * logic change — same shape, shared across PCs.
 *
 * Spec: 2026-04-13-npc-gossip-design.md
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface AcquaintanceCard {
  trust: number;               // 0..100, default 50
  lastInteractionAt: number;
  interactionCount: number;
}

interface AcquaintanceFile {
  npcId: string;
  playerId: string;
  cards: Record<string, AcquaintanceCard>;
}

const DEFAULT_TRUST = 50;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export class NpcAcquaintanceStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  private filePath(playerId: string, npcId: string): string {
    return join(this.baseDir, "players", playerId, "agents", npcId, "acquaintances.json");
  }

  private readFile(playerId: string, npcId: string): AcquaintanceFile {
    const path = this.filePath(playerId, npcId);
    if (!existsSync(path)) {
      return { npcId, playerId, cards: {} };
    }
    try {
      return JSON.parse(readFileSync(path, "utf-8")) as AcquaintanceFile;
    } catch {
      return { npcId, playerId, cards: {} };
    }
  }

  private writeFile(playerId: string, npcId: string, file: AcquaintanceFile): void {
    const path = this.filePath(playerId, npcId);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2), "utf-8");
    renameSync(tmp, path);
  }

  get(playerId: string, npcId: string, otherNpcId: string): AcquaintanceCard | null {
    const file = this.readFile(playerId, npcId);
    return file.cards[otherNpcId] ?? null;
  }

  recordInteraction(playerId: string, npcId: string, otherNpcId: string): AcquaintanceCard {
    const file = this.readFile(playerId, npcId);
    const existing = file.cards[otherNpcId];
    const card: AcquaintanceCard = existing
      ? {
          trust: existing.trust,
          lastInteractionAt: Date.now(),
          interactionCount: existing.interactionCount + 1,
        }
      : {
          trust: DEFAULT_TRUST,
          lastInteractionAt: Date.now(),
          interactionCount: 1,
        };
    file.cards[otherNpcId] = card;
    this.writeFile(playerId, npcId, file);
    return card;
  }

  updateTrust(playerId: string, npcId: string, otherNpcId: string, delta: number): void {
    const file = this.readFile(playerId, npcId);
    const existing = file.cards[otherNpcId];
    if (!existing) return;
    existing.trust = clamp(existing.trust + delta, 0, 100);
    this.writeFile(playerId, npcId, file);
  }
}
