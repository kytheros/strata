import { describe, it, expect } from "vitest";
import {
  extractEntities,
  extractRelations,
  isJunkEntityName,
  type ExtractedEntity,
} from "../../src/knowledge/entity-extractor.js";

// 2026-06-12 audit regressions: junk shapes that polluted the founder
// corpus entity graph (8,657 entities, 81.5% typed "library" because
// NPM_PATTERN matches any hyphenated token).
describe("extractEntities — junk filtering", () => {
  it("does not extract tool-output artifact tags as entities", () => {
    const names = extractEntities(
      "the output-file tag and local-command-caveat block plus a teammate-message arrived"
    ).map((e) => e.canonicalName);
    expect(names).not.toContain("output-file");
    expect(names).not.toContain("local-command-caveat");
    expect(names).not.toContain("teammate-message");
  });

  it("does not extract dates, numeric ranges, or hex fragments", () => {
    const names = extractEntities(
      "between 2026-03-26 and 2026-04-01 we saw 184-188 failures (commit 10f031e-57f9-4658)"
    ).map((e) => e.canonicalName);
    expect(names).not.toContain("2026-03-26");
    expect(names).not.toContain("2026-04-01");
    expect(names).not.toContain("184-188");
    expect(names).not.toContain("10f031e-57f9-4658");
  });

  it("does not extract names with embedded ISO timestamps", () => {
    const names = extractEntities(
      "saved to results-2026-03-26T14-30-00.json for later analysis"
    ).map((e) => e.canonicalName);
    expect(names.some((n) => n.includes("2026-03-26t14"))).toBe(false);
  });

  it("normalizes trailing sentence punctuation instead of minting dup entities", () => {
    const entities = extractEntities("we hardened multi-session. Later multi-session retrieval improved");
    const matches = entities.filter((e) => e.canonicalName.startsWith("multi-session"));
    expect(matches).toHaveLength(1);
    expect(matches[0].canonicalName).toBe("multi-session");
  });

  it("still extracts real hyphenated packages", () => {
    // (better-sqlite3 resolves through ALIAS_MAP → canonical "sqlite",
    // so use packages outside the alias map here.)
    const names = extractEntities(
      "we use drizzle-orm and node-fetch in the worker"
    ).map((e) => e.canonicalName);
    expect(names).toContain("drizzle-orm");
    expect(names).toContain("node-fetch");
  });
});

describe("isJunkEntityName", () => {
  it("flags numeric/date/range/hex shapes", () => {
    expect(isJunkEntityName("2026-03-26")).toBe(true);
    expect(isJunkEntityName("1-2")).toBe(true);
    expect(isJunkEntityName("184-188")).toBe(true);
    expect(isJunkEntityName("1920x1080-3.5")).toBe(true);
    expect(isJunkEntityName("10f031e-57f9-4658-84c2")).toBe(true);
  });

  it("keeps real package-like names", () => {
    expect(isJunkEntityName("better-sqlite3")).toBe(false);
    expect(isJunkEntityName("node-fetch")).toBe(false);
    expect(isJunkEntityName("gpt-4o")).toBe(false);
    // all-hex English compound without digits stays
    expect(isJunkEntityName("added-fee")).toBe(false);
  });
});

