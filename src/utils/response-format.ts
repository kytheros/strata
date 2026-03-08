/**
 * Response format levels controlling verbosity and token usage.
 */

export enum ResponseFormat {
  /** TOON format — 30-60% token reduction */
  CONCISE = "concise",

  /** Structured text — moderate detail (default) */
  STANDARD = "standard",

  /** Full JSON — all fields */
  DETAILED = "detailed",
}

/**
 * Detect format from tool parameters.
 * Enterprise hooks can inject format via transformResponse.
 */
export function selectFormat(params: unknown): ResponseFormat {
  const p = params as { format?: string };
  if (p.format && Object.values(ResponseFormat).includes(p.format as ResponseFormat)) {
    return p.format as ResponseFormat;
  }
  return ResponseFormat.STANDARD;
}
