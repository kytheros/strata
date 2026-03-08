import { describe, it, expect, beforeEach, vi } from "vitest";
import { ContextBudgetManager } from "../../src/utils/context-budgeter.js";

describe("ContextBudgetManager", () => {
  describe("token counting", () => {
    it("should count ASCII text tokens heuristically", () => {
      const mgr = new ContextBudgetManager();
      // "Hello world" = 11 chars ASCII → ceil(11/4) = 3 raw tokens
      // + safety buffer: min(ceil(3*0.05), 1000) = 1
      const tokens = mgr.countTokens("Hello world");
      expect(tokens).toBeGreaterThanOrEqual(3);
      expect(tokens).toBeLessThan(10);
    });

    it("should count CJK characters at ~1.3 tokens each", () => {
      const mgr = new ContextBudgetManager();
      // 5 CJK chars → ceil(5 * 1.3) = 7 raw + buffer
      const tokens = mgr.countTokens("你好世界啊");
      expect(tokens).toBeGreaterThanOrEqual(7);
    });

    it("should handle mixed ASCII and CJK", () => {
      const mgr = new ContextBudgetManager();
      const tokens = mgr.countTokens("Hello 你好");
      expect(tokens).toBeGreaterThan(0);
    });

    it("should apply safety buffer", () => {
      const mgr = new ContextBudgetManager();
      // Large text: buffer should be meaningful
      const longText = "a".repeat(4000); // 4000 chars → ~1000 raw tokens
      const tokens = mgr.countTokens(longText);
      // Should be more than raw 1000 due to buffer
      expect(tokens).toBeGreaterThan(1000);
    });

    it("should cap safety buffer at 1000", () => {
      const mgr = new ContextBudgetManager();
      // Very large text: buffer should cap at 1000
      const hugeText = "a".repeat(400000); // 100k raw tokens
      const tokens = mgr.countTokens(hugeText);
      // Buffer = min(ceil(100000 * 0.05), 1000) = 1000
      expect(tokens).toBeLessThanOrEqual(100000 + 1000 + 1); // +1 for rounding
    });

    it("should return 0 for empty string", () => {
      const mgr = new ContextBudgetManager();
      const tokens = mgr.countTokens("");
      expect(tokens).toBe(0);
    });
  });

  describe("budget allocation", () => {
    it("should compute conversation budget with 40% EC claim", () => {
      // Default: 200000 window - 10000 overhead - 4096 output = 185904 available
      // EC claim: 40% of 185904 = 74361
      // Conversation budget: 185904 - 74361 = 111543
      const mgr = new ContextBudgetManager();
      const budget = mgr.getConversationBudget();
      expect(budget).toBeGreaterThan(100000);
      expect(budget).toBeLessThan(200000);
    });

    it("should compute with custom context window", () => {
      const mgr = new ContextBudgetManager({}, 100000);
      const budget = mgr.getConversationBudget();
      // 100000 - 10000 - 4096 = 85904 available, 60% = 51542
      expect(budget).toBeGreaterThan(40000);
      expect(budget).toBeLessThan(100000);
    });
  });

  describe("threshold callbacks", () => {
    it("should fire warning at 70% utilization", () => {
      const onWarning = vi.fn();
      const mgr = new ContextBudgetManager({ onWarning }, 100000);
      const budget = mgr.getConversationBudget();

      // Record usage at 71%
      mgr.recordTokenUsage(Math.ceil(budget * 0.71));
      expect(onWarning).toHaveBeenCalledTimes(1);
    });

    it("should fire compaction at 80% utilization", () => {
      const onCompaction = vi.fn();
      const mgr = new ContextBudgetManager({ onCompaction }, 100000);
      const budget = mgr.getConversationBudget();

      mgr.recordTokenUsage(Math.ceil(budget * 0.81));
      expect(onCompaction).toHaveBeenCalledTimes(1);
    });

    it("should fire critical at 95% utilization", () => {
      const onCritical = vi.fn();
      const mgr = new ContextBudgetManager({ onCritical }, 100000);
      const budget = mgr.getConversationBudget();

      mgr.recordTokenUsage(Math.ceil(budget * 0.96));
      expect(onCritical).toHaveBeenCalledTimes(1);
    });

    it("should fire each threshold exactly once", () => {
      const onWarning = vi.fn();
      const onCompaction = vi.fn();
      const onCritical = vi.fn();
      const mgr = new ContextBudgetManager(
        { onWarning, onCompaction, onCritical },
        100000
      );
      const budget = mgr.getConversationBudget();

      // Hit critical (fires all three)
      mgr.recordTokenUsage(Math.ceil(budget * 0.96));
      expect(onWarning).toHaveBeenCalledTimes(1);
      expect(onCompaction).toHaveBeenCalledTimes(1);
      expect(onCritical).toHaveBeenCalledTimes(1);

      // Record again — should NOT fire again
      mgr.recordTokenUsage(Math.ceil(budget * 0.97));
      expect(onWarning).toHaveBeenCalledTimes(1);
      expect(onCompaction).toHaveBeenCalledTimes(1);
      expect(onCritical).toHaveBeenCalledTimes(1);
    });

    it("should reset threshold flags", () => {
      const onWarning = vi.fn();
      const mgr = new ContextBudgetManager({ onWarning }, 100000);
      const budget = mgr.getConversationBudget();

      mgr.recordTokenUsage(Math.ceil(budget * 0.71));
      expect(onWarning).toHaveBeenCalledTimes(1);

      mgr.reset();
      mgr.recordTokenUsage(Math.ceil(budget * 0.71));
      expect(onWarning).toHaveBeenCalledTimes(2);
    });
  });

  describe("budget status", () => {
    it("should report correct utilization", () => {
      const mgr = new ContextBudgetManager({}, 100000);
      const budget = mgr.getConversationBudget();

      mgr.recordTokenUsage(Math.floor(budget * 0.5));
      const status = mgr.getBudgetStatus();

      expect(status.utilizationPercent).toBe(50);
      expect(status.total).toBe(budget);
      expect(status.available).toBeGreaterThan(0);
    });

    it("should detect budget exceeded", () => {
      const mgr = new ContextBudgetManager({}, 100000);
      const budget = mgr.getConversationBudget();

      mgr.recordTokenUsage(budget + 1000);
      expect(mgr.isBudgetExceeded()).toBe(true);
    });

    it("should not report exceeded when within budget", () => {
      const mgr = new ContextBudgetManager({}, 100000);
      mgr.recordTokenUsage(1000);
      expect(mgr.isBudgetExceeded()).toBe(false);
    });
  });
});
