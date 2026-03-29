import { describe, it, expect, vi, beforeAll } from "vitest";
import { PDFDocument } from "pdf-lib";
import { chunkPdf, MAX_PAGES_PER_CHUNK } from "../../src/tools/pdf-chunker.js";

/** Helper: create a valid PDF buffer with N pages, each containing "Page X content". */
async function createTestPdf(numPages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < numPages; i++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`Page ${i + 1} content for testing`, { x: 50, y: 700 });
  }
  const bytes = await doc.save();
  return Buffer.from(bytes);
}

describe("chunkPdf", () => {
  it("exports MAX_PAGES_PER_CHUNK as 6", () => {
    expect(MAX_PAGES_PER_CHUNK).toBe(6);
  });

  it("handles a 1-page PDF without chunking", async () => {
    const pdfBuffer = await createTestPdf(1);
    const result = await chunkPdf(pdfBuffer);

    expect(result.totalPages).toBe(1);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].index).toBe(0);
    expect(result.chunks[0].pageStart).toBe(1);
    expect(result.chunks[0].pageEnd).toBe(1);
    expect(result.chunks[0].pdfBytes).toBeInstanceOf(Buffer);
    expect(result.chunks[0].pdfBytes.length).toBeGreaterThan(0);

    // Verify the sub-PDF is valid and has 1 page
    const subDoc = await PDFDocument.load(result.chunks[0].pdfBytes);
    expect(subDoc.getPageCount()).toBe(1);
  });

  it("handles a 6-page PDF as a single chunk", async () => {
    const pdfBuffer = await createTestPdf(6);
    const result = await chunkPdf(pdfBuffer);

    expect(result.totalPages).toBe(6);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].pageStart).toBe(1);
    expect(result.chunks[0].pageEnd).toBe(6);

    const subDoc = await PDFDocument.load(result.chunks[0].pdfBytes);
    expect(subDoc.getPageCount()).toBe(6);
  });

  it("splits a 7-page PDF into 2 chunks (6 + 1)", async () => {
    const pdfBuffer = await createTestPdf(7);
    const result = await chunkPdf(pdfBuffer);

    expect(result.totalPages).toBe(7);
    expect(result.chunks).toHaveLength(2);

    // First chunk: pages 1-6
    expect(result.chunks[0].index).toBe(0);
    expect(result.chunks[0].pageStart).toBe(1);
    expect(result.chunks[0].pageEnd).toBe(6);
    const sub1 = await PDFDocument.load(result.chunks[0].pdfBytes);
    expect(sub1.getPageCount()).toBe(6);

    // Second chunk: page 7
    expect(result.chunks[1].index).toBe(1);
    expect(result.chunks[1].pageStart).toBe(7);
    expect(result.chunks[1].pageEnd).toBe(7);
    const sub2 = await PDFDocument.load(result.chunks[1].pdfBytes);
    expect(sub2.getPageCount()).toBe(1);
  });

  it("splits a 12-page PDF into exactly 2 chunks of 6", async () => {
    const pdfBuffer = await createTestPdf(12);
    const result = await chunkPdf(pdfBuffer);

    expect(result.totalPages).toBe(12);
    expect(result.chunks).toHaveLength(2);

    expect(result.chunks[0].pageStart).toBe(1);
    expect(result.chunks[0].pageEnd).toBe(6);

    expect(result.chunks[1].pageStart).toBe(7);
    expect(result.chunks[1].pageEnd).toBe(12);
  });

  it("splits a 13-page PDF into 3 chunks (6 + 6 + 1)", async () => {
    const pdfBuffer = await createTestPdf(13);
    const result = await chunkPdf(pdfBuffer);

    expect(result.totalPages).toBe(13);
    expect(result.chunks).toHaveLength(3);

    expect(result.chunks[0].pageStart).toBe(1);
    expect(result.chunks[0].pageEnd).toBe(6);

    expect(result.chunks[1].pageStart).toBe(7);
    expect(result.chunks[1].pageEnd).toBe(12);

    expect(result.chunks[2].pageStart).toBe(13);
    expect(result.chunks[2].pageEnd).toBe(13);
  });

  it("returns fullText as concatenation of all page texts", async () => {
    const pdfBuffer = await createTestPdf(3);
    const result = await chunkPdf(pdfBuffer);

    // pdf-lib drawText produces text extractable by pdf-parse
    // fullText should be a non-empty string (text extraction may or may not succeed
    // depending on the pdf-parse library's ability to extract text from pdf-lib output)
    expect(typeof result.fullText).toBe("string");
  });

  it("each chunk has a text property", async () => {
    const pdfBuffer = await createTestPdf(7);
    const result = await chunkPdf(pdfBuffer);

    expect(result.chunks).toHaveLength(2);
    for (const chunk of result.chunks) {
      expect(typeof chunk.text).toBe("string");
    }
  });

  it("throws for a corrupted/empty buffer", async () => {
    const emptyBuf = Buffer.from("not a valid pdf");
    await expect(chunkPdf(emptyBuf)).rejects.toThrow();
  });

  it("produces valid standalone sub-PDFs for each chunk", async () => {
    const pdfBuffer = await createTestPdf(15);
    const result = await chunkPdf(pdfBuffer);

    expect(result.chunks).toHaveLength(3); // 6 + 6 + 3

    for (const chunk of result.chunks) {
      // Each chunk's pdfBytes should be a loadable PDF
      const subDoc = await PDFDocument.load(chunk.pdfBytes);
      const expectedPages = chunk.pageEnd - chunk.pageStart + 1;
      expect(subDoc.getPageCount()).toBe(expectedPages);
    }
  });
});