describe("extractEntities", () => {
  it("should return empty array for empty input", () => {
    expect(extractEntities("")).toEqual([]);
    expect(extractEntities("   ")).toEqual([]);
  });

  it("should return empty array for text with only stop words", () => {
    expect(extractEntities("it is the a an")).toEqual([]);
  });

  it("should extract known aliases and resolve to canonical names", () => {
    const entities = extractEntities("decided to use better-sqlite3 instead of pg for local storage");
    const names = entities.map((e) => e.canonicalName);
    expect(names).toContain("sqlite");
    expect(names).toContain("postgresql");
  });

  it("should classify pg as library type via alias map", () => {
    const entities = extractEntities("we chose pg for database access");
    const pg = entities.find((e) => e.canonicalName === "postgresql");
    expect(pg).toBeDefined();
    expect(pg!.type).toBe("service");
  });

  it("should resolve postgres/postgresql/pg to same canonical", () => {
    const e1 = extractEntities("using postgres");
    const e2 = extractEntities("using postgresql");
    const e3 = extractEntities("using pg driver");
    expect(e1[0]?.canonicalName).toBe("postgresql");
    expect(e2[0]?.canonicalName).toBe("postgresql");
    expect(e3[0]?.canonicalName).toBe("postgresql");
  });

  it("should resolve js/javascript to javascript", () => {
    const e1 = extractEntities("wrote it in js");
    const e2 = extractEntities("using javascript");
    expect(e1[0]?.canonicalName).toBe("javascript");
    expect(e2[0]?.canonicalName).toBe("javascript");
  });

  it("should resolve ts/typescript to typescript", () => {
    const e1 = extractEntities("migrated to ts");
    const e2 = extractEntities("using typescript");
    expect(e1[0]?.canonicalName).toBe("typescript");
    expect(e2[0]?.canonicalName).toBe("typescript");
  });

  it("should resolve node/nodejs to nodejs", () => {
    const e = extractEntities("running on nodejs server");
    expect(e[0]?.canonicalName).toBe("nodejs");
  });

  it("should resolve react/reactjs to react", () => {
    const e = extractEntities("built with reactjs");
    expect(e[0]?.canonicalName).toBe("react");
  });

  it("should resolve py/python/python3 to python", () => {
    const e = extractEntities("wrote a python script");
    expect(e[0]?.canonicalName).toBe("python");
  });

  it("should resolve k8s/kubernetes to kubernetes", () => {
    const e1 = extractEntities("deployed to k8s");
    const e2 = extractEntities("kubernetes cluster");
    expect(e1[0]?.canonicalName).toBe("kubernetes");
    expect(e2[0]?.canonicalName).toBe("kubernetes");
  });

  it("should classify docker as tool", () => {
    const e = extractEntities("containerized with docker");
    expect(e[0]?.type).toBe("tool");
  });

  it("should classify redis as service", () => {
    const e = extractEntities("caching in redis");
    expect(e[0]?.type).toBe("service");
  });

  it("should classify vitest as library", () => {
    const e = extractEntities("testing with vitest");
    expect(e[0]?.type).toBe("library");
  });

  it("should classify react as framework", () => {
    const e = extractEntities("built the UI in react");
    expect(e[0]?.type).toBe("framework");
  });

  it("should extract npm scoped packages", () => {
    const entities = extractEntities("installed @modelcontextprotocol/sdk for MCP support");
    const sdk = entities.find((e) => e.canonicalName === "@modelcontextprotocol/sdk");
    expect(sdk).toBeDefined();
    expect(sdk!.type).toBe("library");
  });

  it("should extract npm packages with hyphens", () => {
    const entities = extractEntities("added fast-json-stringify for serialization");
    const pkg = entities.find((e) => e.canonicalName === "fast-json-stringify");
    expect(pkg).toBeDefined();
    expect(pkg!.type).toBe("library");
  });

  it("should extract Unix file paths", () => {
    const entities = extractEntities("edited the file at /src/storage/database.ts");
    const file = entities.find((e) => e.type === "file");
    expect(file).toBeDefined();
    expect(file!.canonicalName).toContain("/src/storage");
  });

  it("should extract URLs as service type", () => {
    const entities = extractEntities("deployed to https://api.example.com/v1");
    const url = entities.find((e) => e.type === "service" && e.canonicalName.includes("example.com"));
    expect(url).toBeDefined();
  });

  it("should deduplicate entities by canonical name", () => {
    const entities = extractEntities("used react and react and react");
    const reactCount = entities.filter((e) => e.canonicalName === "react").length;
    expect(reactCount).toBe(1);
  });

  it("should extract multiple entities from one text", () => {
    const entities = extractEntities(
      "switched from jest to vitest, deployed with docker on kubernetes"
    );
    const names = entities.map((e) => e.canonicalName);
    expect(names).toContain("jest");
    expect(names).toContain("vitest");
    expect(names).toContain("docker");
    expect(names).toContain("kubernetes");
  });

  it("should complete extraction in under 5ms for 2000 chars", () => {
    const text = "Using react and typescript with docker and kubernetes for deployment. ".repeat(30);
    expect(text.length).toBeGreaterThan(2000);

    const start = performance.now();
    extractEntities(text);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(5);
  });

  it("should handle mongo/mongodb alias", () => {
    const e = extractEntities("storing data in mongo");
    expect(e[0]?.canonicalName).toBe("mongodb");
  });

  it("should handle mysql", () => {
    const e = extractEntities("migrated the mysql database");
    expect(e[0]?.canonicalName).toBe("mysql");
  });
});

