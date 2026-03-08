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
    it("should set and get a string value", () => {
      store.set("version", "1");
      expect(store.get("version")).toBe("1");
    });

    it("should return undefined for missing key", () => {
      expect(store.get("missing")).toBeUndefined();
    });

    it("should overwrite existing key", () => {
      store.set("key", "value1");
      store.set("key", "value2");
      expect(store.get("key")).toBe("value2");
    });
  });

  describe("getJson and setJson", () => {
    it("should round-trip JSON objects", () => {
      const data = { lastIndexed: { "file1.jsonl": 12345 }, buildTime: 100 };
      store.setJson("meta", data);

      const result = store.getJson<typeof data>("meta");
      expect(result).toEqual(data);
    });

    it("should return undefined for missing JSON key", () => {
      expect(store.getJson("missing")).toBeUndefined();
    });

    it("should return undefined for invalid JSON", () => {
      store.set("bad", "not json {{{");
      expect(store.getJson("bad")).toBeUndefined();
    });
  });

  describe("remove", () => {
    it("should remove a key", () => {
      store.set("key", "value");
      store.remove("key");
      expect(store.get("key")).toBeUndefined();
    });

    it("should not throw for missing key", () => {
      expect(() => store.remove("non-existent")).not.toThrow();
    });
  });

  describe("getAll", () => {
    it("should return all key-value pairs", () => {
      store.set("a", "1");
      store.set("b", "2");
      store.set("c", "3");

      const all = store.getAll();
      expect(all).toEqual({ a: "1", b: "2", c: "3" });
    });

    it("should return empty object when empty", () => {
      expect(store.getAll()).toEqual({});
    });
  });
});
