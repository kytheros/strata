import { describe, it, expect, vi } from "vitest";
import { DocumentEmbedder } from "../../../src/extensions/embeddings/document-embedder.js";

describe("DocumentEmbedder", () => {
  it("embeds text content", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        embedding: { values: new Array(3072).fill(0.1) },
      }),
    });

    const embedder = new DocumentEmbedder({
      apiKey: "test-key",
      model: "gemini-embedding-2-preview",
      fetchFn: mockFetch as any,
    });

    const result = await embedder.embedText("hello world");
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(3072);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const callUrl = mockFetch.mock.calls[0][0] as string;
    expect(callUrl).toContain("gemini-embedding-2-preview");
    expect(callUrl).toContain("embedContent");
  });

  it("embeds binary content (PDF/image)", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        embedding: { values: new Array(3072).fill(0.2) },
      }),
    });

    const embedder = new DocumentEmbedder({
      apiKey: "test-key",
      model: "gemini-embedding-2-preview",
      fetchFn: mockFetch as any,
    });

    const pdfBytes = Buffer.from("fake pdf content");
    const result = await embedder.embedBinary(pdfBytes, "application/pdf");
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(3072);

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.content.parts[0].inline_data.mime_type).toBe("application/pdf");
  });

  it("throws on API error", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "Bad Request",
    });

    const embedder = new DocumentEmbedder({
      apiKey: "test-key",
      model: "gemini-embedding-2-preview",
      fetchFn: mockFetch as any,
    });

    await expect(embedder.embedText("fail")).rejects.toThrow("embedding API error");
  });
});
