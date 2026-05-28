/**
 * Vertex AI Gemini provider for the LongMemEval benchmark answer-model path.
 *
 * Uses the @google/genai SDK in Vertex mode so requests bill against the
 * user's Google Cloud account (and the $300 free-trial credit when available)
 * instead of Google AI Studio's per-key billing.
 *
 * Auth: Application Default Credentials (`gcloud auth application-default login`).
 * The SDK auto-refreshes access tokens.
 *
 * Spec: specs/2026-05-28-vertex-gemini-benchmark-provider-design.md
 */

import { GoogleGenAI } from "@google/genai";
import type { CompletionOptions, LlmProvider } from "./llm-provider.js";
import { LlmError } from "./llm-provider.js";

/** Minimal shape of the @google/genai client we depend on (for test mocking) */
export interface MinimalGenAIClient {
  models: {
    generateContent: (req: {
      model: string;
      contents: string | Array<{ role: string; parts: Array<{ text: string }> }>;
      config?: Record<string, unknown>;
    }) => Promise<{
      text?: string;
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
        finishReason?: string;
      }>;
    }>;
  };
}

export interface VertexGeminiProviderOptions {
  projectId: string;
  location?: string;
  model?: string;
  /** Override for tests — when present, skips constructing a real GoogleGenAI client */
  genaiClient?: MinimalGenAIClient;
}

export class VertexGeminiProvider implements LlmProvider {
  readonly name = "vertex-gemini";
  private readonly projectId: string;
  private readonly location: string;
  private readonly model: string;
  private readonly client: MinimalGenAIClient;

  constructor(options: VertexGeminiProviderOptions) {
    if (!options.projectId) {
      throw new Error(
        "VertexGeminiProvider: VERTEX_PROJECT_ID is required. " +
          "Set it in .env or pass projectId explicitly."
      );
    }
    this.projectId = options.projectId;
    this.location = options.location || "us-central1";
    this.model = options.model || "gemini-2.5-flash";

    if (options.genaiClient) {
      this.client = options.genaiClient;
    } else {
      this.client = new GoogleGenAI({
        vertexai: true,
        project: this.projectId,
        location: this.location,
      }) as unknown as MinimalGenAIClient;
    }
  }

  /** Expose config for test assertions and downstream callers. */
  getConfig(): { projectId: string; location: string; model: string } {
    return { projectId: this.projectId, location: this.location, model: this.model };
  }

  /** Expose the underlying SDK client for callers that need direct access
   *  (e.g. the agent loop with tools).
   */
  getGenaiClient(): MinimalGenAIClient {
    return this.client;
  }

  async complete(prompt: string, options: CompletionOptions = {}): Promise<string> {
    const { maxTokens = 2048, temperature = 0.2, jsonMode = false } = options;

    try {
      const response = await this.client.models.generateContent({
        model: this.model,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: {
          temperature,
          maxOutputTokens: maxTokens,
          ...(jsonMode ? { responseMimeType: "application/json" } : {}),
        },
      });

      // SDK exposes top-level .text as a convenience aggregate of text parts;
      // fall back to walking candidates[0].content.parts[].text if absent.
      const text =
        response.text ??
        response.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ??
        "";

      if (!text) {
        const reason = response.candidates?.[0]?.finishReason || "unknown";
        throw new LlmError(
          `No text in Vertex Gemini response (finishReason: ${reason})`,
          this.name,
          reason === "SAFETY" ? 400 : undefined
        );
      }

      return text;
    } catch (err) {
      if (err instanceof LlmError) throw err;
      const status =
        typeof err === "object" && err !== null && "status" in err
          ? (err as { status?: number }).status
          : undefined;
      const message = err instanceof Error ? err.message : String(err);
      throw new LlmError(`Vertex Gemini request failed: ${message}`, this.name, status);
    }
  }
}
