import { describe, it, expect } from "vitest";
import { ParserRegistry } from "../../src/parsers/parser-registry.js";
import type { ConversationParser } from "../../src/parsers/parser-interface.js";
import type { ParsedSession, SessionFileInfo } from "../../src/parsers/session-parser.js";

/** Minimal mock parser for testing the registry */
function makeMockParser(overrides: Partial<ConversationParser> = {}): ConversationParser {
  return {
    id: "mock",
    name: "Mock Parser",
    detect: () => true,
    discover: () => [],
    parse: () => null,
    ...overrides,
  };
}

describe("ParserRegistry", () => {
  it("should register a parser", () => {
    const registry = new ParserRegistry();
    const parser = makeMockParser({ id: "test-parser" });

    registry.register(parser);
    expect(registry.getAll()).toHaveLength(1);
    expect(registry.getAll()[0].id).toBe("test-parser");
  });

  it("should reject duplicate parser IDs", () => {
    const registry = new ParserRegistry();
    registry.register(makeMockParser({ id: "dup" }));

    expect(() => registry.register(makeMockParser({ id: "dup" }))).toThrow(
      'Parser with id "dup" is already registered'
    );
  });

  it("should register multiple parsers with different IDs", () => {
    const registry = new ParserRegistry();
    registry.register(makeMockParser({ id: "a" }));
    registry.register(makeMockParser({ id: "b" }));
    registry.register(makeMockParser({ id: "c" }));

    expect(registry.getAll()).toHaveLength(3);
  });

  it("should get parser by ID", () => {
    const registry = new ParserRegistry();
    registry.register(makeMockParser({ id: "target", name: "Target Parser" }));
    registry.register(makeMockParser({ id: "other", name: "Other Parser" }));

    const found = registry.getById("target");
    expect(found).toBeDefined();
    expect(found!.name).toBe("Target Parser");
  });

  it("should return undefined for unknown parser ID", () => {
    const registry = new ParserRegistry();
    expect(registry.getById("non-existent")).toBeUndefined();
  });

  it("should detect available parsers", () => {
    const registry = new ParserRegistry();
    registry.register(makeMockParser({ id: "available", detect: () => true }));
    registry.register(makeMockParser({ id: "unavailable", detect: () => false }));
    registry.register(makeMockParser({ id: "also-available", detect: () => true }));

    const available = registry.detectAvailable();
    expect(available).toHaveLength(2);
    expect(available.map((p) => p.id)).toContain("available");
    expect(available.map((p) => p.id)).toContain("also-available");
    expect(available.map((p) => p.id)).not.toContain("unavailable");
  });

  it("should return empty array when no parsers detected", () => {
    const registry = new ParserRegistry();
    registry.register(makeMockParser({ id: "a", detect: () => false }));

    expect(registry.detectAvailable()).toEqual([]);
  });

  it("should return empty array when no parsers registered", () => {
    const registry = new ParserRegistry();
    expect(registry.getAll()).toEqual([]);
    expect(registry.detectAvailable()).toEqual([]);
  });
});
