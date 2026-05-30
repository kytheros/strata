import { describe, it, expect, vi } from "vitest";
import {
  isVertexRateLimitError,
  computeBackoffDelay,
  withVertexBackoff,
} from "../../benchmarks/longmemeval/vertex-backoff.js";

describe("isVertexRateLimitError", () => {
  it("matches @google/genai ApiError with status=429", () => {
    const err = Object.assign(new Error("Quota exceeded"), { status: 429 });
    expect(isVertexRateLimitError(err)).toBe(true);
  });

  it("matches errors carrying code=429 instead of status", () => {
    const err = Object.assign(new Error("rate limited"), { code: 429 });
    expect(isVertexRateLimitError(err)).toBe(true);
  });

  it('matches a serialized message containing "code":429 + RESOURCE_EXHAUSTED', () => {
    const err = new Error(
      'ApiError: {"error":{"code":429,"message":"Resource exhausted. Please try again later.","status":"RESOURCE_EXHAUSTED"}}'
    );
    expect(isVertexRateLimitError(err)).toBe(true);
  });

  it("does NOT match a generic 500 error", () => {
    const err = Object.assign(new Error("Server error"), { status: 500 });
    expect(isVertexRateLimitError(err)).toBe(false);
  });

  it("does NOT match a message that only contains the number 429 without RESOURCE_EXHAUSTED", () => {
    const err = new Error("served 429 results");
    expect(isVertexRateLimitError(err)).toBe(false);
  });

  it("returns false for non-error inputs", () => {
    expect(isVertexRateLimitError(null)).toBe(false);
    expect(isVertexRateLimitError(undefined)).toBe(false);
    expect(isVertexRateLimitError("just a string")).toBe(false);
  });
});

describe("computeBackoffDelay", () => {
  it("grows exponentially with attempt index when jitter is zero", () => {
    const noJitter = () => 0.5; // jitterFraction * (1 - 1) = 0
    expect(computeBackoffDelay(0, 2000, 60000, 0, noJitter)).toBe(2000);
    expect(computeBackoffDelay(1, 2000, 60000, 0, noJitter)).toBe(4000);
    expect(computeBackoffDelay(2, 2000, 60000, 0, noJitter)).toBe(8000);
    expect(computeBackoffDelay(3, 2000, 60000, 0, noJitter)).toBe(16000);
  });

  it("caps the exponential at maxDelayMs", () => {
    const delay = computeBackoffDelay(10, 2000, 60000, 0, () => 0.5);
    expect(delay).toBe(60000);
  });

  it("applies symmetric jitter around the capped value", () => {
    // random()=0 → -jitter; random()=1 → +jitter
    const minDelay = computeBackoffDelay(0, 2000, 60000, 0.3, () => 0);
    const maxDelay = computeBackoffDelay(0, 2000, 60000, 0.3, () => 1);
    expect(minDelay).toBe(1400); // 2000 - 30%
    expect(maxDelay).toBe(2600); // 2000 + 30%
  });
});

describe("withVertexBackoff", () => {
  it("returns the value on a first-attempt success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withVertexBackoff(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 and returns the next successful value", async () => {
    const apiError = Object.assign(new Error("Quota exceeded"), { status: 429 });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(apiError)
      .mockRejectedValueOnce(apiError)
      .mockResolvedValue("recovered");

    const sleep = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();

    const result = await withVertexBackoff(fn, {
      sleep,
      log,
      baseDelayMs: 10,
      maxDelayMs: 100,
      jitterFraction: 0,
    });

    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry on non-429 errors", async () => {
    const apiError = Object.assign(new Error("bad request"), { status: 400 });
    const fn = vi.fn().mockRejectedValue(apiError);

    await expect(withVertexBackoff(fn)).rejects.toThrow("bad request");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("re-throws after exhausting maxRetries", async () => {
    const apiError = Object.assign(new Error("Quota exceeded"), { status: 429 });
    const fn = vi.fn().mockRejectedValue(apiError);

    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(
      withVertexBackoff(fn, {
        maxRetries: 2,
        sleep,
        log: () => {},
        baseDelayMs: 1,
        jitterFraction: 0,
      })
    ).rejects.toThrow("Quota exceeded");

    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
