/**
 * Test: PgEntityStore — entity CRUD, relations, graph projection.
 *
 * Requires Docker Postgres running on localhost:5432.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { createSchema } from "../../src/storage/pg/schema.js";
import { PgEntityStore } from "../../src/storage/pg/pg-entity-store.js";

const PG_URL = process.env.PG_URL || "postgresql://postgres:test@localhost:5432/postgres";

describe("PgEntityStore", () => {
  let pool: pg.Pool | undefined;
  let store: PgEntityStore;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: PG_URL, max: 5 });
    try {
      await pool.query("SELECT 1");
    } catch {
      console.log("Postgres not available -- skipping PgEntityStore tests");
      await pool.end();
      pool = undefined;
      return;
    }

    await createSchema(pool);
    store = new PgEntityStore(pool, "pg-ent-test");
  });

  beforeEach(async () => {
    if (!pool) return;
    await pool.query("DELETE FROM knowledge_entities WHERE entity_id IN (SELECT id FROM entities WHERE user_scope = 'pg-ent-test')").catch(() => {});
    await pool.query("DELETE FROM entity_relations WHERE source_entity_id IN (SELECT id FROM entities WHERE user_scope = 'pg-ent-test')").catch(() => {});
    await pool.query("DELETE FROM entities WHERE user_scope = 'pg-ent-test'");
  });

  afterAll(async () => {
    if (pool) {
      await pool.query("DELETE FROM knowledge_entities WHERE entity_id IN (SELECT id FROM entities WHERE user_scope = 'pg-ent-test')").catch(() => {});
      await pool.query("DELETE FROM entity_relations WHERE source_entity_id IN (SELECT id FROM entities WHERE user_scope = 'pg-ent-test')").catch(() => {});
      await pool.query("DELETE FROM entities WHERE user_scope = 'pg-ent-test'").catch(() => {});
      await pool.end();
    }
  });

  it("should upsert an entity and return its ID", async () => {
    if (!pool) return;
    const id = await store.upsertEntity({
      id: "ent-1",
      name: "React",
      type: "library",
      canonicalName: "React",
      aliases: ["ReactJS"],
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      project: "frontend",
    });
    expect(id).toBe("ent-1");

    const entity = await store.getById("ent-1");
    expect(entity).toBeDefined();
    expect(entity!.name).toBe("React");
  });

  it("should increment mention_count on upsert", async () => {
    if (!pool) return;
    await store.upsertEntity({
      id: "ent-2",
      name: "TypeScript",
      type: "tool",
      canonicalName: "TypeScript",
      aliases: ["TS"],
      firstSeen: Date.now(),
      lastSeen: Date.now(),
    });

    await store.upsertEntity({
      id: "ent-2b",
      name: "TypeScript",
      type: "tool",
      canonicalName: "TypeScript",
      aliases: ["TS", "tsc"],
      firstSeen: Date.now(),
      lastSeen: Date.now(),
    });

    const entity = await store.findByName("TypeScript");
    expect(entity).toBeDefined();
    expect(entity!.mention_count).toBe(2);
  });

  it("should find entities by type", async () => {
    if (!pool) return;
    await store.upsertEntity({
      id: "ent-lib-1",
      name: "React",
      type: "library",
      canonicalName: "React",
      aliases: [],
      firstSeen: Date.now(),
      lastSeen: Date.now(),
    });
    await store.upsertEntity({
      id: "ent-tool-1",
      name: "Docker",
      type: "tool",
      canonicalName: "Docker",
      aliases: [],
      firstSeen: Date.now(),
      lastSeen: Date.now(),
    });

    const libs = await store.findByType("library");
    expect(libs.length).toBe(1);
    expect(libs[0].name).toBe("React");
  });

  it("should search entities by name or aliases", async () => {
    if (!pool) return;
    await store.upsertEntity({
      id: "ent-search-1",
      name: "PostgreSQL",
      type: "service",
      canonicalName: "PostgreSQL",
      aliases: ["Postgres", "PG"],
      firstSeen: Date.now(),
      lastSeen: Date.now(),
    });

    const results = await store.searchEntities("Postgres");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].canonical_name).toBe("PostgreSQL");
  });

  it("should add and query relations", async () => {
    if (!pool) return;
    await store.upsertEntity({
      id: "ent-a",
      name: "React",
      type: "library",
      canonicalName: "React",
      aliases: [],
      firstSeen: Date.now(),
      lastSeen: Date.now(),
    });
    await store.upsertEntity({
      id: "ent-b",
      name: "TypeScript",
      type: "tool",
      canonicalName: "TypeScript",
      aliases: [],
      firstSeen: Date.now(),
      lastSeen: Date.now(),
    });

    await store.addRelation({
      sourceEntityId: "ent-a",
      targetEntityId: "ent-b",
      relationType: "used_for",
      context: "React is commonly used with TypeScript",
    });

    const relations = await store.getRelationsFor("ent-a");
    expect(relations.length).toBe(1);
    expect(relations[0].relation_type).toBe("used_for");
  });

  it("should get entity graph with nodes and edges", async () => {
    if (!pool) return;
    await store.upsertEntity({
      id: "graph-a",
      name: "Node.js",
      type: "tool",
      canonicalName: "Node.js",
      aliases: [],
      firstSeen: Date.now(),
      lastSeen: Date.now(),
    });
    await store.upsertEntity({
      id: "graph-b",
      name: "Express",
      type: "library",
      canonicalName: "Express",
      aliases: [],
      firstSeen: Date.now(),
      lastSeen: Date.now(),
    });

    await store.addRelation({
      sourceEntityId: "graph-a",
      targetEntityId: "graph-b",
      relationType: "depends_on",
    });

    const graph = await store.getEntityGraph();
    expect(graph.nodes.length).toBe(2);
    expect(graph.edges.length).toBe(1);
    expect(graph.edges[0].type).toBe("depends_on");
  });
});
