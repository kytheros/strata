/**
 * Gemini Embedding 2 client for multimodal document embeddings.
 *
 * Uses gemini-embedding-2-preview to embed PDFs, images, and text
 * into 3072-dimensional vectors in a unified embedding space.
 *
 * Separate from GeminiEmbedder (gemini-embedding-001 for text) because:
 * - Different model name and API endpoint
 * - Supports inline_data (binary content) not just text
 * - Preview model — may change before GA
 */

const EMBEDDING_DIM = 3072;
const REQUEST_TIMEOUT_MS = 30_000; // Longer timeout for document processing

export class DocumentEmbedderError extends Error {
  constructor(message: string, public readonly statusCode?: number) {
    super(message);
    this.name = "DocumentEmbedderError";
  }
}

interface EmbedResponse {
  embedding?: { values: number[] };
  error?: { message: string; code: number };
}

export class DocumentEmbedder {
  private readonly apiKey: string;
  private readonly model: string;
  private fetchFn: typeof globalThis.fetch;

  readonly dimensions = EMBEDDING_DIM;

  constructor(options: {
    apiKey: string;
    model?: string;
    fetchFn?: typeof globalThis.fetch;
  }) {
    this.apiKey = options.apiKey;
    this.model = options.model || "gemini-embedding-2-preview";
    this.fetchFn = options.fetchFn || globalThis.fetch.bind(globalThis);
  }

  /** Embed a text string. */
  async embedText(text: string): Promise<Float32Array> {
    const body = {
      model: `models/${this.model}`,
      content: { parts: [{ text }] },
      taskType: "RETRIEVAL_DOCUMENT",
    };
    return this.callApi(body);
  }

  /** Embed binary content (PDF pages, images). */
  async embedBinary(data: Buffer, mimeType: string): Promise<Float32Array> {
    const body = {
      model: `models/${this.model}`,
      content: {
        parts: [{
          inline_data: {
            mime_type: mimeType,
            data: data.toString("base64"),
          },
        }],
      },
      taskType: "RETRIEVAL_DOCUMENT",
    };
    return this.callApi(body);
  }

  private async callApi(body: Record<string, unknown>): Promise<Float32Array> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:embedContent?key=${this.apiKey}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await this.fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errBody = await response.text().catch(() => "");
        throw new DocumentEmbedderError(
          `Document embedding API error: ${response.status} ${errBody}`,
          response.status
        );
      }

      const data = (await response.json()) as EmbedResponse;

      if (data.error) {
        throw new DocumentEmbedderError(
          `Document embedding API error: ${data.error.message}`,
          data.error.code
        );
      }

      if (!data.embedding?.values) {
        throw new DocumentEmbedderError("No embedding returned from API");
      }

      const vec = new Float32Array(data.embedding.values);
      if (vec.length !== EMBEDDING_DIM) {
        throw new DocumentEmbedderError(
          `Expected ${EMBEDDING_DIM}-dim embedding, got ${vec.length}`
        );
      }

      return vec;
    } catch (error) {
      if (error instanceof DocumentEmbedderError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new DocumentEmbedderError(`Document embedding request timed out after ${REQUEST_TIMEOUT_MS}ms`);
      }
      throw new DocumentEmbedderError(
        `Document embedding request failed: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
