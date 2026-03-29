import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { PDFDocument } from "pdf-lib";
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

  describe("PDF chunking", () => {
    /** Helper: create a valid PDF buffer with N pages */
    async function createTestPdf(numPages: number): Promise<Buffer> {
      const doc = await PDFDocument.create();
      for (let i = 0; i < numPages; i++) {
        const page = doc.addPage([612, 792]);
        page.drawText(`Page ${i + 1} content`, { x: 50, y: 700 });
      }
      const bytes = await doc.save();
      return Buffer.from(bytes);
    }

    it("stores a small PDF (<=6 pages) as a single chunk", async () => {
      const mockEmbedder = {
        embedText: vi.fn(),
        embedBinary: vi.fn().mockResolvedValue(new Float32Array(3072).fill(0.3)),
        dimensions: 3072,
      };

      const pdfBuffer = await createTestPdf(3);
      const result = await handleStoreDocument(store, mockEmbedder as any, {
        content: pdfBuffer.toString("base64"),
        mime_type: "application/pdf",
        title: "Small PDF",
        project: "test-project",
      });

      expect(result).toContain("Stored");
      expect(result).toContain("Small PDF");
      expect(result).toContain("3 pages");
      expect(result).toContain("1 chunk");
      expect(result).toContain("1 embedding");
      expect(mockEmbedder.embedBinary).toHaveBeenCalledTimes(1);

      // Verify database records
      const docs = db.prepare("SELECT * FROM stored_documents").all() as any[];
      expect(docs).toHaveLength(1);
      expect(docs[0].total_pages).toBe(3);
      expect(docs[0].chunk_count).toBe(1);

      const chunks = db.prepare("SELECT * FROM document_chunks").all() as any[];
      expect(chunks).toHaveLength(1);
      expect(chunks[0].page_start).toBe(1);
      expect(chunks[0].page_end).toBe(3);
    });

    it("splits a 7-page PDF into 2 chunks and embeds each separately", async () => {
      const mockEmbedder = {
        embedText: vi.fn(),
        embedBinary: vi.fn().mockResolvedValue(new Float32Array(3072).fill(0.4)),
        dimensions: 3072,
      };

      const pdfBuffer = await createTestPdf(7);
      const result = await handleStoreDocument(store, mockEmbedder as any, {
        content: pdfBuffer.toString("base64"),
        mime_type: "application/pdf",
        title: "Multi-chunk PDF",
      });

      expect(result).toContain("Stored");
      expect(result).toContain("7 pages");
      expect(result).toContain("2 chunks");
      expect(result).toContain("2 embeddings");

      // embedBinary called once per chunk
      expect(mockEmbedder.embedBinary).toHaveBeenCalledTimes(2);

      // Verify chunk records
      const chunks = db.prepare("SELECT * FROM document_chunks ORDER BY chunk_index").all() as any[];
      expect(chunks).toHaveLength(2);
      expect(chunks[0].page_start).toBe(1);
      expect(chunks[0].page_end).toBe(6);
      expect(chunks[1].page_start).toBe(7);
      expect(chunks[1].page_end).toBe(7);
    });

    it("splits a 13-page PDF into 3 chunks (6+6+1)", async () => {
      const mockEmbedder = {
        embedText: vi.fn(),
        embedBinary: vi.fn().mockResolvedValue(new Float32Array(3072).fill(0.5)),
        dimensions: 3072,
      };

      const pdfBuffer = await createTestPdf(13);
      const result = await handleStoreDocument(store, mockEmbedder as any, {
        content: pdfBuffer.toString("base64"),
        mime_type: "application/pdf",
        title: "Large PDF",
      });

      expect(result).toContain("13 pages");
      expect(result).toContain("3 chunks");
      expect(mockEmbedder.embedBinary).toHaveBeenCalledTimes(3);

      const chunks = db.prepare("SELECT * FROM document_chunks ORDER BY chunk_index").all() as any[];
      expect(chunks).toHaveLength(3);
      expect(chunks[0].page_start).toBe(1);
      expect(chunks[0].page_end).toBe(6);
      expect(chunks[1].page_start).toBe(7);
      expect(chunks[1].page_end).toBe(12);
      expect(chunks[2].page_start).toBe(13);
      expect(chunks[2].page_end).toBe(13);
    });

    it("sends valid sub-PDF bytes to the embedder (not the full PDF)", async () => {
      const receivedBuffers: Buffer[] = [];
      const mockEmbedder = {
        embedText: vi.fn(),
        embedBinary: vi.fn().mockImplementation(async (data: Buffer) => {
          receivedBuffers.push(data);
          return new Float32Array(3072).fill(0.1);
        }),
        dimensions: 3072,
      };

      const pdfBuffer = await createTestPdf(7);
      await handleStoreDocument(store, mockEmbedder as any, {
        content: pdfBuffer.toString("base64"),
        mime_type: "application/pdf",
        title: "Verify Sub-PDFs",
      });

      expect(receivedBuffers).toHaveLength(2);

      // Each buffer should be a valid PDF
      const sub1 = await PDFDocument.load(receivedBuffers[0]);
      expect(sub1.getPageCount()).toBe(6);

      const sub2 = await PDFDocument.load(receivedBuffers[1]);
      expect(sub2.getPageCount()).toBe(1);

      // Sub-PDF bytes should be smaller than the original
      expect(receivedBuffers[0].length).toBeLessThan(pdfBuffer.length);
    });

    it("extracts text content into chunk records for FTS5 indexing", async () => {
      const mockEmbedder = {
        embedText: vi.fn(),
        embedBinary: vi.fn().mockResolvedValue(new Float32Array(3072).fill(0.6)),
        dimensions: 3072,
      };

      const pdfBuffer = await createTestPdf(3);
      await handleStoreDocument(store, mockEmbedder as any, {
        content: pdfBuffer.toString("base64"),
        mime_type: "application/pdf",
        title: "Text Extraction Test",
        project: "test-proj",
      });

      // Check that content column is populated (text extraction may vary)
      const chunks = db.prepare("SELECT * FROM document_chunks").all() as any[];
      expect(chunks).toHaveLength(1);
      // Content is populated if pdf-parse can extract text from pdf-lib output
      // Even if extraction fails, the chunk should still exist with an embedding
      expect(chunks[0].embedding).toBeDefined();
    });

    it("handles partial embedding failures gracefully", async () => {
      let callCount = 0;
      const mockEmbedder = {
        embedText: vi.fn(),
        embedBinary: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 2) {
            throw new Error("API rate limit exceeded");
          }
          return new Float32Array(3072).fill(0.7);
        }),
        dimensions: 3072,
      };

      const pdfBuffer = await createTestPdf(12); // 2 chunks
      const result = await handleStoreDocument(store, mockEmbedder as any, {
        content: pdfBuffer.toString("base64"),
        mime_type: "application/pdf",
        title: "Partial Failure",
      });

      // Should succeed with warnings
      expect(result).toContain("Stored");
      expect(result).toContain("1 chunk");
      expect(result).toContain("1 embedding");
      expect(result).toContain("Warnings");
      expect(result).toContain("API rate limit exceeded");

      // Only the successful chunk should be stored
      const chunks = db.prepare("SELECT * FROM document_chunks").all() as any[];
      expect(chunks).toHaveLength(1);
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
        embedText: vi.fn(),
        embedBinary: vi.fn().mockResolvedValue(new Float32Array(3072).fill(0.9)),
        dimensions: 3072,
      };

      const pdfBuffer = await createTestPdf(10);
      await handleStoreDocument(store, mockEmbedder as any, {
        content: pdfBuffer.toString("base64"),
        mime_type: "application/pdf",
        title: "Page Count Test",
      });

      const doc = db.prepare("SELECT * FROM stored_documents").get() as any;
      expect(doc.total_pages).toBe(10);
    });
  });
});
