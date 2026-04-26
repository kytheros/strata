import { describe, it, expect } from "vitest";
import { recallQdp } from "../../src/transports/recall-qdp.js";
import type { FusedCandidate } from "../../src/transports/recall-fusion.js";

const make = (id: string, content: string, tags: string[] = []): FusedCandidate => ({
  id, content, tags, source: "turn", score: 1, rrfScore: 1,
});

describe("recallQdp", () => {
  it("dedupes near-duplicate content (Jaccard ≥ threshold)", () => {
    const items: FusedCandidate[] = [
      make("a", "the password is moonstone"),
      make("b", "the password is moonstone"),
      make("c", "the password was moonstone"),
    ];
    const pruned = recallQdp(items, "what is the password");
    expect(pruned.length).toBeLessThanOrEqual(2);
    expect(pruned[0].id).toBe("a");
  });

  it("does NOT dedupe distinct content with shared tokens", () => {
    const items: FusedCandidate[] = [
      make("a", "the password is moonstone"),
      make("b", "I told her password about the back room"),
    ];
    const pruned = recallQdp(items, "password");
    expect(pruned.length).toBe(2);
  });

  it("filler filter drops short interrogative dialogue-only items", () => {
    const items: FusedCandidate[] = [
      make("a", "Nice weather today?", ["dialogue"]),
      make("b", "the password is moonstone", ["seed"]),
    ];
    const pruned = recallQdp(items, "password");
    expect(pruned.map(p => p.id)).toEqual(["b"]);
  });

  it("filler filter does NOT drop short non-dialogue items", () => {
    const items: FusedCandidate[] = [
      make("a", "Q: password when?", ["fact"]),
      make("b", "the password is moonstone", ["seed"]),
    ];
    const pruned = recallQdp(items, "password");
    expect(pruned.length).toBe(2);
  });

  it("filler filter does NOT drop long dialogue items", () => {
    const items: FusedCandidate[] = [
      make("a", "Have you got the password yet, blacksmith friend, after all these months?", ["dialogue"]),
      make("b", "the password is moonstone", ["seed"]),
    ];
    const pruned = recallQdp(items, "password");
    expect(pruned.length).toBe(2);
  });

  it("filler filter only matches when tags is exactly ['dialogue']", () => {
    // Use distinct content so dedupe doesn't collapse them; coverage on 'hello' covers all.
    const items: FusedCandidate[] = [
      make("a", "hello there?", ["dialogue", "greeting"]),
      make("b", "hello friend?", ["dialogue"]),
      make("c", "hello stranger?", []),
    ];
    const pruned = recallQdp(items, "hello");
    const ids = new Set(pruned.map(p => p.id));
    expect(ids.has("a")).toBe(true);     // multi-tag → not filler
    expect(ids.has("b")).toBe(false);    // exactly ['dialogue'] → filler, dropped
    expect(ids.has("c")).toBe(true);     // empty tags → not filler (rule needs 'dialogue' present)
  });

  it("query-coverage floor drops items with zero query-token overlap", () => {
    const items: FusedCandidate[] = [
      make("a", "the password is moonstone"),
      make("b", "completely unrelated babble about things"),
    ];
    const pruned = recallQdp(items, "password moonstone");
    expect(pruned.map(p => p.id)).toEqual(["a"]);
  });

  it("query-coverage floor uses minTokenLen — short query tokens are ignored", () => {
    const items: FusedCandidate[] = [
      make("a", "is a is a is a"),
      make("b", "the password is moonstone"),
    ];
    const pruned = recallQdp(items, "is a password");
    expect(pruned.map(p => p.id)).toEqual(["b"]);
  });

  it("returns empty array for empty input", () => {
    expect(recallQdp([], "anything")).toEqual([]);
  });

  it("composes all three rules in order", () => {
    const items: FusedCandidate[] = [
      make("a", "the password is moonstone"),
      make("b", "the password is moonstone"),
      make("c", "weather?", ["dialogue"]),
      make("d", "totally unrelated babble"),
      make("e", "moonstone is the secret password"),
    ];
    const pruned = recallQdp(items, "password moonstone");
    const ids = pruned.map(p => p.id);
    expect(ids).toContain("a");
    expect(ids).toContain("e");
    expect(ids).not.toContain("b");
    expect(ids).not.toContain("c");
    expect(ids).not.toContain("d");
  });
});
