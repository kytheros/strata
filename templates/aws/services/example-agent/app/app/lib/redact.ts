// Output redaction.
//
// The agent runs in an account where logs occasionally contain
// accidentally-emitted secrets (a misconfigured library logging an auth
// header, a stack trace from a dev session). With the read-only AWS role
// the model could surface those values verbatim back to the operator —
// or worse, a prompt-injected log line could trick the model into
// echoing tokens it observed.
//
// We redact at TWO seams:
//   1. Tool results, BEFORE they are stringified into the model's
//      conversation. The model never sees the secret.
//   2. The model's final text, BEFORE it ships to the client. Belt-and-
//      braces: if a token leaked into context from somewhere else (e.g.
//      a recall hit), we still scrub it on the way out.
//
// Patterns are intentionally conservative — false positives are
// preferable to leaking a real secret.

export interface RedactionPattern {
  name: string;
  re: RegExp;
}

export const REDACTION_PATTERNS: RedactionPattern[] = [
  // Anthropic API keys — sk-ant-* (current-gen). Includes api03, admin01,
  // and future tier prefixes since we match by the sk-ant- root.
  { name: 'anthropic-key', re: /sk-ant-[a-zA-Z0-9_-]{20,}/g },
  // AWS access keys (long-lived AKIA*, session ASIA*).
  { name: 'aws-access-key', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  // JWTs — three base64url segments separated by dots. Header/payload
  // start with `eyJ` (base64 of `{"`). Conservative on length to avoid
  // matching short 3-segment things that aren't JWTs.
  { name: 'jwt', re: /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g },
  // Bearer tokens that aren't JWT-shaped (covers opaque API tokens that
  // travel as `Authorization: Bearer ...`). Case-insensitive — some
  // libraries log `bearer` lowercase.
  { name: 'bearer', re: /Bearer\s+[a-zA-Z0-9_.~+/=-]{20,}/gi },
  // Cognito client secrets / similar long hex strings (>=52 chars).
  // Cognito client secrets are typically 64 chars; stretching the
  // window catches legacy 52-char and longer 128-char artifacts.
  { name: 'cognito-secret', re: /\b[a-f0-9]{52,128}\b/g },
];

export interface RedactionResult {
  redacted: string;
  counts: Record<string, number>;
}

export function redact(text: string): RedactionResult {
  if (typeof text !== 'string' || text.length === 0) {
    return { redacted: text ?? '', counts: {} };
  }
  const counts: Record<string, number> = {};
  let redacted = text;
  for (const { name, re } of REDACTION_PATTERNS) {
    // Reset regex state — these are global flag patterns, lastIndex
    // would otherwise leak across calls if any caller reuses the regex.
    re.lastIndex = 0;
    const matches = redacted.match(re);
    if (matches && matches.length > 0) {
      counts[name] = matches.length;
      redacted = redacted.replace(re, `[REDACTED:${name}]`);
    }
  }
  return { redacted, counts };
}

// Helper for callers that just want the scrubbed string. Use the
// structured form above when you need to log/metric the counts.
export function redactString(text: string): string {
  return redact(text).redacted;
}

// Log a single warn line per redaction event. Never logs the matched
// value — only the pattern name and count and a caller-supplied tag
// (tool name, "model-final-text", etc.). The strata-dev log group
// already collects stdout, so no new infra is required.
export function logRedactionCounts(
  source: string,
  counts: Record<string, number>,
): void {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total === 0) return;
  // eslint-disable-next-line no-console
  console.warn(
    `[redact] source=${source} total=${total} ${Object.entries(counts)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')}`,
  );
}
