/**
 * store_document MCP tool handler.
 * Accepts raw document content, chunks it, embeds via Gemini Embedding 2,
 * and stores chunks for semantic + keyword search.
 */

import { randomUUID } from "crypto";
import { readFileSync, existsSync, statSync, realpathSync } from "fs";
import { resolve, relative, isAbsolute, delimiter } from "path";
import { DocumentChunkStore, type StoredDocument, type DocumentChunk as StoredChunk } from "../storage/document-chunk-store.js";
import type { DocumentEmbedder } from "../extensions/embeddings/document-embedder.js";
import { CONFIG } from "../config.js";
import { preparePdf } from "./pdf-prepare.js";

const SUPPORTED_MIME_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "image/png",
  "image/jpeg",
]);

/**
 * file_path reads are confined to allowed root directories so a malicious or
 * prompt-injected MCP client cannot index arbitrary files (~/.ssh keys, .env)
 * and exfiltrate them through search. Defaults to the server's working
 * directory; operators widen it with STRATA_DOCUMENT_ROOTS (path-delimiter-
 * separated list) or disable confinement entirely with STRATA_DOCUMENT_ROOTS="*".
 */
function allowedDocumentRoots(): string[] | null {
  const env = process.env.STRATA_DOCUMENT_ROOTS?.trim();
  if (env === "*") return null;
  if (env) {
    return env
      .split(delimiter)
      .map((p) => resolve(p.trim()))
      .filter((p) => p.length > 0);
  }
  return [process.cwd()];
}

function isWithinRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Returns an error message when filePath escapes the allowed roots, else null. */
export function validateDocumentPath(filePath: string): string | null {
  const roots = allowedDocumentRoots();
  if (roots === null) return null;
  const rootsNote = `Allowed roots: ${roots.join(", ")}. Set STRATA_DOCUMENT_ROOTS to allow more directories ("*" disables confinement).`;

  const resolved = resolve(filePath);
  if (!roots.some((r) => isWithinRoot(r, resolved))) {
    return `Error: file_path is outside the allowed document roots. ${rootsNote}`;
  }

  // Re-check through symlinks so a link inside a root can't point outside it.
  try {
    const real = realpathSync(resolved);
    const realRoots = roots.map((r) => {
      try {
        return realpathSync(r);
      } catch {
        return r;
      }
    });
    if (!realRoots.some((r) => isWithinRoot(r, real))) {
      return `Error: file_path resolves outside the allowed document roots via a symlink. ${rootsNote}`;
    }
  } catch {
    // Path doesn't exist — the existence check in the handler reports that case.
  }
  return null;
}

export interface StoreDocumentArgs {
  file_path?: string;
  content?: string;
  mime_type: string;
  title: string;
  tags?: string[];
  project?: string;
  user?: string;
}

