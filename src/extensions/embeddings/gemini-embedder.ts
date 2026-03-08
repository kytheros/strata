/** Type stub for community edition — actual implementation is in strata-pro. */
export interface GeminiEmbedder {
  embed(text: string): Promise<Float32Array>;
  dimensions: number;
}
