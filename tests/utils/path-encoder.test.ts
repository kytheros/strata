import { describe, it, expect } from "vitest";
import {
  encodeProjectPath,
  decodeProjectPath,
  extractProjectName,
  matchProjectDir,
} from "../../src/utils/path-encoder.js";

describe("path-encoder", () => {
  describe("encodeProjectPath", () => {
    it("should encode Unix paths", () => {
      expect(encodeProjectPath("/Users/jon/dev/app")).toBe(
        "-Users-jon-dev-app"
      );
    });

    it("should encode Windows paths with backslashes", () => {
      const encoded = encodeProjectPath("E:\\Kytheros\\src");
      expect(encoded).toBe("E--Kytheros-src");
    });

    it("should encode Windows paths with drive letters", () => {
      const encoded = encodeProjectPath("C:\\Users\\Mike\\projects");
      expect(encoded).toBe("C--Users-Mike-projects");
    });

    it("should handle mixed separators", () => {
      const encoded = encodeProjectPath("E:\\path/to\\file");
      expect(encoded).toBe("E--path-to-file");
    });
  });

  describe("decodeProjectPath", () => {
    it("should decode to forward slashes", () => {
      expect(decodeProjectPath("-Users-jon-dev-app")).toBe(
        "/Users/jon/dev/app"
      );
    });
  });

  describe("extractProjectName", () => {
    it("should extract from encoded Unix path", () => {
      expect(extractProjectName("-Users-jon-dev-ghostty")).toBe("ghostty");
    });

    it("should extract from raw Unix path", () => {
      expect(extractProjectName("/Users/jon/dev/ghostty")).toBe("ghostty");
    });

    it("should extract from raw Windows path", () => {
      expect(extractProjectName("E:\\Kytheros\\src\\learnings")).toBe(
        "learnings"
      );
    });

    it("should handle encoded Windows path", () => {
      expect(extractProjectName("E--Kytheros-src")).toBe("src");
    });
  });

  describe("matchProjectDir", () => {
    const dirs = ["-Users-jon-dev-app", "-Users-jon-dev-other"];

    it("should find exact match", () => {
      expect(
        matchProjectDir("/Users/jon/dev/app", dirs)
      ).toBe("-Users-jon-dev-app");
    });

    it("should return null for no match", () => {
      expect(matchProjectDir("/no/match", dirs)).toBeNull();
    });
  });
});