export async function handleStoreDocument(
  store: DocumentChunkStore,
  embedder: DocumentEmbedder | null,
  args: StoreDocumentArgs
): Promise<string> {
  const { file_path, content, mime_type, title, tags = [], project = "global", user } = args;

  // --- Validation ---
  if (!content && !file_path) {
    return "Error: Either file_path or content (base64) is required.";
  }

  if (!SUPPORTED_MIME_TYPES.has(mime_type)) {
    return `Error: Unsupported mime type "${mime_type}". Supported: ${[...SUPPORTED_MIME_TYPES].join(", ")}`;
  }

  // When no embedder is available (no Gemini key or non-Gemini provider without creds),
  // documents are stored and FTS5-indexed but not vector-embedded.
  // A note is appended to the response; this is not an error.
  const keylessNote = !embedder
    ? "Note: document semantic search needs GEMINI_API_KEY — document stored for FTS5 keyword search only."
    : null;

  // --- Read document ---
  let docBytes: Buffer;
  try {
    if (content) {
      docBytes = Buffer.from(content, "base64");
    } else {
      const pathError = validateDocumentPath(file_path!);
      if (pathError) return pathError;
      if (!existsSync(file_path!)) {
        return `Error: File not found: ${file_path}`;
      }
      const stats = statSync(file_path!);
      if (stats.size > CONFIG.embeddings.maxDocumentSize) {
        const maxMb = Math.round(CONFIG.embeddings.maxDocumentSize / 1024 / 1024);
        return `Error: File size (${Math.round(stats.size / 1024 / 1024)}MB) exceeds maximum (${maxMb}MB).`;
      }
      docBytes = readFileSync(file_path!);
    }
  } catch (err) {
    return `Error reading document: ${err instanceof Error ? err.message : String(err)}`;
  }

  const docId = randomUUID();
  const now = Date.now();
  const chunks: StoredChunk[] = [];
  const errors: string[] = [];
  let totalPages: number | undefined;
  let fullText: string | undefined;

  try {
    if (mime_type === "text/plain") {
      // --- Text chunking ---
      const text = docBytes.toString("utf-8");
      const chunkSize = CONFIG.indexing.chunkSize;
      const overlap = CONFIG.indexing.chunkOverlap;
      const textChunks = chunkText(text, chunkSize, overlap);

      for (let i = 0; i < textChunks.length; i++) {
        if (keylessNote) {
          // No embedder available — store text chunk with a zeroed embedding for FTS5.
          // The document will be keyword-searchable but not vector-searchable.
          chunks.push({
            id: randomUUID(),
            documentId: docId,
            chunkIndex: i,
            content: textChunks[i],
            embedding: new Float32Array(1), // placeholder; not used for search
            model: CONFIG.embeddings.documentModel,
            tokenCount: Math.ceil(textChunks[i].length / 4),
            createdAt: now,
          });
        } else {
          try {
            const embedding = await embedder!.embedText(textChunks[i]);
            chunks.push({
              id: randomUUID(),
              documentId: docId,
              chunkIndex: i,
              content: textChunks[i],
              embedding,
              model: CONFIG.embeddings.documentModel,
              tokenCount: Math.ceil(textChunks[i].length / 4), // rough estimate
              createdAt: now,
            });
          } catch (err) {
            errors.push(`Chunk ${i}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    } else if (mime_type === "image/png" || mime_type === "image/jpeg") {
      // --- Single image embedding ---
      if (keylessNote) {
        // Images require Gemini multimodal — cannot store without embedder.
        return `${keylessNote}\nImages require GEMINI_API_KEY for storage. Cannot store image without embedder.`;
      }
      try {
        const embedding = await embedder!.embedBinary(docBytes, mime_type);
        chunks.push({
          id: randomUUID(),
          documentId: docId,
          chunkIndex: 0,
          embedding,
          model: CONFIG.embeddings.documentModel,
          createdAt: now,
        });
      } catch (err) {
        errors.push(`Image: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else if (mime_type === "application/pdf") {
      // --- PDF: hybrid path ---
      // ≤6 pages: single multimodal embedding (raw bytes to Gemini).
      // >6 pages: per-page text embedding. See pdf-prepare.ts.
      let pdfResult;
      try {
        pdfResult = await preparePdf(docBytes, { maxPages: CONFIG.indexing.maxPdfPages });
      } catch (err) {
        return `Error: PDF processing failed: ${err instanceof Error ? err.message : String(err)}`;
      }

      totalPages = pdfResult.totalPages;
      fullText = pdfResult.fullText;

      if (pdfResult.mode === "multimodal") {
        if (keylessNote) {
          // Multimodal PDF requires Gemini — cannot embed without key.
          // Store a text-only chunk from fullText if available.
          const text = pdfResult.fullText || "";
          if (text.trim()) {
            chunks.push({
              id: randomUUID(),
              documentId: docId,
              chunkIndex: 0,
              content: text,
              embedding: new Float32Array(1), // placeholder
              model: CONFIG.embeddings.documentModel,
              pageStart: 1,
              pageEnd: pdfResult.totalPages,
              createdAt: now,
            });
          }
        } else {
          try {
            const embedding = await embedder!.embedBinary(pdfResult.pdfBytes, mime_type);
            chunks.push({
              id: randomUUID(),
              documentId: docId,
              chunkIndex: 0,
              content: pdfResult.fullText || undefined,
              embedding,
              model: CONFIG.embeddings.documentModel,
              pageStart: 1,
              pageEnd: pdfResult.totalPages,
              createdAt: now,
            });
          } catch (err) {
            errors.push(`PDF (multimodal, ${pdfResult.totalPages} pages): ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } else {
        // text-only mode
        let chunkIdx = 0;
        for (const page of pdfResult.pages) {
          if (!page.text) {
            // Empty page (e.g., image-only scan with no text layer) — skip
            continue;
          }
          if (keylessNote) {
            chunks.push({
              id: randomUUID(),
              documentId: docId,
              chunkIndex: chunkIdx++,
              content: page.text,
              embedding: new Float32Array(1), // placeholder
              model: CONFIG.embeddings.documentModel,
              tokenCount: Math.ceil(page.text.length / 4),
              pageStart: page.pageNumber,
              pageEnd: page.pageNumber,
              createdAt: now,
            });
          } else {
            try {
              const embedding = await embedder!.embedText(page.text);
              chunks.push({
                id: randomUUID(),
                documentId: docId,
                chunkIndex: chunkIdx++,
                content: page.text,
                embedding,
                model: CONFIG.embeddings.documentModel,
                tokenCount: Math.ceil(page.text.length / 4),
                pageStart: page.pageNumber,
                pageEnd: page.pageNumber,
                createdAt: now,
              });
            } catch (err) {
              errors.push(`PDF page ${page.pageNumber}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
      }
    }
  } catch (err) {
    return `Error processing document: ${err instanceof Error ? err.message : String(err)}`;
  }

  if (chunks.length === 0) {
    const errorDetail = errors.length > 0 ? ` Errors: ${errors.join("; ")}` : "";
    if (keylessNote) {
      return `${keylessNote}\nNo text content could be extracted for FTS5 indexing.${errorDetail}`;
    }
    return `Error: No chunks could be embedded for "${title}".${errorDetail}`;
  }

  // --- Store ---
  const doc: StoredDocument = {
    id: docId,
    title,
    mimeType: mime_type,
    project,
    user,
    tags,
    chunkCount: chunks.length,
    totalPages,
    fileSize: docBytes.length,
    createdAt: now,
  };

  store.addDocument(doc, chunks);

  // --- Result ---
  const pageInfo = totalPages ? `${totalPages} page${totalPages === 1 ? "" : "s"}, ` : "";
  const embeddingInfo = keylessNote
    ? `${chunks.length} chunk${chunks.length === 1 ? "" : "s"} indexed for keyword search`
    : `${chunks.length} chunk${chunks.length === 1 ? "" : "s"}, ${chunks.length} embedding${chunks.length === 1 ? "" : "s"} generated`;
  const lines = [
    `Stored "${title}" (${pageInfo}${embeddingInfo})`,
    `Document ID: ${docId}`,
    keylessNote
      ? `Searchable via search_history (keyword only)`
      : `Searchable via semantic_search and search_history`,
  ];

  if (keylessNote) {
    lines.push(`\n${keylessNote}`);
  }

  if (errors.length > 0) {
    lines.push(`\nWarnings (${errors.length} chunks failed): ${errors.join("; ")}`);
  }

  return lines.join("\n");
}

/** Split text into chunks with overlap. Simple character-based splitting. */
export function chunkText(text: string, chunkSize: number, overlap: number): string[] {
  // Approximate chars per token (~4 chars/token for English)
  const charsPerChunk = chunkSize * 4;
  const charsOverlap = overlap * 4;

  if (text.length <= charsPerChunk) return [text];

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + charsPerChunk, text.length);
    chunks.push(text.slice(start, end));
    start = end - charsOverlap;
    if (start >= text.length) break;
  }

  return chunks;
}