describe("extractRelations", () => {
  function makeEntities(...names: string[]): ExtractedEntity[] {
    return names.map((n) => ({
      name: n,
      type: "library" as const,
      canonicalName: n.toLowerCase(),
    }));
  }

  it("should return empty for less than 2 entities", () => {
    const entities = makeEntities("react");
    expect(extractRelations("using react", entities)).toEqual([]);
  });

  it("should extract replaced_by from 'switched from X to Y'", () => {
    const text = "switched from MySQL to PostgreSQL for better JSON support";
    const entities: ExtractedEntity[] = [
      { name: "MySQL", type: "service", canonicalName: "mysql" },
      { name: "PostgreSQL", type: "service", canonicalName: "postgresql" },
    ];
    const rels = extractRelations(text, entities);
    const replaced = rels.find((r) => r.relationType === "replaced_by");
    expect(replaced).toBeDefined();
    expect(replaced!.sourceCanonical).toBe("mysql");
    expect(replaced!.targetCanonical).toBe("postgresql");
    expect(replaced!.context.length).toBeLessThanOrEqual(200);
  });

  it("should extract replaced_by from 'replaced X with Y'", () => {
    const text = "replaced jest with vitest for testing";
    const entities: ExtractedEntity[] = [
      { name: "jest", type: "library", canonicalName: "jest" },
      { name: "vitest", type: "library", canonicalName: "vitest" },
    ];
    const rels = extractRelations(text, entities);
    const replaced = rels.find((r) => r.relationType === "replaced_by");
    expect(replaced).toBeDefined();
    expect(replaced!.sourceCanonical).toBe("jest");
    expect(replaced!.targetCanonical).toBe("vitest");
  });

  it("should fall back to co_occurs when no directional pattern matches", () => {
    const text = "configured docker and redis in the development environment";
    const entities: ExtractedEntity[] = [
      { name: "docker", type: "tool", canonicalName: "docker" },
      { name: "redis", type: "service", canonicalName: "redis" },
    ];
    const rels = extractRelations(text, entities);
    expect(rels.length).toBe(1);
    expect(rels[0].relationType).toBe("co_occurs");
  });

  it("should not create duplicate relations", () => {
    const text = "switched from jest to vitest. switched from jest to vitest again.";
    const entities: ExtractedEntity[] = [
      { name: "jest", type: "library", canonicalName: "jest" },
      { name: "vitest", type: "library", canonicalName: "vitest" },
    ];
    const rels = extractRelations(text, entities);
    const replaced = rels.filter((r) => r.relationType === "replaced_by");
    expect(replaced.length).toBe(1);
  });

  it("should truncate context to 200 chars", () => {
    const longText = "switched from jest to vitest " + "x".repeat(300);
    const entities: ExtractedEntity[] = [
      { name: "jest", type: "library", canonicalName: "jest" },
      { name: "vitest", type: "library", canonicalName: "vitest" },
    ];
    const rels = extractRelations(longText, entities);
    for (const r of rels) {
      expect(r.context.length).toBeLessThanOrEqual(200);
    }
  });
});
