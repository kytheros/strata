// strata/tests/embeddings/nomic-prefix.test.ts
import { describe, it, expect } from "vitest";
import { nomicPrefixFor } from "../../src/extensions/embeddings/nomic-prefix.js";

describe("nomicPrefixFor", () => {
  it("maps document task types to 'search_document: '", () => {
    expect(nomicPrefixFor("RETRIEVAL_DOCUMENT")).toBe("search_document: ");
  });
  it("maps query task types to 'search_query: '", () => {
    expect(nomicPrefixFor("RETRIEVAL_QUERY")).toBe("search_query: ");
    expect(nomicPrefixFor("CODE_RETRIEVAL_QUERY")).toBe("search_query: ");
  });
  it("defaults unknown/undefined to 'search_document: '", () => {
    expect(nomicPrefixFor(undefined)).toBe("search_document: ");
  });
});
