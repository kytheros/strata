/**
 * One-off generator for the static PDF fixtures used by tests/tools/pdf-prepare.test.ts.
 *
 * Run from the strata/ repo root with:
 *   node scripts/generate-pdf-fixtures.mjs
 *
 * Regenerate only when adding a new page-count fixture. The committed PDFs
 * are the source of truth for test runs; this script is reference + recovery.
 */
import { PDFDocument, StandardFonts } from "pdf-lib";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "tests", "fixtures", "pdfs");

mkdirSync(OUT_DIR, { recursive: true });

async function makePdf(numPages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < numPages; i++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`Page ${i + 1} content for testing`, {
      x: 50,
      y: 700,
      size: 14,
      font,
    });
  }
  return Buffer.from(await doc.save());
}

const sizes = [1, 6, 7, 13];
for (const n of sizes) {
  const filename = n === 1 ? "1-page.pdf" : `${n}-pages.pdf`;
  const bytes = await makePdf(n);
  writeFileSync(join(OUT_DIR, filename), bytes);
  console.log(`Wrote ${filename} (${bytes.length} bytes)`);
}

// Corrupted fixture: not a valid PDF file
writeFileSync(join(OUT_DIR, "empty-or-corrupt.pdf"), Buffer.from("not a valid pdf"));
console.log("Wrote empty-or-corrupt.pdf");
