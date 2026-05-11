/**
 * Gemini embedding provider using gemini-embedding-001.
 *
 * Auth cascade:
 * 1. API key -- GEMINI_API_KEY env var -> generativelanguage.googleapis.com
 * 2. ADC / Vertex AI -- {region}-aiplatform.googleapis.com
 * 3. Unavailable -- tryCreateGeminiEmbedder() returns null
 *
 * No SDK dependency -- raw fetch() only.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createSign } from "crypto";

/** Embedding dimension for gemini-embedding-001 */
const EMBEDDING_DIM = 3072;

/** Max texts per batch request (Vertex AI limit) */
const MAX_BATCH_SIZE = 10;

/** Request timeout in milliseconds */
const REQUEST_TIMEOUT_MS = 15_000;

/** Typed error for embedding failures */
export class EmbedderError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number
  ) {
    super(message);
    this.name = "EmbedderError";
  }
}

/**
 * Retry settings for transient upstream failures. The Gemini API occasionally
 * returns 5xx (especially 503 UNAVAILABLE) under load. Retry on 5xx and 429;
 * fail-fast on 4xx (caller errors that won't resolve on retry).
 */
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function isRetryable(err: unknown): boolean {
  if (!(err instanceof EmbedderError)) return false;
  if (err.statusCode === undefined) return false;
  return RETRYABLE_STATUS.has(err.statusCode);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** OAuth token with expiration */
interface AccessToken {
  token: string;
  expiresAt: number;
}

/** Gemini API embedContent response */
interface GeminiEmbedResponse {
  embedding?: { values: number[] };
  error?: { message: string; code: number };
}

/** Gemini API batchEmbedContents response */
interface GeminiBatchEmbedResponse {
  embeddings?: Array<{ values: number[] }>;
  error?: { message: string; code: number };
}

/** Vertex AI predict response */
interface VertexPredictResponse {
  predictions?: Array<{ embeddings: { values: number[] } }>;
  error?: { message: string; code: number };
}

/**
 * GeminiEmbedder generates 3072-dimensional embeddings using gemini-embedding-001.
 * Supports both Gemini API (API key) and Vertex AI (ADC) endpoints.
 */
export class GeminiEmbedder {
  private readonly model = "gemini-embedding-001";
  private readonly apiKey: string | undefined;
  private readonly project: string;
  private readonly region: string;
  private readonly useVertexAi: boolean;
  private tokenCache: AccessToken | null = null;
  private fetchFn: typeof globalThis.fetch;

  /** Embedding dimensionality (3072 for gemini-embedding-001) */
  readonly dimensions = EMBEDDING_DIM;

  constructor(options: {
    apiKey?: string;
    project?: string;
    region?: string;
    fetchFn?: typeof globalThis.fetch;
  }) {
    this.apiKey = options.apiKey;
    this.project = options.project || "";
    this.region = options.region || "us-central1";
    this.useVertexAi = !this.apiKey && !!this.project;
    this.fetchFn = options.fetchFn || globalThis.fetch.bind(globalThis);
  }

  /**
   * Embed a single text string into a 3072-dimensional Float32Array.
   *
   * @param text - The text to embed
   * @param taskType - Optional Gemini task type hint (e.g., "CODE_RETRIEVAL_QUERY", "RETRIEVAL_DOCUMENT")
   */
  async embed(text: string, taskType?: string): Promise<Float32Array> {
    const results = await this.embedBatch([text], taskType);
    return results[0];
  }

  /**
   * Embed multiple texts in batches of up to 10 per API call.
   * Returns one Float32Array per input text, in the same order.
   *
   * @param texts - The texts to embed
   * @param taskType - Optional Gemini task type hint. Supported values:
   *   "RETRIEVAL_DOCUMENT" — for stored entries/documents
   *   "RETRIEVAL_QUERY" — for search queries
   *   "CODE_RETRIEVAL_QUERY" — for code-related search queries
   *   "SEMANTIC_SIMILARITY" — for comparing text similarity
   */
  async embedBatch(texts: string[], taskType?: string): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    const results: Float32Array[] = [];

    // Chunk into batches of MAX_BATCH_SIZE
    for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
      const chunk = texts.slice(i, i + MAX_BATCH_SIZE);
      const chunkResults = await this.embedChunk(chunk, taskType);
      results.push(...chunkResults);
    }

    return results;
  }

  /**
   * Embed a chunk of up to 10 texts in a single API call.
   *
   * Retries up to MAX_RETRIES times on transient upstream failures (5xx + 429)
   * with exponential backoff. Fails fast on 4xx errors (caller-side; retries
   * won't help). The AbortController + timeout is scoped to each attempt so a
   * stalled response doesn't block the retry from kicking in.
   */
  private async embedChunk(texts: string[], taskType?: string): Promise<Float32Array[]> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        if (this.apiKey) {
          return await this.embedViaGeminiApi(texts, controller.signal, taskType);
        } else {
          return await this.embedViaVertexAi(texts, controller.signal, taskType);
        }
      } catch (error) {
        lastError = error;

        // Normalize non-EmbedderError throws to EmbedderError for consistent handling.
        let normalized: unknown = error;
        if (!(error instanceof EmbedderError)) {
          if (error instanceof Error && error.name === "AbortError") {
            normalized = new EmbedderError(
              `Embedding request timed out after ${REQUEST_TIMEOUT_MS}ms`
            );
          } else {
            normalized = new EmbedderError(
              `Embedding request failed: ${error instanceof Error ? error.message : String(error)}`
            );
          }
          lastError = normalized;
        }

        // Decide whether to retry. Non-retryable errors or last-attempt → re-throw.
        const canRetry = attempt < MAX_RETRIES && isRetryable(normalized);
        if (!canRetry) {
          throw normalized;
        }

        // Backoff: 500ms, 1000ms, 2000ms. Don't block the retry on a stale timeout.
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        await sleep(delay);
      } finally {
        clearTimeout(timeout);
      }
    }

    // Unreachable: the loop either returns success or throws on the last attempt.
    throw lastError;
  }

  /**
   * Embed via Gemini API (generativelanguage.googleapis.com) using batchEmbedContents.
   */
  private async embedViaGeminiApi(
    texts: string[],
    signal: AbortSignal,
    taskType?: string
  ): Promise<Float32Array[]> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:batchEmbedContents?key=${this.apiKey}`;

    const body = {
      requests: texts.map((text) => ({
        model: `models/${this.model}`,
        content: { parts: [{ text }] },
        ...(taskType ? { taskType } : {}),
      })),
    };

    const response = await this.fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      throw new EmbedderError(
        `Gemini embedding API error: ${response.status} ${errBody}`,
        response.status
      );
    }

    const data = (await response.json()) as GeminiBatchEmbedResponse;

    if (data.error) {
      throw new EmbedderError(
        `Gemini embedding API error: ${data.error.message}`,
        data.error.code
      );
    }

    if (!data.embeddings || data.embeddings.length !== texts.length) {
      throw new EmbedderError(
        `Expected ${texts.length} embeddings, got ${data.embeddings?.length ?? 0}`
      );
    }

    return data.embeddings.map((e) => {
      const vec = new Float32Array(e.values);
      if (vec.length !== EMBEDDING_DIM) {
        throw new EmbedderError(
          `Expected ${EMBEDDING_DIM}-dim embedding, got ${vec.length}`
        );
      }
      return vec;
    });
  }

  /**
   * Embed via Vertex AI (aiplatform.googleapis.com) using predict endpoint.
   */
  private async embedViaVertexAi(
    texts: string[],
    signal: AbortSignal,
    taskType?: string
  ): Promise<Float32Array[]> {
    const token = await this.getAccessToken();
    const url = `https://${this.region}-aiplatform.googleapis.com/v1/projects/${this.project}/locations/${this.region}/publishers/google/models/${this.model}:predict`;

    const body = {
      instances: texts.map((text) => ({
        content: text,
        ...(taskType ? { task_type: taskType } : {}),
      })),
    };

    const response = await this.fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      throw new EmbedderError(
        `Vertex AI embedding error: ${response.status} ${errBody}`,
        response.status
      );
    }

    const data = (await response.json()) as VertexPredictResponse;

    if (data.error) {
      throw new EmbedderError(
        `Vertex AI embedding error: ${data.error.message}`,
        data.error.code
      );
    }

    if (!data.predictions || data.predictions.length !== texts.length) {
      throw new EmbedderError(
        `Expected ${texts.length} predictions, got ${data.predictions?.length ?? 0}`
      );
    }

    return data.predictions.map((p) => {
      const vec = new Float32Array(p.embeddings.values);
      if (vec.length !== EMBEDDING_DIM) {
        throw new EmbedderError(
          `Expected ${EMBEDDING_DIM}-dim embedding, got ${vec.length}`
        );
      }
      return vec;
    });
  }

  // -- Auth methods (duplicated from gemini-provider.ts for independence) --

  private async getAccessToken(): Promise<string> {
    if (this.tokenCache && Date.now() < this.tokenCache.expiresAt - 60_000) {
      return this.tokenCache.token;
    }

    const metadataToken = await this.fetchMetadataToken();
    if (metadataToken) {
      this.tokenCache = metadataToken;
      return metadataToken.token;
    }

    const adcToken = await this.fetchAdcToken();
    if (adcToken) {
      this.tokenCache = adcToken;
      return adcToken.token;
    }

    throw new EmbedderError("No credentials found for Vertex AI embedding");
  }

  private async fetchMetadataToken(): Promise<AccessToken | null> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 200);
      try {
        const response = await this.fetchFn(
          "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
          {
            headers: { "Metadata-Flavor": "Google" },
            signal: controller.signal,
          }
        );
        if (!response.ok) return null;
        const data = (await response.json()) as {
          access_token: string;
          expires_in: number;
        };
        return {
          token: data.access_token,
          expiresAt: Date.now() + data.expires_in * 1000,
        };
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      return null;
    }
  }

  private async fetchAdcToken(): Promise<AccessToken | null> {
    const credPath =
      process.env.GOOGLE_APPLICATION_CREDENTIALS ||
      join(homedir(), ".config", "gcloud", "application_default_credentials.json");

    if (!existsSync(credPath)) return null;

    try {
      const creds = JSON.parse(readFileSync(credPath, "utf-8"));

      if (creds.type === "authorized_user") {
        return this.refreshUserToken(creds);
      }

      if (creds.type === "service_account") {
        return this.fetchServiceAccountToken(creds);
      }

      return null;
    } catch {
      return null;
    }
  }

  private async refreshUserToken(creds: {
    client_id: string;
    client_secret: string;
    refresh_token: string;
  }): Promise<AccessToken | null> {
    try {
      const response = await this.fetchFn("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: creds.client_id,
          client_secret: creds.client_secret,
          refresh_token: creds.refresh_token,
          grant_type: "refresh_token",
        }).toString(),
      });
      if (!response.ok) return null;
      const data = (await response.json()) as {
        access_token: string;
        expires_in: number;
      };
      return {
        token: data.access_token,
        expiresAt: Date.now() + data.expires_in * 1000,
      };
    } catch {
      return null;
    }
  }

  private async fetchServiceAccountToken(creds: {
    client_email: string;
    private_key: string;
  }): Promise<AccessToken | null> {
    try {
      const now = Math.floor(Date.now() / 1000);
      const header = Buffer.from(
        JSON.stringify({ alg: "RS256", typ: "JWT" })
      ).toString("base64url");
      const payload = Buffer.from(
        JSON.stringify({
          iss: creds.client_email,
          scope: "https://www.googleapis.com/auth/cloud-platform",
          aud: "https://oauth2.googleapis.com/token",
          exp: now + 3600,
          iat: now,
        })
      ).toString("base64url");

      const sign = createSign("RSA-SHA256");
      sign.update(`${header}.${payload}`);
      const signature = sign.sign(creds.private_key, "base64url");
      const jwt = `${header}.${payload}.${signature}`;

      const response = await this.fetchFn("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: jwt,
        }).toString(),
      });
      if (!response.ok) return null;
      const data = (await response.json()) as {
        access_token: string;
        expires_in: number;
      };
      return {
        token: data.access_token,
        expiresAt: Date.now() + data.expires_in * 1000,
      };
    } catch {
      return null;
    }
  }
}

