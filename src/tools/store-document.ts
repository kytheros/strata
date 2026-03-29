/**
 * store_document MCP tool handler.
 * Accepts raw document content, chunks it, embeds via Gemini Embedding 2,
 * and stores chunks for semantic + keyword search.
 */

import { randomUUID } from "crypto";
import { readFileSync, existsSync, statSync } from "fs";
import { DocumentChunkStore, type StoredDocument, type DocumentChunk as StoredChunk } from "../storage/document-chunk-store.js";
import type { DocumentEmbedder } from "../extensions/embeddings/document-embedder.js";
import { CONFIG } from "../config.js";

const SUPPORTED_MIME_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "image/png",
  "image/jpeg",
]);

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

  if (!embedder) {
    return "Error: store_document requires a Gemini API key for document embeddings. Set GEMINI_API_KEY.";
  }

  // --- Read document ---
  let docBytes: Buffer;
  try {
    if (content) {
      docBytes = Buffer.from(content, "base64");
    } else {
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

  try {
    if (mime_type === "text/plain") {
      // --- Text chunking ---
      const text = docBytes.toString("utf-8");
      const chunkSize = CONFIG.indexing.chunkSize;
      const overlap = CONFIG.indexing.chunkOverlap;
      const textChunks = chunkText(text, chunkSize, overlap);

      for (let i = 0; i < textChunks.length; i++) {
        try {
          const embedding = await embedder.embedText(textChunks[i]);
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
    } else if (mime_type === "image/png" || mime_type === "image/jpeg") {
      // --- Single image embedding ---
      try {
        const embedding = await embedder.embedBinary(docBytes, mime_type);
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
      // --- PDF chunking by page groups ---
      // For now, embed the entire PDF in one call if <= 6 pages,
      // or split into 6-page chunks. Text extraction requires pdf-parse
      // which will be added as a dependency.
      try {
        const embedding = await embedder.embedBinary(docBytes, mime_type);
        chunks.push({
          id: randomUUID(),
          documentId: docId,
          chunkIndex: 0,
          embedding,
          model: CONFIG.embeddings.documentModel,
          pageStart: 1,
          createdAt: now,
        });
      } catch (err) {
        errors.push(`PDF: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    return `Error processing document: ${err instanceof Error ? err.message : String(err)}`;
  }

  if (chunks.length === 0) {
    const errorDetail = errors.length > 0 ? ` Errors: ${errors.join("; ")}` : "";
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
    fileSize: docBytes.length,
    createdAt: now,
  };

  store.addDocument(doc, chunks);

  // --- Result ---
  const lines = [
    `Stored "${title}" (${chunks.length} chunk${chunks.length === 1 ? "" : "s"}, ${chunks.length} embedding${chunks.length === 1 ? "" : "s"} generated)`,
    `Document ID: ${docId}`,
    `Searchable via semantic_search and search_history`,
  ];

  if (errors.length > 0) {
    lines.push(`\nWarnings (${errors.length} chunks failed): ${errors.join("; ")}`);
  }

  return lines.join("\n");
}

/** Split text into chunks with overlap. Simple character-based splitting. */
function chunkText(text: string, chunkSize: number, overlap: number): string[] {
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
