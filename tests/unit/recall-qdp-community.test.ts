/**
 * Unit tests for recallQdpCommunity — the Community-surface QDP pruner.
 *
 * Coverage:
 * - Dedupe rule: near-duplicate pairs are collapsed, originals are kept
 * - Filler rule: short interrogative dialogue-only items are dropped
 * - Coverage rule: items with zero query-token overlap are dropped
 * - All rules in combination
 * - Pass-through when all rules are disabled (output == input)
 * - Math-parity: identical scenarios pruned identically by recallQdp (NPC)
 *   and recallQdpCommunity (Community) when given equivalent inputs
 *
 * Spec: 2026-05-01-tirqdp-community-port-plan.md §TIRQDP-1.5
 * Ticket: TIRQDP-1.5
 */

import { describe, it, expect } from "vitest";
import {
  recallQdpCommunity,
  type CommunityQdpOpts,
} from "../../src/search/recall-qdp-community.js";
import { recallQdp } from "../../src/transports/recall-qdp.js";
import type { FusedResult } from "../../src/search/recall-fusion-community.js";
import type { FusedCandidate } from "../../src/transports/recall-fusion.js";

// ── helpers ───────────────────────────────────────────────────────────────────

/** Minimal FusedResult builder — only sets fields the QDP pruner reads. */
function makeFused(
  id: string,
  content: string,
  tags: string[] = [],
  rrfScore = 0.5
): FusedResult {
  return {
    id,
    content,
    tags,
    rrfScore,
    source: "chunk",
    userId: "user-1",
    project: "proj-a",
    createdAt: Date.now(),
  };
}

/** Build a FusedCandidate (NPC shape) for parity tests. */
function makeNpcCandidate(
  id: string,
  content: string,
  tags: string[] = [],
  rrfScore = 0.5
): FusedCandidate {
  return {
    id,
    score: rrfScore,
    rrfScore,
    source: "fact",
    content,
    tags,
    createdAt: 0,
    speaker: "player",
  };
}

/** Opts that disable every rule (pass-through mode). */
const allOff: CommunityQdpOpts = {
  skipDedupe: true,
  skipFiller: true,
  skipCoverage: true,
};

// ── pass-through ──────────────────────────────────────────────────────────────

describe("recallQdpCommunity — pass-through", () => {
  it("returns empty array unchanged", () => {
    expect(recallQdpCommunity([], "query", {}, allOff)).toEqual([]);
  });

  it("returns input unchanged when all rules are disabled", () => {
    const items = [
      makeFused("a", "alpha beta gamma delta epsilon"),
      makeFused("b", "completely different content xyz"),
    ];
    const result = recallQdpCommunity(items, "alpha", {}, allOff);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("a");
    expect(result[1].id).toBe("b");
  });
});

// ── dedupe rule ───────────────────────────────────────────────────────────────

