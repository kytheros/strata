/**
 * Shared utility for eval scorers: strips markdown code fences from raw LLM
 * responses before JSON.parse().
 *
 * Production providers pass jsonMode: true which suppresses preamble prose and
 * fences, but eval scorers historically omitted that flag. This helper bridges
 * the gap so that a leading ```json ... ``` or ``` ... ``` wrapper does not
 * cause a JSON.parse() throw and record a false fail.
 */

/**
 * Strip a leading/trailing markdown code fence (```json or ```) from a raw
 * LLM response before JSON.parse().
 *
 * Returns the trimmed inner content if a fence is detected, or the trimmed
 * original string if not. Never throws.
 */
export function stripJsonFence(raw: string): string {
  const trimmed = raw.trim();
  // Handles both ```json\n{...}\n```  and  ```\n{...}\n```
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenceMatch) return fenceMatch[1].trim();
  return trimmed;
}

/**
 * Parse JSON from a raw LLM response, stripping fences first.
 *
 * On parse failure, logs the first 200 chars of the raw response so future
 * drift is debuggable, then re-throws the SyntaxError so callers can record
 * the failure.
 */
export function parseJsonResponse(raw: string): unknown {
  try {
    return JSON.parse(stripJsonFence(raw));
  } catch (err) {
    const preview = raw.slice(0, 200).replace(/\n/g, "\\n");
    console.error(`[eval] JSON.parse failed. raw[:200] = "${preview}"`);
    throw err;
  }
}
