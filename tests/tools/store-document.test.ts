import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { join } from "path";
import { openDatabase } from "../../src/storage/database.js";
import { DocumentChunkStore } from "../../src/storage/document-chunk-store.js";
import { handleStoreDocument } from "../../src/tools/store-document.js";
import { CONFIG } from "../../src/config.js";

const FIXTURES = join(__dirname, "..", "fixtures", "pdfs");
const loadPdf = (name: string): Buffer => readFileSync(join(FIXTURES, name));

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

  describe("PDF chunking", () => {
    it("stores a small PDF (<=6 pages) as a single chunk via multimodal path", async () => {
      const mockEmbedder = {
        embedText: vi.fn(),
        embedBinary: vi.fn().mockResolvedValue(new Float32Array(3072).fill(0.3)),
        dimensions: 3072,
      };

      // Use 1-page fixture (multimodal path)
      const pdfBuffer = loadPdf("1-page.pdf");
      const result = await handleStoreDocument(store, mockEmbedder as any, {
        content: pdfBuffer.toString("base64"),
        mime_type: "application/pdf",
        title: "Small PDF",
        project: "test-project",
      });

      expect(result).toContain("Stored");
      expect(result).toContain("Small PDF");
      expect(result).toContain("1 page");
      expect(result).toContain("1 chunk");
      expect(result).toContain("1 embedding");
      // Multimodal path uses embedBinary
      expect(mockEmbedder.embedBinary).toHaveBeenCalledTimes(1);
      expect(mockEmbedder.embedText).not.toHaveBeenCalled();

      // Verify database records
      const docs = db.prepare("SELECT * FROM stored_documents").all() as any[];
      expect(docs).toHaveLength(1);
      expect(docs[0].total_pages).toBe(1);
      expect(docs[0].chunk_count).toBe(1);

      const chunks = db.prepare("SELECT * FROM document_chunks").all() as any[];
      expect(chunks).toHaveLength(1);
      expect(chunks[0].page_start).toBe(1);
      expect(chunks[0].page_end).toBe(1);
    });

    it("stores a 6-page PDF as a single chunk via multimodal path (boundary)", async () => {
      const mockEmbedder = {
        embedText: vi.fn(),
        embedBinary: vi.fn().mockResolvedValue(new Float32Array(3072).fill(0.3)),
        dimensions: 3072,
      };

      const pdfBuffer = loadPdf("6-pages.pdf");
      const result = await handleStoreDocument(store, mockEmbedder as any, {
        content: pdfBuffer.toString("base64"),
        mime_type: "application/pdf",
        title: "6-Page PDF",
        project: "test-project",
      });

      expect(result).toContain("Stored");
      expect(result).toContain("6 pages");
      expect(result).toContain("1 chunk");
      // Multimodal path: 1 embedBinary call
      expect(mockEmbedder.embedBinary).toHaveBeenCalledTimes(1);

      const chunks = db.prepare("SELECT * FROM document_chunks").all() as any[];
      expect(chunks).toHaveLength(1);
      expect(chunks[0].page_start).toBe(1);
      expect(chunks[0].page_end).toBe(6);
    });

    it("stores a 7-page PDF using text-only path (boundary)", async () => {
      const mockEmbedder = {
        embedText: vi.fn().mockResolvedValue(new Float32Array(3072).fill(0.4)),
        embedBinary: vi.fn(),
        dimensions: 3072,
      };

      const pdfBuffer = loadPdf("7-pages.pdf");
      const result = await handleStoreDocument(store, mockEmbedder as any, {
        content: pdfBuffer.toString("base64"),
        mime_type: "application/pdf",
        title: "Multi-chunk PDF",
      });

      expect(result).toContain("Stored");
      expect(result).toContain("7 pages");
      // Text-only path: one chunk per page, 7 embedText calls
      expect(mockEmbedder.embedText).toHaveBeenCalledTimes(7);
      expect(mockEmbedder.embedBinary).not.toHaveBeenCalled();

      const chunks = db.prepare("SELECT * FROM document_chunks ORDER BY chunk_index").all() as any[];
      expect(chunks).toHaveLength(7);
      expect(chunks[0].page_start).toBe(1);
      expect(chunks[0].page_end).toBe(1);
      expect(chunks[6].page_start).toBe(7);
      expect(chunks[6].page_end).toBe(7);
    });

    it("stores a 13-page PDF using text-only path", async () => {
      const mockEmbedder = {
        embedText: vi.fn().mockResolvedValue(new Float32Array(3072).fill(0.5)),
        embedBinary: vi.fn(),
        dimensions: 3072,
      };

      const pdfBuffer = loadPdf("13-pages.pdf");
      const result = await handleStoreDocument(store, mockEmbedder as any, {
        content: pdfBuffer.toString("base64"),
        mime_type: "application/pdf",
        title: "Large PDF",
      });

      expect(result).toContain("13 pages");
      // Text-only path: 13 embedText calls (one per page)
      expect(mockEmbedder.embedText).toHaveBeenCalledTimes(13);

      const chunks = db.prepare("SELECT * FROM document_chunks ORDER BY chunk_index").all() as any[];
      expect(chunks).toHaveLength(13);
    });

    it("sends raw PDF bytes to embedBinary on multimodal path", async () => {
      const receivedBuffers: Buffer[] = [];
      const mockEmbedder = {
        embedText: vi.fn(),
        embedBinary: vi.fn().mockImplementation(async (data: Buffer) => {
          receivedBuffers.push(data);
          return new Float32Array(3072).fill(0.1);
        }),
        dimensions: 3072,
      };

      // Use 6-page fixture (multimodal path, raw bytes sent)
      const pdfBuffer = loadPdf("6-pages.pdf");
      await handleStoreDocument(store, mockEmbedder as any, {
        content: pdfBuffer.toString("base64"),
        mime_type: "application/pdf",
        title: "Verify Bytes",
      });

      expect(receivedBuffers).toHaveLength(1);
      // The raw PDF bytes should be passed through unchanged
      expect(receivedBuffers[0].length).toBe(pdfBuffer.length);
    });

    it("handles partial embedding failures gracefully on text-only path", async () => {
      let callCount = 0;
      const mockEmbedder = {
        embedText: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 2) {
            throw new Error("API rate limit exceeded");
          }
          return new Float32Array(3072).fill(0.7);
        }),
        embedBinary: vi.fn(),
        dimensions: 3072,
      };

      // 7-page PDF → text-only → 7 embedText calls; second call fails
      const pdfBuffer = loadPdf("7-pages.pdf");
      const result = await handleStoreDocument(store, mockEmbedder as any, {
        content: pdfBuffer.toString("base64"),
        mime_type: "application/pdf",
        title: "Partial Failure",
      });

      // Should succeed with warnings (6 of 7 pages embedded)
      expect(result).toContain("Stored");
      expect(result).toContain("Warnings");
      expect(result).toContain("API rate limit exceeded");

      // Only the successful chunks stored (6 of 7)
      const chunks = db.prepare("SELECT * FROM document_chunks").all() as any[];
      expect(chunks).toHaveLength(6);
    });

    it("returns error for corrupted PDF data", async () => {
      const mockEmbedder = {
        embedText: vi.fn(),
        embedBinary: vi.fn().mockResolvedValue(new Float32Array(3072).fill(0.8)),
        dimensions: 3072,
      };

      const result = await handleStoreDocument(store, mockEmbedder as any, {
        content: Buffer.from("not a valid pdf").toString("base64"),
        mime_type: "application/pdf",
        title: "Corrupted PDF",
      });

      expect(result).toContain("Error");
      expect(result).toContain("PDF processing failed");
    });

    it("stores totalPages in the document record", async () => {
      const mockEmbedder = {
        embedText: vi.fn().mockResolvedValue(new Float32Array(3072).fill(0.9)),
        embedBinary: vi.fn(),
        dimensions: 3072,
      };

      // 13-page fixture → text-only path
      const pdfBuffer = loadPdf("13-pages.pdf");
      await handleStoreDocument(store, mockEmbedder as any, {
        content: pdfBuffer.toString("base64"),
        mime_type: "application/pdf",
        title: "Page Count Test",
      });

      const doc = db.prepare("SELECT * FROM stored_documents").get() as any;
      expect(doc.total_pages).toBe(13);
    });

    it("honors STRATA_PDF_MAX_PAGES cap on the text-only path", async () => {
      const mockEmbedder = {
        embedText: vi.fn().mockResolvedValue(new Float32Array(3072).fill(0.5)),
        embedBinary: vi.fn(),
        dimensions: 3072,
      };

      // Drop cap to 5 — verifies the call site at store-document.ts wires
      // CONFIG.indexing.maxPdfPages through to preparePdf's options.
      const original = CONFIG.indexing.maxPdfPages;
      CONFIG.indexing.maxPdfPages = 5;
      try {
        const pdfBuffer = loadPdf("13-pages.pdf");
        const result = await handleStoreDocument(store, mockEmbedder as any, {
          content: pdfBuffer.toString("base64"),
          mime_type: "application/pdf",
          title: "Capped PDF",
        });

        expect(result).toContain("Stored");
        // totalPages still reflects the original document length
        expect(result).toContain("13 pages");
        // But only the first 5 pages were embedded
        expect(mockEmbedder.embedText).toHaveBeenCalledTimes(5);
        const chunks = db.prepare("SELECT * FROM document_chunks ORDER BY chunk_index").all() as any[];
        expect(chunks).toHaveLength(5);
        expect(chunks[0].page_start).toBe(1);
        expect(chunks[4].page_start).toBe(5);
      } finally {
        CONFIG.indexing.maxPdfPages = original;
      }
    });
  });
});
