/**
 * PDF chunking utility for store_document.
 *
 * Splits multi-page PDFs into groups of up to MAX_PAGES_PER_CHUNK pages,
 * extracts text per page for FTS5 indexing, and produces sub-PDF buffers
 * that can be sent to the Gemini Embedding 2 API (which has a 6-page limit).
 *
 * Uses pdf-lib for PDF splitting and pdf-parse for text extraction.
 */

import { PDFDocument } from "pdf-lib";

/** Gemini Embedding 2 accepts at most 6 PDF pages per embedContent request. */
export const MAX_PAGES_PER_CHUNK = 6;

export interface PdfChunkResult {
  /** Total number of pages in the source PDF. */
  totalPages: number;
  /** One entry per chunk (group of up to 6 pages). */
  chunks: PdfChunk[];
  /** Concatenated text from all pages, for FTS5 indexing. */
  fullText: string;
}

export interface PdfChunk {
  /** Zero-based chunk index. */
  index: number;
  /** 1-based start page (inclusive). */
  pageStart: number;
  /** 1-based end page (inclusive). */
  pageEnd: number;
  /** Sub-PDF bytes for this chunk (valid standalone PDF). */
  pdfBytes: Buffer;
  /** Extracted text from pages in this chunk. */
  text: string;
}

/**
 * Split a PDF buffer into chunks of up to MAX_PAGES_PER_CHUNK pages.
 *
 * For each chunk, produces:
 * - A valid standalone PDF buffer (for sending to the embedding API)
 * - Extracted text content (for FTS5 keyword indexing)
 *
 * @throws Error if the PDF has 0 pages or cannot be parsed.
 */
export async function chunkPdf(pdfBuffer: Buffer): Promise<PdfChunkResult> {
  // Load the source PDF with pdf-lib
  const srcDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const totalPages = srcDoc.getPageCount();

  if (totalPages === 0) {
    throw new Error("PDF has 0 pages — the file may be corrupted or image-only.");
  }

  // Extract text using pdf-parse (dynamic import for ESM compatibility)
  const pageTexts = await extractTextPerPage(pdfBuffer, totalPages);

  const chunks: PdfChunk[] = [];
  const numChunks = Math.ceil(totalPages / MAX_PAGES_PER_CHUNK);

  for (let i = 0; i < numChunks; i++) {
    const startIdx = i * MAX_PAGES_PER_CHUNK; // 0-based page index
    const endIdx = Math.min(startIdx + MAX_PAGES_PER_CHUNK, totalPages); // exclusive
    const pageStart = startIdx + 1; // 1-based
    const pageEnd = endIdx; // 1-based, inclusive

    // Create a new PDF containing only these pages
    const chunkDoc = await PDFDocument.create();
    const pageIndices = Array.from({ length: endIdx - startIdx }, (_, j) => startIdx + j);
    const copiedPages = await chunkDoc.copyPages(srcDoc, pageIndices);

    for (const page of copiedPages) {
      chunkDoc.addPage(page);
    }

    const chunkBytes = await chunkDoc.save();

    // Gather text for these pages
    const chunkTexts: string[] = [];
    for (let p = startIdx; p < endIdx; p++) {
      if (pageTexts[p]) {
        chunkTexts.push(pageTexts[p]);
      }
    }

    chunks.push({
      index: i,
      pageStart,
      pageEnd,
      pdfBytes: Buffer.from(chunkBytes),
      text: chunkTexts.join("\n\n"),
    });
  }

  const fullText = pageTexts.join("\n\n");

  return { totalPages, chunks, fullText };
}

/**
 * Extract text per page using pdf-parse.
 * Returns an array indexed by 0-based page number.
 */
async function extractTextPerPage(pdfBuffer: Buffer, totalPages: number): Promise<string[]> {
  try {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(pdfBuffer) });

    try {
      const textResult = await parser.getText();
      // textResult.pages is an array of { num, text } — num is 1-based
      const pageTexts: string[] = new Array(totalPages).fill("");

      for (const page of textResult.pages) {
        const idx = page.num - 1; // Convert to 0-based
        if (idx >= 0 && idx < totalPages) {
          pageTexts[idx] = page.text.trim();
        }
      }

      return pageTexts;
    } finally {
      await parser.destroy();
    }
  } catch (err) {
    // If pdf-parse fails (e.g., encrypted PDF, image-only PDF),
    // return empty strings — we can still embed the raw PDF bytes
    return new Array(totalPages).fill("");
  }
}
