/**
 * PDF preparation utility for store_document.
 *
 * Returns a discriminated union telling the caller which embedding path
 * to take:
 *   - "multimodal" (totalPages <= 6): caller sends raw PDF bytes to
 *     Gemini's PDF embedding API as a single chunk. No splitting needed
 *     because we're under the 6-page-per-request cap.
 *   - "text-only" (totalPages > 6): caller embeds each page's extracted
 *     text via the standard text-embedding pipeline. Multimodal signal
 *     is lost on this path; see specs/2026-05-01-replace-pdf-lib-design.md
 *     for the rationale and tracking issue (kytheros/strata#4).
 *
 * Text extraction is via pdf-parse (a wrapper over Mozilla's pdfjs-dist).
 * The repo no longer depends on pdf-lib at runtime.
 */

/** Gemini Embedding 2 accepts at most 6 PDF pages per embedContent request. */
export const MULTIMODAL_PAGE_LIMIT = 6;

export interface PdfPage {
  /** 1-based page number. */
  pageNumber: number;
  /** Extracted text for this page. May be empty for image-only pages. */
  text: string;
}

export type PdfPrepareResult =
  | {
      mode: "multimodal";
      totalPages: number;
      pdfBytes: Buffer;
      fullText: string;
    }
  | {
      mode: "text-only";
      totalPages: number;
      pages: PdfPage[];
      fullText: string;
    };

export interface PreparePdfOptions {
  /**
   * Maximum number of pages to embed on the text-only path. Pages beyond
   * this cap are dropped with a WARN log. Multimodal path is unaffected.
   * Default: no cap (caller passes CONFIG.indexing.maxPdfPages).
   */
  maxPages?: number;
}

/**
 * Inspect a PDF and prepare it for embedding. Returns either a
 * multimodal-ready single chunk (≤6 pages) or per-page text chunks
 * (>6 pages).
 *
 * @throws Error if the PDF cannot be parsed or has 0 pages.
 */
export async function preparePdf(
  pdfBuffer: Buffer,
  options: PreparePdfOptions = {}
): Promise<PdfPrepareResult> {
  const { pageTexts, totalPages } = await extractPdfPages(pdfBuffer);

  if (totalPages === 0) {
    throw new Error("PDF has 0 pages — the file may be corrupted.");
  }

  const fullText = pageTexts.join("\n\n");

  if (totalPages <= MULTIMODAL_PAGE_LIMIT) {
    return {
      mode: "multimodal",
      totalPages,
      pdfBytes: pdfBuffer,
      fullText,
    };
  }

  const cap = options.maxPages;
  let effectiveTexts = pageTexts;
  if (cap !== undefined && totalPages > cap) {
    console.warn(
      `[strata] PDF has ${totalPages} pages, exceeding the configured ` +
        `STRATA_PDF_MAX_PAGES cap of ${cap}. Pages ${cap + 1}-${totalPages} will be dropped.`
    );
    effectiveTexts = pageTexts.slice(0, cap);
  }

  const pages: PdfPage[] = effectiveTexts.map((text, idx) => ({
    pageNumber: idx + 1,
    text,
  }));

  return {
    mode: "text-only",
    totalPages,
    pages,
    fullText,
  };
}

/**
 * Extract per-page text and total page count via pdf-parse.
 * Dynamically imported to keep pdf-parse (and its pdfjs-dist transitive)
 * out of the cold-start path for non-PDF document ingestion.
 */
async function extractPdfPages(
  pdfBuffer: Buffer
): Promise<{ pageTexts: string[]; totalPages: number }> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(pdfBuffer) });

  try {
    const textResult = await parser.getText();
    const totalPages = textResult.pages.length;
    const pageTexts: string[] = new Array(totalPages).fill("");

    for (const page of textResult.pages) {
      const idx = page.num - 1;
      if (idx >= 0 && idx < totalPages) {
        pageTexts[idx] = page.text.trim();
      }
    }

    return { pageTexts, totalPages };
  } finally {
    await parser.destroy();
  }
}
