/**
 * Test: PgEventStore — SVO event CRUD + weighted tsvector search.
 *
 * Requires Docker Postgres running on localhost:5432.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { createSchema } from "../../src/storage/pg/schema.js";
import { PgEventStore } from "../../src/storage/pg/pg-event-store.js";
import type { SVOEvent } from "../../src/storage/interfaces/index.js";

const PG_URL = process.env.PG_URL || "postgresql://postgres:test@localhost:5432/postgres";

function makeEvent(overrides: Partial<SVOEvent> = {}): SVOEvent {
  return {
    subject: "user",
    verb: "installed",
    object: "Docker",
    startDate: null,
    endDate: null,
    aliases: ["set up container runtime"],
    category: "technical",
    sessionId: "session-1",
    project: "infra",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("PgEventStore", () => {
  let pool: pg.Pool | undefined;
  let store: PgEventStore;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: PG_URL, max: 5 });
    try {
      await pool.query("SELECT 1");
    } catch {
      console.log("Postgres not available -- skipping PgEventStore tests");
      await pool.end();
      pool = undefined;
      return;
    }

    await createSchema(pool);
    store = new PgEventStore(pool, "pg-evt-test");
  });

  beforeEach(async () => {
    if (!pool) return;
    await pool.query("DELETE FROM events WHERE user_scope = 'pg-evt-test'");
  });

  afterAll(async () => {
    if (pool) {
      await pool.query("DELETE FROM events WHERE user_scope = 'pg-evt-test'");
      await pool.end();
    }
  });

  it("should add events and return count", async () => {
    if (!pool) return;
    const events = [makeEvent(), makeEvent({ subject: "admin", verb: "deployed" })];
    const count = await store.addEvents(events);

    expect(count).toBe(2);
    expect(await store.getEventCount()).toBeGreaterThanOrEqual(2);
  });

  it("should search events by subject (weight A)", async () => {
    if (!pool) return;
    await store.addEvents([
      makeEvent({ subject: "developer", verb: "wrote", object: "TypeScript code" }),
      makeEvent({ subject: "admin", verb: "configured", object: "Kubernetes cluster" }),
    ]);

    const results = await store.search("developer");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].subject).toBe("developer");
  });

  it("should search events by object (weight C)", async () => {
    if (!pool) return;
    await store.addEvents([
      makeEvent({ subject: "user", verb: "migrated", object: "PostgreSQL database" }),
      makeEvent({ subject: "user", verb: "deployed", object: "Redis cache" }),
    ]);

    const results = await store.search("PostgreSQL");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].object).toContain("PostgreSQL");
  });

  it("should search across aliases (weight D)", async () => {
    if (!pool) return;
    await store.addEvents([
      makeEvent({
        subject: "user",
        verb: "bought",
        object: "Fitbit",
        aliases: ["purchased wearable fitness tracker device"],
      }),
    ]);

    const results = await store.search("fitness tracker");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].object).toBe("Fitbit");
  });

  it("should get events by session", async () => {
    if (!pool) return;
    await store.addEvents([
      makeEvent({ sessionId: "s1" }),
      makeEvent({ sessionId: "s1" }),
      makeEvent({ sessionId: "s2" }),
    ]);

    const events = await store.getBySession("s1");
    expect(events.length).toBe(2);
  });

  it("should delete events by session", async () => {
    if (!pool) return;
    await store.addEvents([
      makeEvent({ sessionId: "s1" }),
      makeEvent({ sessionId: "s2" }),
    ]);

    const countBefore = await store.getEventCount();
    await store.deleteBySession("s1");
    const countAfter = await store.getEventCount();
    expect(countAfter).toBe(countBefore - 1);
  });
});
