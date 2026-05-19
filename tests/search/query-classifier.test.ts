import { describe, it, expect } from "vitest";
import {
  hasTemporalMarker,
  hasCurrentStateMarker,
  hasHistoricalMarker,
  isTemporalCurrentStateQuestion,
} from "../../src/search/query-classifier.js";

describe("query-classifier — two-signal temporal-current-state", () => {
  describe("hasTemporalMarker", () => {
    it.each([
      "What Node version am I using?",
      "Which Node version is installed?",
      "What version of npm do I have running?",
      "What model am I using?",
      "Which provider is active?",
    ])("fires on: %s", (q) => expect(hasTemporalMarker(q)).toBe(true));

    it.each([
      "How many shields did I order?",
      "Tell me about the weather",
    ])("does not fire on: %s", (q) => expect(hasTemporalMarker(q)).toBe(false));
  });

  describe("hasCurrentStateMarker", () => {
    it.each([
      "What version is the user on now?",
      "What am I currently using?",
      "What do I have today?",
      "What's my current setup?",
      "What version is the user on?",
      "Is the user on Node 22?",
    ])("fires on: %s", (q) => expect(hasCurrentStateMarker(q)).toBe(true));

    it.each([
      "What did I use last week?",
      "What was I on previously?",
    ])("does not fire on: %s", (q) => expect(hasCurrentStateMarker(q)).toBe(false));
  });

  describe("hasHistoricalMarker", () => {
    it.each([
      "What Node version did I see last year?",
      "What version was I on previously?",
      "Which version did I use originally?",
      "What did I have before the upgrade?",
      "What version did I run a month ago?",
      "What did I use back when I started?",
      "What did I have prior to the migration?",
    ])("fires on: %s", (q) => expect(hasHistoricalMarker(q)).toBe(true));

    it.each([
      "What Node version am I using now?",
      "What's my current setup?",
    ])("does not fire on: %s", (q) => expect(hasHistoricalMarker(q)).toBe(false));
  });

  describe("isTemporalCurrentStateQuestion", () => {
    it.each([
      "What Node version is the user on?",
      "What version am I currently using?",
      "Which Node version do I have now?",
      "What's my current Node version?",
    ])("fires on: %s", (q) => expect(isTemporalCurrentStateQuestion(q)).toBe(true));

    it.each([
      "What Node version did I see last year?",
      "What version was I on previously?",
      "Which Node version did I use originally?",
      "What version did I have before the upgrade?",
    ])("historical-marker veto: %s", (q) => expect(isTemporalCurrentStateQuestion(q)).toBe(false));

    it.each([
      "What Node version is in the docs?",
      "Tell me about Node 20",
    ])("no current-state marker: %s", (q) => expect(isTemporalCurrentStateQuestion(q)).toBe(false));
  });
});
