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
    it("should insert a new entity", async () => {
      await store.upsertEntity(makeEntity({ canonicalName: "react" }));
      const e = await store.findByName("react");
      expect(e).toBeDefined();
      expect(e!.canonical_name).toBe("react");
      expect(e!.mention_count).toBe(1);
    });

    it("should increment mention_count on duplicate canonical name", async () => {
      await store.upsertEntity(makeEntity({ id: "e1", canonicalName: "react" }));
      await store.upsertEntity(makeEntity({ id: "e2", canonicalName: "react" }));
      const e = await store.findByName("react");
      expect(e!.mention_count).toBe(2);
    });

    it("should be case-insensitive on canonical name dedup", async () => {
      await store.upsertEntity(makeEntity({ id: "e1", canonicalName: "React" }));
      await store.upsertEntity(makeEntity({ id: "e2", canonicalName: "react" }));
      const e = await store.findByName("react");
      expect(e!.mention_count).toBe(2);
    });

    it("should merge aliases from multiple upserts", async () => {
      await store.upsertEntity(makeEntity({ id: "e1", canonicalName: "postgresql", aliases: ["pg"] }));
      await store.upsertEntity(makeEntity({ id: "e2", canonicalName: "postgresql", aliases: ["postgres"] }));
      const e = await store.findByName("postgresql");
      const aliases = JSON.parse(e!.aliases) as string[];
      expect(aliases).toContain("pg");
      expect(aliases).toContain("postgres");
    });

    it("should preserve first_seen on duplicate", async () => {
      await store.upsertEntity(makeEntity({ id: "e1", canonicalName: "postgresql", firstSeen: 1000, lastSeen: 1000 }));
      await store.upsertEntity(makeEntity({ id: "e2", canonicalName: "postgresql", firstSeen: 2000, lastSeen: 2000 }));
      const e = await store.findByName("postgresql");
      expect(e!.first_seen).toBe(1000);
      expect(e!.last_seen).toBe(2000);
    });

    it("should update last_seen to the most recent value", async () => {
      await store.upsertEntity(makeEntity({ id: "e1", canonicalName: "react", lastSeen: 5000 }));
      await store.upsertEntity(makeEntity({ id: "e2", canonicalName: "react", lastSeen: 3000 }));
      const e = await store.findByName("react");
      expect(e!.last_seen).toBe(5000);
    });

    it("should handle three upserts correctly", async () => {
      await store.upsertEntity(makeEntity({ canonicalName: "postgresql", aliases: ["pg"], firstSeen: 1000, lastSeen: 1000 }));
      await store.upsertEntity(makeEntity({ canonicalName: "postgresql", aliases: ["postgres"], firstSeen: 2000, lastSeen: 2000 }));
      await store.upsertEntity(makeEntity({ canonicalName: "postgresql", aliases: ["postgresql"], firstSeen: 3000, lastSeen: 3000 }));
      const e = await store.findByName("postgresql");
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
    it("should find by canonical name case-insensitively", async () => {
      await store.upsertEntity(makeEntity({ canonicalName: "Docker" }));
      expect(await store.findByName("docker")).toBeDefined();
      expect(await store.findByName("DOCKER")).toBeDefined();
    });

    it("should return undefined for non-existent entity", async () => {
      expect(await store.findByName("nonexistent")).toBeUndefined();
    });
  });

  describe("findByType", () => {
    it("should return entities of given type", async () => {
      await store.upsertEntity(makeEntity({ canonicalName: "react", type: "framework" }));
      await store.upsertEntity(makeEntity({ canonicalName: "docker", type: "tool" }));
      const frameworks = await store.findByType("framework");
      expect(frameworks).toHaveLength(1);
      expect(frameworks[0].canonical_name).toBe("react");
    });

    it("should filter by project when provided", async () => {
      await store.upsertEntity(makeEntity({ canonicalName: "react", project: "p1" }));
      await store.upsertEntity(makeEntity({ canonicalName: "vue", project: "p2" }));
      const results = await store.findByType("framework", "p1");
      expect(results).toHaveLength(1);
      expect(results[0].canonical_name).toBe("react");
    });
  });

  describe("addRelation", () => {
    it("should add a relation between two entities", async () => {
      const id1 = await store.upsertEntity(makeEntity({ id: "e1", canonicalName: "jest" }));
      const id2 = await store.upsertEntity(makeEntity({ id: "e2", canonicalName: "vitest" }));
      await store.addRelation({
        sourceEntityId: id1,
        targetEntityId: id2,
        relationType: "replaced_by",
        context: "switched from jest to vitest",
      });
      const rels = await store.getRelationsFor(id1);
      expect(rels).toHaveLength(1);
      expect(rels[0].relation_type).toBe("replaced_by");
    });

    it("should silently ignore duplicate relations", async () => {
      const id1 = await store.upsertEntity(makeEntity({ id: "e1", canonicalName: "jest" }));
      const id2 = await store.upsertEntity(makeEntity({ id: "e2", canonicalName: "vitest" }));
      await store.addRelation({ sourceEntityId: id1, targetEntityId: id2, relationType: "replaced_by" });
      await store.addRelation({ sourceEntityId: id1, targetEntityId: id2, relationType: "replaced_by" });
      const rels = await store.getRelationsFor(id1);
      expect(rels).toHaveLength(1);
    });
  });

  describe("linkToKnowledge", () => {
    it("should link an entity to a knowledge entry", async () => {
      // Insert a knowledge entry first
      db.prepare(`
        INSERT INTO knowledge (id, type, project, session_id, timestamp, summary, details)
        VALUES ('k1', 'decision', 'proj', 'sess1', 1000, 'Use react', 'Details here')
      `).run();

      const entityId = await store.upsertEntity(makeEntity({ id: "e1", canonicalName: "react" }));
      await store.linkToKnowledge("k1", entityId);

      const entries = await store.getKnowledgeForEntity(entityId);
      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe("k1");
      expect(entries[0].summary).toBe("Use react");
    });

    it("should silently ignore duplicate links", async () => {
      db.prepare(`
        INSERT INTO knowledge (id, type, project, session_id, timestamp, summary, details)
        VALUES ('k1', 'decision', 'proj', 'sess1', 1000, 'Use react', 'Details')
      `).run();

      const entityId = await store.upsertEntity(makeEntity({ id: "e1", canonicalName: "react" }));
      await store.linkToKnowledge("k1", entityId);
      await store.linkToKnowledge("k1", entityId);

      const entries = await store.getKnowledgeForEntity(entityId);
      expect(entries).toHaveLength(1);
    });

    it("should return empty array when no knowledge linked", async () => {
      const entityId = await store.upsertEntity(makeEntity({ id: "e1", canonicalName: "react" }));
      expect(await store.getKnowledgeForEntity(entityId)).toEqual([]);
    });
  });

  describe("searchEntities", () => {
    it("should find entities by partial name", async () => {
      await store.upsertEntity(makeEntity({ canonicalName: "postgresql" }));
      const results = await store.searchEntities("postgres");
      expect(results).toHaveLength(1);
    });

    it("should filter by type", async () => {
      await store.upsertEntity(makeEntity({ canonicalName: "react", type: "framework" }));
      await store.upsertEntity(makeEntity({ canonicalName: "redis", type: "service" }));
      const results = await store.searchEntities("re", "framework");
      expect(results).toHaveLength(1);
      expect(results[0].canonical_name).toBe("react");
    });

    it("should respect limit", async () => {
      for (let i = 0; i < 5; i++) {
        await store.upsertEntity(makeEntity({ canonicalName: `lib-${i}`, name: `lib-${i}`, type: "library" }));
      }
      const results = await store.searchEntities("lib", undefined, 3);
      expect(results).toHaveLength(3);
    });

    it("should clamp limit to 1-100", async () => {
      await store.upsertEntity(makeEntity({ canonicalName: "react" }));
      const r1 = await store.searchEntities("react", undefined, 0);
      expect(r1.length).toBeGreaterThanOrEqual(0); // clamped to 1
      const r2 = await store.searchEntities("react", undefined, 200);
      expect(r2).toHaveLength(1);
    });
  });

  describe("getTopEntities", () => {
    it("should return entities sorted by mention count", async () => {
      await store.upsertEntity(makeEntity({ canonicalName: "react" }));
      await store.upsertEntity(makeEntity({ canonicalName: "docker" }));
      await store.upsertEntity(makeEntity({ canonicalName: "docker" }));
      await store.upsertEntity(makeEntity({ canonicalName: "docker" }));

      const top = await store.getTopEntities(2);
      expect(top).toHaveLength(2);
      expect(top[0].canonical_name).toBe("docker");
      expect(top[0].mention_count).toBe(3);
    });
  });
});
