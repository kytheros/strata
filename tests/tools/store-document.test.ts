import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../../src/storage/database.js";
import { DocumentChunkStore } from "../../src/storage/document-chunk-store.js";
import { handleStoreDocument } from "../../src/tools/store-document.js";

describe("store_document tool", () => {
  let db: Database.Database;
  let store: DocumentChunkStore;

  beforeEach(() => {
    db = openDatabase(":memory:");
    store = new DocumentChunkStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("rejects when neither file_path nor content provided", async () => {
    const result = await handleStoreDocument(store, null, {
      mime_type: "text/plain",
      title: "Test",
    });
    expect(result).toContain("Error");
    expect(result).toContain("file_path");
  });

  it("rejects unsupported mime type", async () => {
    const result = await handleStoreDocument(store, null, {
      content: Buffer.from("test").toString("base64"),
      mime_type: "video/mp4",
      title: "Test Video",
    });
    expect(result).toContain("Error");
    expect(result).toContain("Supported");
  });

  it("stores a plain text document with mock embedder", async () => {
    const mockEmbedder = {
      embedText: vi.fn().mockResolvedValue(new Float32Array(3072).fill(0.1)),
      embedBinary: vi.fn(),
      dimensions: 3072,
    };

    const result = await handleStoreDocument(store, mockEmbedder as any, {
      content: Buffer.from("This is a test document with enough text to be meaningful").toString("base64"),
      mime_type: "text/plain",
      title: "Test Doc",
      project: "test-project",
      tags: ["test"],
    });

    expect(result).toContain("Stored");
    expect(result).toContain("Test Doc");
    expect(result).toContain("Document ID:");
    expect(mockEmbedder.embedText).toHaveBeenCalled();

    // Verify stored in database
    const docs = db.prepare("SELECT * FROM stored_documents").all();
    expect(docs).toHaveLength(1);
  });

  it("stores an image document with mock embedder", async () => {
    const mockEmbedder = {
      embedText: vi.fn(),
      embedBinary: vi.fn().mockResolvedValue(new Float32Array(3072).fill(0.2)),
      dimensions: 3072,
    };

    const fakeImageBytes = Buffer.from("fake png data");
    const result = await handleStoreDocument(store, mockEmbedder as any, {
      content: fakeImageBytes.toString("base64"),
      mime_type: "image/png",
      title: "Screenshot",
    });

    expect(result).toContain("Stored");
    expect(result).toContain("Screenshot");
    expect(mockEmbedder.embedBinary).toHaveBeenCalledWith(
      expect.any(Buffer),
      "image/png"
    );
  });

  it("returns error when embedder is null", async () => {
    const result = await handleStoreDocument(store, null, {
      content: Buffer.from("test").toString("base64"),
      mime_type: "text/plain",
      title: "No Embedder",
    });
    expect(result).toContain("requires a Gemini API key");
  });
});
