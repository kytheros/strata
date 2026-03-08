// Type declarations for optional dependencies that are dynamically imported
declare module "@huggingface/transformers" {
  export function pipeline(task: string, model: string, options?: Record<string, unknown>): Promise<unknown>;
  export const env: { cacheDir: string };
}
