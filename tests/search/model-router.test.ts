/**
 * Model-aware retrieval routing tests (Tier 2C).
 *
 * Tests cover: model detection, profile resolution, retrieval parameter
 * lookup, disabled routing, unknown models, and edge cases.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  detectModelProfile,
  getRetrievalParams,
  resolveModelRouting,
} from "../../src/search/model-router.js";
import type { ModelProfile } from "../../src/search/model-router.js";
import { CONFIG } from "../../src/config.js";

// ---------------------------------------------------------------------------
// Helpers — temporarily override CONFIG.modelRouting for tests
// ---------------------------------------------------------------------------

// Save original values and restore after each test to avoid cross-contamination
let originalEnabled: boolean;
let originalDefault: string;

beforeEach(() => {
  originalEnabled = CONFIG.modelRouting.enabled as unknown as boolean;
  originalDefault = CONFIG.modelRouting.defaultProfile as string;
});

afterEach(() => {
  (CONFIG.modelRouting as any).enabled = originalEnabled;
  (CONFIG.modelRouting as any).defaultProfile = originalDefault;
});

function setEnabled(v: boolean) {
  (CONFIG.modelRouting as any).enabled = v;
}

function setDefault(v: ModelProfile) {
  (CONFIG.modelRouting as any).defaultProfile = v;
}

// ---------------------------------------------------------------------------
// detectModelProfile
// ---------------------------------------------------------------------------

describe("detectModelProfile", () => {
  it("detects Gemini Flash as large", () => {
    expect(detectModelProfile("gemini-2.0-flash")).toBe("large");
    expect(detectModelProfile("gemini-1.5-flash-001")).toBe("large");
  });

  it("detects Gemini Pro as large", () => {
    expect(detectModelProfile("gemini-1.5-pro")).toBe("large");
    expect(detectModelProfile("gemini-2.0-pro-exp")).toBe("large");
  });

  it("detects Claude Opus as large", () => {
    expect(detectModelProfile("claude-opus-4")).toBe("large");
    expect(detectModelProfile("claude-3-opus-20240229")).toBe("large");
  });

  it("detects GPT-4 variants as medium", () => {
    expect(detectModelProfile("gpt-4o")).toBe("medium");
    expect(detectModelProfile("gpt-4-turbo")).toBe("medium");
    expect(detectModelProfile("gpt-4o-mini")).toBe("medium");
  });

  it("detects Claude Sonnet as medium", () => {
    expect(detectModelProfile("claude-sonnet-4-20250514")).toBe("medium");
    expect(detectModelProfile("claude-3-sonnet")).toBe("medium");
  });

  it("detects Claude Haiku as medium", () => {
    expect(detectModelProfile("claude-3-haiku")).toBe("medium");
    expect(detectModelProfile("claude-3.5-haiku")).toBe("medium");
  });

  it("detects GPT-3 as small", () => {
    expect(detectModelProfile("gpt-3.5-turbo")).toBe("small");
  });

  it("detects local models as small", () => {
    expect(detectModelProfile("llama-3.1-8b")).toBe("small");
    expect(detectModelProfile("mistral-7b-instruct")).toBe("small");
    expect(detectModelProfile("phi-3-mini")).toBe("small");
    expect(detectModelProfile("qwen-2.5-coder")).toBe("small");
  });

  it("returns default profile for unknown models", () => {
    setDefault("medium");
    expect(detectModelProfile("some-unknown-model-v2")).toBe("medium");
  });

  it("returns default profile for undefined input", () => {
    setDefault("medium");
    expect(detectModelProfile(undefined)).toBe("medium");
    expect(detectModelProfile("")).toBe("medium");
  });

  it("respects the configured default profile", () => {
    setDefault("small");
    expect(detectModelProfile("unknown-model")).toBe("small");

    setDefault("large");
    expect(detectModelProfile("unknown-model")).toBe("large");
  });

  it("is case-insensitive", () => {
    expect(detectModelProfile("GEMINI-2.0-FLASH")).toBe("large");
    expect(detectModelProfile("Claude-3-Sonnet")).toBe("medium");
    expect(detectModelProfile("LLAMA-3")).toBe("small");
  });
});

// ---------------------------------------------------------------------------
// getRetrievalParams
// ---------------------------------------------------------------------------

describe("getRetrievalParams", () => {
  it("returns large profile params", () => {
    const params = getRetrievalParams("large");
    expect(params.sessionTopK).toBe(20);
    expect(params.useReranker).toBe(true);
  });

  it("returns medium profile params", () => {
    const params = getRetrievalParams("medium");
    expect(params.sessionTopK).toBe(10);
    expect(params.useReranker).toBe(true);
  });

  it("returns small profile params", () => {
    const params = getRetrievalParams("small");
    expect(params.sessionTopK).toBe(5);
    expect(params.useReranker).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveModelRouting
// ---------------------------------------------------------------------------

describe("resolveModelRouting", () => {
  it("returns null when routing is disabled", () => {
    setEnabled(false);
    expect(resolveModelRouting("gemini-2.0-flash")).toBeNull();
    expect(resolveModelRouting("gpt-4o")).toBeNull();
    expect(resolveModelRouting(undefined)).toBeNull();
  });

  it("returns correct params when enabled with known model", () => {
    setEnabled(true);

    const flash = resolveModelRouting("gemini-2.0-flash");
    expect(flash).not.toBeNull();
    expect(flash!.sessionTopK).toBe(20);
    expect(flash!.useReranker).toBe(true);

    const gpt4 = resolveModelRouting("gpt-4o");
    expect(gpt4).not.toBeNull();
    expect(gpt4!.sessionTopK).toBe(10);
    expect(gpt4!.useReranker).toBe(true);

    const llama = resolveModelRouting("llama-3.1-8b");
    expect(llama).not.toBeNull();
    expect(llama!.sessionTopK).toBe(5);
    expect(llama!.useReranker).toBe(false);
  });

  it("returns default profile params when enabled with unknown model", () => {
    setEnabled(true);
    setDefault("medium");

    const unknown = resolveModelRouting("some-custom-model");
    expect(unknown).not.toBeNull();
    expect(unknown!.sessionTopK).toBe(10);
    expect(unknown!.useReranker).toBe(true);
  });

  it("returns default profile params when enabled with no model", () => {
    setEnabled(true);
    setDefault("small");

    const noModel = resolveModelRouting(undefined);
    expect(noModel).not.toBeNull();
    expect(noModel!.sessionTopK).toBe(5);
    expect(noModel!.useReranker).toBe(false);
  });
});
