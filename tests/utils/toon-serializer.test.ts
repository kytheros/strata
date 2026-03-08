import { describe, it, expect } from "vitest";
import { ToonSerializer } from "../../src/utils/toon-serializer.js";

describe("ToonSerializer", () => {
  describe("serialize", () => {
    it("should serialize empty arrays", () => {
      const result = ToonSerializer.serialize("items", [], ["id", "name"]);
      expect(result).toBe("items[0]{}: (empty)");
    });

    it("should serialize single item", () => {
      const data = [{ id: "1", name: "Alice", role: "admin" }];
      const result = ToonSerializer.serialize("users", data, ["id", "name", "role"]);
      expect(result).toBe("users[1]{id,name,role}:\n  1,Alice,admin");
    });

    it("should serialize multiple items", () => {
      const data = [
        { id: "1", title: "Post A", status: "published" },
        { id: "2", title: "Post B", status: "draft" },
        { id: "3", title: "Post C", status: "published" },
      ];
      const result = ToonSerializer.serialize("posts", data, ["id", "title", "status"]);
      expect(result).toContain("posts[3]{id,title,status}:");
      expect(result).toContain("1,Post A,published");
      expect(result).toContain("2,Post B,draft");
      expect(result).toContain("3,Post C,published");
    });

    it("should escape commas in values", () => {
      const data = [{ text: "hello, world", count: "5" }];
      const result = ToonSerializer.serialize("items", data, ["text", "count"]);
      expect(result).toContain("hello\\, world,5");
    });

    it("should escape newlines in values", () => {
      const data = [{ text: "line1\nline2", id: "1" }];
      const result = ToonSerializer.serialize("items", data, ["text", "id"]);
      expect(result).toContain("line1\\nline2,1");
    });

    it("should handle null/undefined values", () => {
      const data = [{ id: "1", name: null, value: undefined }];
      const result = ToonSerializer.serialize("items", data, ["id", "name", "value"]);
      expect(result).toContain("1,,");
    });

    it("should handle numeric values", () => {
      const data = [{ id: 42, score: 3.14, active: true }];
      const result = ToonSerializer.serialize("items", data, ["id", "score", "active"]);
      expect(result).toContain("42,3.14,true");
    });

    it("should select only specified fields", () => {
      const data = [{ id: "1", name: "Test", secret: "hidden" }];
      const result = ToonSerializer.serialize("items", data, ["id", "name"]);
      expect(result).not.toContain("hidden");
      expect(result).toContain("items[1]{id,name}:");
    });
  });

  describe("parse (round-trip)", () => {
    it("should round-trip simple data", () => {
      const original = [
        { id: "1", name: "Alice", role: "admin" },
        { id: "2", name: "Bob", role: "user" },
      ];
      const toon = ToonSerializer.serialize("users", original, ["id", "name", "role"]);
      const parsed = ToonSerializer.parse(toon);
      expect(parsed).toHaveLength(2);
      expect(parsed[0]).toEqual({ id: "1", name: "Alice", role: "admin" });
      expect(parsed[1]).toEqual({ id: "2", name: "Bob", role: "user" });
    });

    it("should round-trip escaped commas", () => {
      const original = [{ text: "hello, world", id: "1" }];
      const toon = ToonSerializer.serialize("items", original, ["text", "id"]);
      const parsed = ToonSerializer.parse(toon);
      expect(parsed[0].text).toBe("hello, world");
    });

    it("should round-trip escaped newlines", () => {
      const original = [{ text: "line1\nline2", id: "1" }];
      const toon = ToonSerializer.serialize("items", original, ["text", "id"]);
      const parsed = ToonSerializer.parse(toon);
      expect(parsed[0].text).toBe("line1\nline2");
    });

    it("should return empty array for invalid input", () => {
      expect(ToonSerializer.parse("invalid")).toEqual([]);
    });
  });

  describe("token savings", () => {
    it("should produce significantly fewer chars than JSON", () => {
      const data = Array.from({ length: 20 }, (_, i) => ({
        id: String(i + 1),
        name: `Project ${i + 1}`,
        sessions: String(Math.floor(Math.random() * 100)),
        messages: String(Math.floor(Math.random() * 1000)),
      }));

      const jsonStr = JSON.stringify(data, null, 2);
      const toonStr = ToonSerializer.serialize("projects", data, [
        "id", "name", "sessions", "messages",
      ]);

      const reduction = 1 - toonStr.length / jsonStr.length;
      // TOON should be at least 50% smaller than pretty-printed JSON
      expect(reduction).toBeGreaterThan(0.5);
    });
  });
});
