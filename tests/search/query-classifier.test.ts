import { describe, it, expect } from "vitest";
import {
  hasTemporalMarker,
  hasCurrentStateMarker,
  hasHistoricalMarker,
  isTemporalCurrentStateQuestion,
  isExistentialQuestion,
  isAggregationQuery,
} from "../../src/search/query-classifier.js";

describe("isAggregationQuery (C1 trigger, #37)", () => {
  it("fires on discrete counting", () => {
    expect(isAggregationQuery("How many plants did I acquire in the last month?")).toBe(true);
    expect(isAggregationQuery("What is the total number of goals and assists I have?")).toBe(true);
  });
  it("fires on duration/sum aggregation", () => {
    expect(isAggregationQuery("How many hours in total did I spend driving?")).toBe(true);
    expect(isAggregationQuery("How much total money have I spent on bike-related expenses?")).toBe(true);
  });
  it("does not fire on plain factual or temporal queries", () => {
    expect(isAggregationQuery("What did I decide about the database migration?")).toBe(false);
    expect(isAggregationQuery("When did I visit the dentist?")).toBe(false);
  });
});

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

describe("isExistentialQuestion", () => {
  it('matches "Is X a Y" pattern (target: ranking-002 query)', () => {
    expect(isExistentialQuestion("Is semantic search a Pro feature?")).toBe(true);
  });

  it('matches "Is X the Y" pattern', () => {
    expect(isExistentialQuestion("Is React the framework we use?")).toBe(true);
  });

  it('matches "Is X an Y" pattern', () => {
    expect(isExistentialQuestion("Is SQLite an option?")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isExistentialQuestion("is x a y")).toBe(true);
    expect(isExistentialQuestion("IS X A Y")).toBe(true);
  });

  it('does not match "Was X a Y" (past tense)', () => {
    expect(isExistentialQuestion("Was X a Y?")).toBe(false);
  });

  it('does not match "What is X" (no article + noun after subject)', () => {
    expect(isExistentialQuestion("What is X?")).toBe(false);
  });

  it("does not match queries that don't start with Is", () => {
    expect(isExistentialQuestion("Tell me, is X a Y?")).toBe(false);
    expect(isExistentialQuestion("X is a Y, right?")).toBe(false);
  });

  it("does not match when there's no second token after the article", () => {
    // "Is X a?" — incomplete; should not fire.
    expect(isExistentialQuestion("Is X a?")).toBe(false);
  });
});

describe("isTemporalCurrentStateQuestion — composite with existential short-circuit", () => {
  it('fires on existential question lacking other markers (target: ranking-002)', () => {
    expect(isTemporalCurrentStateQuestion("Is semantic search a Pro feature?")).toBe(true);
  });

  it("historical veto still wins even on existential phrasing", () => {
    expect(isTemporalCurrentStateQuestion("Is X previously a Y?")).toBe(false);
  });

  it("existing temporal+current-state path still works (no regression)", () => {
    expect(isTemporalCurrentStateQuestion("What Node version is the user on now?")).toBe(true);
  });

  it("non-existential query without temporal/current markers still does not fire", () => {
    expect(isTemporalCurrentStateQuestion("What's the storage layer?")).toBe(false);
  });
});