// -- Config file support --

const STRATA_CONFIG_FILENAME = "config.json";

/**
 * Load a Gemini API key from env var or ~/.strata/config.json.
 * Priority: GEMINI_API_KEY env var > config.json geminiApiKey field.
 * Returns null if neither source provides a key.
 */
export function loadGeminiApiKeyFromConfig(): string | null {
  // 1. Environment variable (highest priority)
  const envKey = process.env.GEMINI_API_KEY;
  if (envKey) return envKey;

  // 2. ~/.strata/config.json
  try {
    const configPath = join(homedir(), ".strata", STRATA_CONFIG_FILENAME);
    if (existsSync(configPath)) {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      if (typeof raw.geminiApiKey === "string" && raw.geminiApiKey.length > 0) {
        return raw.geminiApiKey;
      }
    }
  } catch {
    // Config file missing, unreadable, or malformed — continue
  }

  return null;
}

// -- Auto-detection & caching --

let cachedEmbedder: GeminiEmbedder | null | undefined;

/**
 * Try to create a GeminiEmbedder using available credentials.
 * Returns null if no credentials are found (within 500ms).
 */
export async function tryCreateGeminiEmbedder(
  fetchFn?: typeof globalThis.fetch
): Promise<GeminiEmbedder | null> {
  const apiKey = loadGeminiApiKeyFromConfig();
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  const region = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";

  // Fast path: API key available (from env var or config.json)
  if (apiKey) {
    return new GeminiEmbedder({ apiKey, fetchFn });
  }

  // Try Vertex AI with project
  if (project) {
    const embedder = new GeminiEmbedder({ project, region, fetchFn });
    try {
      // Probe: try to get an access token
      await (embedder as any).getAccessToken(); // eslint-disable-line @typescript-eslint/no-explicit-any
      return embedder;
    } catch {
      return null;
    }
  }

  // Check ADC credentials file
  const credPath =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    join(homedir(), ".config", "gcloud", "application_default_credentials.json");

  if (existsSync(credPath)) {
    try {
      const creds = JSON.parse(readFileSync(credPath, "utf-8"));
      const detectedProject = creds.project_id || creds.quota_project_id;
      if (detectedProject) {
        const embedder = new GeminiEmbedder({
          project: detectedProject,
          region,
          fetchFn,
        });
        try {
          await (embedder as any).getAccessToken(); // eslint-disable-line @typescript-eslint/no-explicit-any
          return embedder;
        } catch {
          return null;
        }
      }
    } catch {
      // Invalid credentials file
    }
  }

  // Try metadata service directly
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 200);
    const f = fetchFn || globalThis.fetch.bind(globalThis);
    try {
      const response = await f(
        "http://metadata.google.internal/computeMetadata/v1/project/project-id",
        {
          headers: { "Metadata-Flavor": "Google" },
          signal: controller.signal,
        }
      );
      if (response.ok) {
        const detectedProject = await response.text();
        return new GeminiEmbedder({
          project: detectedProject,
          region,
          fetchFn,
        });
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    // Not on GCP
  }

  return null;
}

/**
 * Get a cached GeminiEmbedder instance. Probes once, caches the result.
 */
export async function getCachedGeminiEmbedder(): Promise<GeminiEmbedder | null> {
  if (cachedEmbedder !== undefined) return cachedEmbedder;
  cachedEmbedder = await tryCreateGeminiEmbedder();
  return cachedEmbedder;
}

/** Reset the cached embedder (for testing) */
export function resetGeminiEmbedderCache(): void {
  cachedEmbedder = undefined;
}