describe("recallQdpCommunity — dedupe rule", () => {
  it("keeps the first of two near-duplicate items (Jaccard >= 0.85)", () => {
    // Two strings with very high trigram overlap: change just one word at the end
    const base = "the quick brown fox jumps over the lazy dog today near river";
    const nearDup = "the quick brown fox jumps over the lazy dog today near pond";
    const items = [
      makeFused("orig", base),
      makeFused("dup", nearDup),
    ];
    // Use a low dedupeJaccard threshold so we can force the rule to fire
    const result = recallQdpCommunity(
      items,
      "fox",
      { dedupeJaccard: 0.5 },
      { skipFiller: true, skipCoverage: true }
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("orig");
  });

  it("keeps both items when Jaccard is below threshold", () => {
    const items = [
      makeFused("a", "completely different first sentence about alpha"),
      makeFused("b", "totally unrelated second sentence about zeta"),
    ];
    const result = recallQdpCommunity(
      items,
      "alpha",
      { dedupeJaccard: 0.85 },
      { skipFiller: true, skipCoverage: true }
    );
    expect(result).toHaveLength(2);
  });

  it("handles items with empty content without throwing (edge case)", () => {
    const items = [makeFused("a", ""), makeFused("b", "")];
    // Both empty → trigrams empty → Jaccard = 1.0 → dup dropped
    const result = recallQdpCommunity(
      items,
      "any",
      { dedupeJaccard: 0.85 },
      { skipFiller: true, skipCoverage: true }
    );
    expect(result).toHaveLength(1);
  });
});

// ── filler rule ───────────────────────────────────────────────────────────────

describe("recallQdpCommunity — filler rule", () => {
  it("drops short interrogative dialogue-only items (all three conditions met)", () => {
    const filler = makeFused("f", "Ready to fight?", ["dialogue"]);
    const result = recallQdpCommunity(
      [filler],
      "fight",
      { fillerMaxLen: 40 },
      { skipDedupe: true, skipCoverage: true }
    );
    expect(result).toHaveLength(0);
  });

  it("keeps item that is short + interrogative but NOT dialogue-only (has extra tags)", () => {
    const item = makeFused("k", "Ready to fight?", ["dialogue", "important"]);
    const result = recallQdpCommunity(
      [item],
      "fight",
      { fillerMaxLen: 40 },
      { skipDedupe: true, skipCoverage: true }
    );
    expect(result).toHaveLength(1);
  });

  it("keeps item that is short + dialogue-only but NOT interrogative (no trailing ?)", () => {
    const item = makeFused("k", "Ready to fight", ["dialogue"]);
    const result = recallQdpCommunity(
      [item],
      "fight",
      { fillerMaxLen: 40 },
      { skipDedupe: true, skipCoverage: true }
    );
    expect(result).toHaveLength(1);
  });

  it("keeps item that is interrogative + dialogue-only but NOT short (exceeds fillerMaxLen)", () => {
    const longContent = "Are you absolutely certain this is the right path forward now?"; // > 40 chars
    expect(longContent.length).toBeGreaterThan(40);
    const item = makeFused("k", longContent, ["dialogue"]);
    const result = recallQdpCommunity(
      [item],
      "path",
      { fillerMaxLen: 40 },
      { skipDedupe: true, skipCoverage: true }
    );
    expect(result).toHaveLength(1);
  });

  it("keeps item with no tags (not dialogue-only)", () => {
    const item = makeFused("k", "Fight now?", []); // no tags
    const result = recallQdpCommunity(
      [item],
      "fight",
      { fillerMaxLen: 40 },
      { skipDedupe: true, skipCoverage: true }
    );
    expect(result).toHaveLength(1);
  });
});

// ── coverage rule ─────────────────────────────────────────────────────────────

describe("recallQdpCommunity — coverage rule", () => {
  it("drops items with zero content-word overlap with the query", () => {
    const items = [
      makeFused("a", "some content about dragons and knights"),
      makeFused("b", "unrelated material about cooking pasta"),
    ];
    const result = recallQdpCommunity(
      items,
      "dragons",
      { minTokenLen: 4 },
      { skipDedupe: true, skipFiller: true }
    );
    // "dragons" matches 'a'; 'b' has no overlap
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("a");
  });

  it("passes all items when query has no content words (all tokens < minTokenLen)", () => {
    const items = [
      makeFused("a", "something about X"),
      makeFused("b", "other stuff about Y"),
    ];
    // Query "a b" has tokens shorter than minTokenLen=4 → no content words → pass-through
    const result = recallQdpCommunity(
      items,
      "a b",
      { minTokenLen: 4 },
      { skipDedupe: true, skipFiller: true }
    );
    expect(result).toHaveLength(2);
  });

  it("passes all items when query has only stopwords", () => {
    const items = [makeFused("x", "the quick brown fox")];
    // "the and for" are all stopwords
    const result = recallQdpCommunity(
      items,
      "the and for",
      { minTokenLen: 3 },
      { skipDedupe: true, skipFiller: true }
    );
    expect(result).toHaveLength(1);
  });

  it("coverage check is case-insensitive", () => {
    const items = [makeFused("a", "Dragon slayer of the realm")];
    const result = recallQdpCommunity(
      items,
      "DRAGON",
      { minTokenLen: 4 },
      { skipDedupe: true, skipFiller: true }
    );
    expect(result).toHaveLength(1);
  });
});

// ── all rules combined ────────────────────────────────────────────────────────

describe("recallQdpCommunity — all rules combined", () => {
  it("applies all three rules in sequence and returns only surviving items", () => {
    const items = [
      // Should survive: unique, not filler, has query overlap
      makeFused("keeper", "The warrior defended the ancient fortress gates"),
      // Should be deduped: very similar to 'keeper'
      makeFused("dup", "The warrior defended the ancient fortress walls"),
      // Should be fillerfiltered: short, interrogative, dialogue-only
      makeFused("filler", "Attack now?", ["dialogue"]),
      // Should fail coverage: no query-word overlap
      makeFused("nocov", "Something completely unrelated about cooking"),
    ];
    const result = recallQdpCommunity(
      items,
      "warrior fortress",
      { dedupeJaccard: 0.5, fillerMaxLen: 40, minTokenLen: 4 }
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("keeper");
  });
});

// ── math parity with NPC recallQdp ───────────────────────────────────────────

describe("recallQdpCommunity — math parity with NPC recallQdp", () => {
  /**
   * This is the critical invariant: for equivalent inputs, the Community
   * pruner and the NPC pruner must produce identical pruning decisions.
   * Identical meaning: the same items survive and the same items are dropped.
   */

  it("dedupes identically: same pairs dropped as NPC recallQdp", () => {
    const content1 = "The hero found the ancient sword hidden in the cave deep underground";
    const content2 = "The hero found the ancient sword hidden in the cave deep below ground";

    const communityItems = [
      makeFused("id-1", content1),
      makeFused("id-2", content2),
    ];
    const npcItems: FusedCandidate[] = [
      makeNpcCandidate("id-1", content1),
      makeNpcCandidate("id-2", content2),
    ];

    const communityResult = recallQdpCommunity(
      communityItems,
      "sword cave",
      { dedupeJaccard: 0.7 },
      { skipFiller: true, skipCoverage: true }
    );
    const npcResult = recallQdp(
      npcItems,
      "sword cave",
      { dedupeJaccard: 0.7, fillerMaxLen: 40, minTokenLen: 4 }
    );

    // Both should drop the same number of items
    expect(communityResult).toHaveLength(npcResult.length);
    // Same ids survive
    const communityIds = communityResult.map(r => r.id).sort();
    const npcIds = npcResult.map(r => r.id).sort();
    expect(communityIds).toEqual(npcIds);
  });

  it("filler filter identical: same items dropped as NPC recallQdp", () => {
    const fillerContent = "Are you ready?";
    const normalContent = "The dragon breathed fire upon the castle walls today";

    const communityItems = [
      makeFused("filler", fillerContent, ["dialogue"]),
      makeFused("normal", normalContent, []),
    ];
    const npcItems: FusedCandidate[] = [
      makeNpcCandidate("filler", fillerContent, ["dialogue"]),
      makeNpcCandidate("normal", normalContent, []),
    ];

    const communityResult = recallQdpCommunity(
      communityItems,
      "dragon castle",
      { fillerMaxLen: 40 },
      { skipDedupe: true, skipCoverage: true }
    );
    const npcResult = recallQdp(
      npcItems,
      "dragon castle",
      { dedupeJaccard: 0.85, fillerMaxLen: 40, minTokenLen: 4 }
    );

    expect(communityResult).toHaveLength(npcResult.length);
    const communityIds = communityResult.map(r => r.id).sort();
    const npcIds = npcResult.map(r => r.id).sort();
    expect(communityIds).toEqual(npcIds);
  });

  it("coverage filter identical: same items dropped as NPC recallQdp", () => {
    const relevantContent = "The warrior trained every morning before the battle";
    const irrelevantContent = "Cooking pasta requires boiling water carefully";

    const communityItems = [
      makeFused("relevant", relevantContent),
      makeFused("irrelevant", irrelevantContent),
    ];
    const npcItems: FusedCandidate[] = [
      makeNpcCandidate("relevant", relevantContent),
      makeNpcCandidate("irrelevant", irrelevantContent),
    ];

    const communityResult = recallQdpCommunity(
      communityItems,
      "warrior battle training",
      { minTokenLen: 4 },
      { skipDedupe: true, skipFiller: true }
    );
    const npcResult = recallQdp(
      npcItems,
      "warrior battle training",
      { dedupeJaccard: 0.85, fillerMaxLen: 40, minTokenLen: 4 }
    );

    expect(communityResult).toHaveLength(npcResult.length);
    const communityIds = communityResult.map(r => r.id).sort();
    const npcIds = npcResult.map(r => r.id).sort();
    expect(communityIds).toEqual(npcIds);
  });

  it("all-rules parity: full pipeline produces identical pruning decisions", () => {
    // A comprehensive scenario exercising all three rules simultaneously
    const items = [
      { id: "keep-1", content: "The brave knight defended the castle ramparts daily" },
      { id: "dup-1",  content: "The brave knight defended the castle ramparts nightly" }, // near-dup of keep-1
      { id: "filler", content: "Attack now?", tags: ["dialogue"] },
      { id: "nocov",  content: "Rain falls in the autumn season often here" },
    ];

    const communityItems = items.map(i =>
      makeFused(i.id, i.content, (i as any).tags ?? [])
    );
    const npcItems = items.map(i =>
      makeNpcCandidate(i.id, i.content, (i as any).tags ?? [])
    );

    const cfg = { dedupeJaccard: 0.5, fillerMaxLen: 40, minTokenLen: 4 };
    const communityResult = recallQdpCommunity(communityItems, "knight castle", cfg);
    const npcResult = recallQdp(npcItems, "knight castle", cfg);

    expect(communityResult).toHaveLength(npcResult.length);
    const communityIds = new Set(communityResult.map(r => r.id));
    const npcIds = new Set(npcResult.map(r => r.id));
    expect(communityIds).toEqual(npcIds);
  });
});
