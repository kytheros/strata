import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  preparePdf,
  MULTIMODAL_PAGE_LIMIT,
  type PdfPrepareResult,
} from "../../src/tools/pdf-prepare.js";

const FIXTURES = join(__dirname, "..", "fixtures", "pdfs");
const load = (name: string): Buffer => readFileSync(join(FIXTURES, name));

describe("preparePdf", () => {
  it("exports MULTIMODAL_PAGE_LIMIT as 6", () => {
    expect(MULTIMODAL_PAGE_LIMIT).toBe(6);
  });

  it("returns multimodal mode for a 1-page PDF", async () => {
    const buf = load("1-page.pdf");
    const result = await preparePdf(buf);

    expect(result.mode).toBe("multimodal");
    if (result.mode !== "multimodal") return;
    expect(result.totalPages).toBe(1);
    expect(result.pdfBytes).toBeInstanceOf(Buffer);
    expect(result.pdfBytes.length).toBe(buf.length);
    expect(typeof result.fullText).toBe("string");
  });

  it("returns multimodal mode for a 6-page PDF (boundary)", async () => {
    const buf = load("6-pages.pdf");
    const result = await preparePdf(buf);

    expect(result.mode).toBe("multimodal");
    if (result.mode !== "multimodal") return;
    expect(result.totalPages).toBe(6);
    expect(result.pdfBytes.length).toBe(buf.length);
  });

  it("returns text-only mode for a 7-page PDF (boundary)", async () => {
    const buf = load("7-pages.pdf");
    const result = await preparePdf(buf);

    expect(result.mode).toBe("text-only");
    if (result.mode !== "text-only") return;
    expect(result.totalPages).toBe(7);
    expect(result.pages).toHaveLength(7);
    expect(result.pages[0].pageNumber).toBe(1);
    expect(result.pages[6].pageNumber).toBe(7);
    for (const page of result.pages) {
      expect(typeof page.text).toBe("string");
    }
  });

  it("returns text-only mode for a 13-page PDF", async () => {
    const buf = load("13-pages.pdf");
    const result = await preparePdf(buf);

    expect(result.mode).toBe("text-only");
    if (result.mode !== "text-only") return;
    expect(result.totalPages).toBe(13);
    expect(result.pages).toHaveLength(13);
    expect(result.pages.map((p) => p.pageNumber)).toEqual(
      Array.from({ length: 13 }, (_, i) => i + 1)
    );
  });

  it("throws for a corrupted/empty buffer", async () => {
    const buf = load("empty-or-corrupt.pdf");
    await expect(preparePdf(buf)).rejects.toThrow();
  });

  it("populates fullText as concatenation across all pages (text-only mode)", async () => {
    const buf = load("13-pages.pdf");
    const result = await preparePdf(buf);

    if (result.mode !== "text-only") throw new Error("expected text-only");
    expect(typeof result.fullText).toBe("string");
    // pdf-parse should extract the test text we wrote
    expect(result.fullText.length).toBeGreaterThan(0);
  });
});

describe("preparePdf — maxPages cap", () => {
  it("truncates text-only result to maxPages when totalPages exceeds the cap", async () => {
    const buf = load("13-pages.pdf");
    const result = await preparePdf(buf, { maxPages: 10 });

    expect(result.mode).toBe("text-only");
    if (result.mode !== "text-only") return;
    // totalPages reflects the original document, not the cap
    expect(result.totalPages).toBe(13);
    // pages array is truncated to the cap
    expect(result.pages).toHaveLength(10);
    expect(result.pages[0].pageNumber).toBe(1);
    expect(result.pages[9].pageNumber).toBe(10);
  });

  it("does not truncate when totalPages is within maxPages", async () => {
    const buf = load("7-pages.pdf");
    const result = await preparePdf(buf, { maxPages: 100 });

    expect(result.mode).toBe("text-only");
    if (result.mode !== "text-only") return;
    expect(result.pages).toHaveLength(7);
  });

  it("does not apply the cap on the multimodal path", async () => {
    const buf = load("6-pages.pdf");
    const result = await preparePdf(buf, { maxPages: 3 });

    expect(result.mode).toBe("multimodal");
    if (result.mode !== "multimodal") return;
    expect(result.totalPages).toBe(6);
    // Raw bytes are unchanged — multimodal path doesn't paginate
    expect(result.pdfBytes.length).toBe(buf.length);
  });
});
