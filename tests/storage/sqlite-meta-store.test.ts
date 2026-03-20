import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteMetaStore } from "../../src/storage/sqlite-meta-store.js";

describe("SqliteMetaStore", () => {
  let db: Database.Database;
  let store: SqliteMetaStore;

  beforeEach(() => {
    db = openDatabase(":memory:");
    store = new SqliteMetaStore(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("get and set", () => {
    it("should set and get a string value", async () => {
      await store.set("version", "1");
      expect(await store.get("version")).toBe("1");
    });

    it("should return undefined for missing key", async () => {
      expect(await store.get("missing")).toBeUndefined();
    });

    it("should overwrite existing key", async () => {
      await store.set("key", "value1");
      await store.set("key", "value2");
      expect(await store.get("key")).toBe("value2");
    });
  });

  describe("getJson and setJson", () => {
    it("should round-trip JSON objects", async () => {
      const data = { lastIndexed: { "file1.jsonl": 12345 }, buildTime: 100 };
      await store.setJson("meta", data);

      const result = await store.getJson<typeof data>("meta");
      expect(result).toEqual(data);
    });

    it("should return undefined for missing JSON key", async () => {
      expect(await store.getJson("missing")).toBeUndefined();
    });

    it("should return undefined for invalid JSON", async () => {
      await store.set("bad", "not json {{{");
      expect(await store.getJson("bad")).toBeUndefined();
    });
  });

  describe("remove", () => {
    it("should remove a key", async () => {
      await store.set("key", "value");
      await store.remove("key");
      expect(await store.get("key")).toBeUndefined();
    });

    it("should not throw for missing key", async () => {
      await store.remove("non-existent"); // should not throw
    });
  });

  describe("getAll", () => {
    it("should return all key-value pairs", async () => {
      await store.set("a", "1");
      await store.set("b", "2");
      await store.set("c", "3");

      const all = await store.getAll();
      expect(all).toEqual({ a: "1", b: "2", c: "3" });
    });

    it("should return empty object when empty", async () => {
      expect(await store.getAll()).toEqual({});
    });
  });
});
