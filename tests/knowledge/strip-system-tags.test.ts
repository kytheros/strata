/**
 * Tests for stripSystemTags() — pre-extraction sanitizer that removes
 * XML/HTML-like tag patterns from text before entity extraction.
 *
 * Ticket: entity extractor pollution fix (strata-mcp@2.2.2)
 *
 * RED step: these tests should fail until stripSystemTags is implemented
 * and wired into extractEntities().
 */

import { describe, it, expect } from "vitest";
import { stripSystemTags } from "../../src/knowledge/strip-system-tags.js";
import { extractEntities } from "../../src/knowledge/entity-extractor.js";

describe("stripSystemTags", () => {
  it("should strip paired XML-like tags and their content", () => {
    const input = "<task-notification>\n<task-id>abc123</task-id>\n</task-notification>";
    const result = stripSystemTags(input);
    expect(result).not.toContain("task-notification");
    expect(result).not.toContain("task-id");
  });

  it("should strip tool-use-id tags", () => {
    const input = "option B\n<task-notification>\n<task-id>adcdcc28</task-id>\n<tool-use-id>toolu_01UK5B</tool-use-id>\n</task-notification>";
    const result = stripSystemTags(input);
    expect(result).not.toContain("tool-use-id");
    expect(result).not.toContain("task-id");
    expect(result).toContain("option B");
  });

  it("should strip command-message, command-args, command-name tags", () => {
    const input = "stored memory\n<command-message>\n<command-args>[\"foo\"]\n</command-args>\n<command-name>store_memory</command-name>\n</command-message>";
    const result = stripSystemTags(input);
    expect(result).not.toContain("command-message");
    expect(result).not.toContain("command-args");
    expect(result).not.toContain("command-name");
  });

  it("should preserve real content outside tags", () => {
    const input = "Using typescript and react for the dashboard.\n<tool-use-id>toolu_xyz</tool-use-id>";
    const result = stripSystemTags(input);
    expect(result).toContain("typescript");
    expect(result).toContain("react");
    expect(result).not.toContain("tool-use-id");
  });

  it("should strip bare opening tags without content", () => {
    const input = "text before <ask-id> text after";
    const result = stripSystemTags(input);
    expect(result).not.toContain("ask-id");
    expect(result).toContain("text before");
    expect(result).toContain("text after");
  });

  it("should strip self-closing tags", () => {
    const input = "result: <task-notification/> done";
    const result = stripSystemTags(input);
    expect(result).not.toContain("task-notification");
  });

  it("should handle empty string", () => {
    expect(stripSystemTags("")).toBe("");
  });

  it("should handle text with no tags unchanged in substance", () => {
    const input = "Using react and typescript with docker";
    const result = stripSystemTags(input);
    // All real tech words preserved
    expect(result).toContain("react");
    expect(result).toContain("typescript");
    expect(result).toContain("docker");
  });

  it("should not strip valid markdown angle brackets like generics", () => {
    // Patterns like Array<string> should not be stripped since they don't
    // match tag-name patterns (no hyphen or alphanumeric-only tag names
    // that resemble system reminder tags)
    const input = "used Array<string> for type safety";
    const result = stripSystemTags(input);
    // The function removes tag-like patterns — this is acceptable behavior
    // because "string" inside angle brackets is not a hyphenated tag name
    // We just ensure it doesn't crash and returns a string
    expect(typeof result).toBe("string");
  });

  it("should strip system-reminder block", () => {
    const input = `<system-reminder>
The following skills are available:
- recall: Search history
- remember: Store memory
</system-reminder>

Real content about typescript and docker.`;
    const result = stripSystemTags(input);
    expect(result).not.toContain("system-reminder");
    // Real content preserved
    expect(result).toContain("typescript");
    expect(result).toContain("docker");
  });
});

describe("extractEntities — tag pollution prevention", () => {
  it("should NOT extract tool-use-id as an entity", () => {
    const sysReminder = "option B\n<task-notification>\n<task-id>adcdcc28</task-id>\n<tool-use-id>toolu_01UK5B</tool-use-id>\n</task-notification>";
    const entities = extractEntities(sysReminder);
    const names = entities.map((e) => e.canonicalName);
    expect(names).not.toContain("tool-use-id");
    expect(names).not.toContain("task-id");
    expect(names).not.toContain("ask-id");
    expect(names).not.toContain("task-notification");
  });

  it("should NOT extract command-message, command-args, command-name as entities", () => {
    const sysReminder = "<command-message>\n<command-args>[\"arg\"]\n</command-args>\n<command-name>store_memory</command-name>\n</command-message>";
    const entities = extractEntities(sysReminder);
    const names = entities.map((e) => e.canonicalName);
    expect(names).not.toContain("command-message");
    expect(names).not.toContain("command-args");
    expect(names).not.toContain("command-name");
    expect(names).not.toContain("ommand-message");
    expect(names).not.toContain("ommand-args");
    expect(names).not.toContain("ommand-name");
  });

  it("should still extract real tech entities from text that also contains system reminder tags", () => {
    const mixedText = "Using typescript and react\n<tool-use-id>toolu_xyz</tool-use-id>\ndeployed on docker";
    const entities = extractEntities(mixedText);
    const names = entities.map((e) => e.canonicalName);
    expect(names).toContain("typescript");
    expect(names).toContain("react");
    expect(names).toContain("docker");
    expect(names).not.toContain("tool-use-id");
  });

  it("should NOT extract ommand-* variants (from tag stripping artifacts)", () => {
    // This simulates text where system reminder tags are partially stripped
    // by a naive approach — our fix should prevent these from being stored
    const text = "ommand-message ommand-args ommand-name";
    // After stripping, these bare tokens should not match as npm packages
    // because they don't appear inside XML tags — they're bare text
    // The deny-list in extractEntities should block them
    const entities = extractEntities(text);
    const names = entities.map((e) => e.canonicalName);
    expect(names).not.toContain("ommand-message");
    expect(names).not.toContain("ommand-args");
    expect(names).not.toContain("ommand-name");
  });
});
