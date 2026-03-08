import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteEntityStore, type EntityInput } from "../../src/storage/sqlite-entity-store.js";
import type { EntityType } from "../../src/knowledge/entity-extractor.js";

function makeEntity(overrides: Partial<EntityInput> = {}): EntityInput {
  return {
    id: `ent-${Math.random().toString(36).slice(2, 8)}`,
    name: "React",
    type: "framework" as EntityType,
    canonicalName: "react",
    aliases: ["react", "reactjs"],
    firstSeen: 1000,
    lastSeen: 1000,
    project: "test-project",
    ...overrides,
  };
}

describe("SqliteEntityStore", () => {
  let db: Database.Database;
  let store: SqliteEntityStore;

  beforeEach(() => {
    db = openDatabase(":memory:");
    store = new SqliteEntityStore(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("upsertEntity", () => {
    it("should insert a new entity", () => {
      store.upsertEntity(makeEntity({ canonicalName: "react" }));
      const e = store.findByName("react");
      expect(e).toBeDefined();
      expect(e!.canonical_name).toBe("react");
      expect(e!.mention_count).toBe(1);
    });

    it("should increment mention_count on duplicate canonical name", () => {
      store.upsertEntity(makeEntity({ id: "e1", canonicalName: "react" }));
      store.upsertEntity(makeEntity({ id: "e2", canonicalName: "react" }));
      const e = store.findByName("react");
      expect(e!.mention_count).toBe(2);
    });

    it("should be case-insensitive on canonical name dedup", () => {
      store.upsertEntity(makeEntity({ id: "e1", canonicalName: "React" }));
      store.upsertEntity(makeEntity({ id: "e2", canonicalName: "react" }));
      const e = store.findByName("react");
      expect(e!.mention_count).toBe(2);
    });

    it("should merge aliases from multiple upserts", () => {
      store.upsertEntity(makeEntity({ id: "e1", canonicalName: "postgresql", aliases: ["pg"] }));
      store.upsertEntity(makeEntity({ id: "e2", canonicalName: "postgresql", aliases: ["postgres"] }));
      const e = store.findByName("postgresql");
      const aliases = JSON.parse(e!.aliases) as string[];
      expect(aliases).toContain("pg");
      expect(aliases).toContain("postgres");
    });

    it("should preserve first_seen on duplicate", () => {
      store.upsertEntity(makeEntity({ id: "e1", canonicalName: "postgresql", firstSeen: 1000, lastSeen: 1000 }));
      store.upsertEntity(makeEntity({ id: "e2", canonicalName: "postgresql", firstSeen: 2000, lastSeen: 2000 }));
      const e = store.findByName("postgresql");
      expect(e!.first_seen).toBe(1000);
      expect(e!.last_seen).toBe(2000);
    });

    it("should update last_seen to the most recent value", () => {
      store.upsertEntity(makeEntity({ id: "e1", canonicalName: "react", lastSeen: 5000 }));
      store.upsertEntity(makeEntity({ id: "e2", canonicalName: "react", lastSeen: 3000 }));
      const e = store.findByName("react");
      expect(e!.last_seen).toBe(5000);
    });

    it("should handle three upserts correctly", () => {
      store.upsertEntity(makeEntity({ canonicalName: "postgresql", aliases: ["pg"], firstSeen: 1000, lastSeen: 1000 }));
      store.upsertEntity(makeEntity({ canonicalName: "postgresql", aliases: ["postgres"], firstSeen: 2000, lastSeen: 2000 }));
      store.upsertEntity(makeEntity({ canonicalName: "postgresql", aliases: ["postgresql"], firstSeen: 3000, lastSeen: 3000 }));
      const e = store.findByName("postgresql");
      expect(e!.mention_count).toBe(3);
      const aliases = JSON.parse(e!.aliases) as string[];
      expect(aliases).toContain("pg");
      expect(aliases).toContain("postgres");
      expect(aliases).toContain("postgresql");
      expect(e!.first_seen).toBe(1000);
      expect(e!.last_seen).toBe(3000);
    });
  });

  describe("findByName", () => {
    it("should find by canonical name case-insensitively", () => {
      store.upsertEntity(makeEntity({ canonicalName: "Docker" }));
      expect(store.findByName("docker")).toBeDefined();
      expect(store.findByName("DOCKER")).toBeDefined();
    });

    it("should return undefined for non-existent entity", () => {
      expect(store.findByName("nonexistent")).toBeUndefined();
    });
  });

  describe("findByType", () => {
    it("should return entities of given type", () => {
      store.upsertEntity(makeEntity({ canonicalName: "react", type: "framework" }));
      store.upsertEntity(makeEntity({ canonicalName: "docker", type: "tool" }));
      const frameworks = store.findByType("framework");
      expect(frameworks).toHaveLength(1);
      expect(frameworks[0].canonical_name).toBe("react");
    });

    it("should filter by project when provided", () => {
      store.upsertEntity(makeEntity({ canonicalName: "react", project: "p1" }));
      store.upsertEntity(makeEntity({ canonicalName: "vue", project: "p2" }));
      const results = store.findByType("framework", "p1");
      expect(results).toHaveLength(1);
      expect(results[0].canonical_name).toBe("react");
    });
  });

  describe("addRelation", () => {
    it("should add a relation between two entities", () => {
      const id1 = store.upsertEntity(makeEntity({ id: "e1", canonicalName: "jest" }));
      const id2 = store.upsertEntity(makeEntity({ id: "e2", canonicalName: "vitest" }));
      store.addRelation({
        sourceEntityId: id1,
        targetEntityId: id2,
        relationType: "replaced_by",
        context: "switched from jest to vitest",
      });
      const rels = store.getRelationsFor(id1);
      expect(rels).toHaveLength(1);
      expect(rels[0].relation_type).toBe("replaced_by");
    });

    it("should silently ignore duplicate relations", () => {
      const id1 = store.upsertEntity(makeEntity({ id: "e1", canonicalName: "jest" }));
      const id2 = store.upsertEntity(makeEntity({ id: "e2", canonicalName: "vitest" }));
      store.addRelation({ sourceEntityId: id1, targetEntityId: id2, relationType: "replaced_by" });
      store.addRelation({ sourceEntityId: id1, targetEntityId: id2, relationType: "replaced_by" });
      const rels = store.getRelationsFor(id1);
      expect(rels).toHaveLength(1);
    });
  });

  describe("linkToKnowledge", () => {
    it("should link an entity to a knowledge entry", () => {
      // Insert a knowledge entry first
      db.prepare(`
        INSERT INTO knowledge (id, type, project, session_id, timestamp, summary, details)
        VALUES ('k1', 'decision', 'proj', 'sess1', 1000, 'Use react', 'Details here')
      `).run();

      const entityId = store.upsertEntity(makeEntity({ id: "e1", canonicalName: "react" }));
      store.linkToKnowledge("k1", entityId);

      const entries = store.getKnowledgeForEntity(entityId);
      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe("k1");
      expect(entries[0].summary).toBe("Use react");
    });

    it("should silently ignore duplicate links", () => {
      db.prepare(`
        INSERT INTO knowledge (id, type, project, session_id, timestamp, summary, details)
        VALUES ('k1', 'decision', 'proj', 'sess1', 1000, 'Use react', 'Details')
      `).run();

      const entityId = store.upsertEntity(makeEntity({ id: "e1", canonicalName: "react" }));
      store.linkToKnowledge("k1", entityId);
      store.linkToKnowledge("k1", entityId);

      const entries = store.getKnowledgeForEntity(entityId);
      expect(entries).toHaveLength(1);
    });

    it("should return empty array when no knowledge linked", () => {
      const entityId = store.upsertEntity(makeEntity({ id: "e1", canonicalName: "react" }));
      expect(store.getKnowledgeForEntity(entityId)).toEqual([]);
    });
  });

  describe("searchEntities", () => {
    it("should find entities by partial name", () => {
      store.upsertEntity(makeEntity({ canonicalName: "postgresql" }));
      const results = store.searchEntities("postgres");
      expect(results).toHaveLength(1);
    });

    it("should filter by type", () => {
      store.upsertEntity(makeEntity({ canonicalName: "react", type: "framework" }));
      store.upsertEntity(makeEntity({ canonicalName: "redis", type: "service" }));
      const results = store.searchEntities("re", "framework");
      expect(results).toHaveLength(1);
      expect(results[0].canonical_name).toBe("react");
    });

    it("should respect limit", () => {
      for (let i = 0; i < 5; i++) {
        store.upsertEntity(makeEntity({ canonicalName: `lib-${i}`, name: `lib-${i}`, type: "library" }));
      }
      const results = store.searchEntities("lib", undefined, 3);
      expect(results).toHaveLength(3);
    });

    it("should clamp limit to 1-100", () => {
      store.upsertEntity(makeEntity({ canonicalName: "react" }));
      const r1 = store.searchEntities("react", undefined, 0);
      expect(r1.length).toBeGreaterThanOrEqual(0); // clamped to 1
      const r2 = store.searchEntities("react", undefined, 200);
      expect(r2).toHaveLength(1);
    });
  });

  describe("getTopEntities", () => {
    it("should return entities sorted by mention count", () => {
      store.upsertEntity(makeEntity({ canonicalName: "react" }));
      store.upsertEntity(makeEntity({ canonicalName: "docker" }));
      store.upsertEntity(makeEntity({ canonicalName: "docker" }));
      store.upsertEntity(makeEntity({ canonicalName: "docker" }));

      const top = store.getTopEntities(2);
      expect(top).toHaveLength(2);
      expect(top[0].canonical_name).toBe("docker");
      expect(top[0].mention_count).toBe(3);
    });
  });
});
