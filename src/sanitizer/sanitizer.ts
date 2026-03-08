/**
 * Context sanitizer that strips secrets, API keys, and credentials
 * from conversation text before indexing.
 */

interface SanitizationPattern {
  /** Human-readable type name used in [REDACTED:<type>] */
  readonly type: string;
  /** Regex pattern to match the secret */
  readonly pattern: RegExp;
  /** Custom replacer function (optional) */
  readonly replacer?: (match: string, type: string) => string;
}

/**
 * Pre-compiled patterns for detecting secrets and credentials.
 * Order matters: more specific patterns should come before generic ones
 * to avoid partial matches.
 */
const PATTERNS: readonly SanitizationPattern[] = [
  // PEM private keys (multiline block — real newlines, bounded to avoid runaway matching)
  {
    type: "private-key",
    pattern: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=\r\n]+-----END[A-Z ]*PRIVATE KEY-----/g,
  },

  // PEM private keys (escaped newlines — e.g., from .env files or JSON)
  {
    type: "private-key",
    pattern: /-----BEGIN[A-Z ]*PRIVATE KEY-----(?:\\n[A-Za-z0-9+/=]+)+\\n-----END[A-Z ]*PRIVATE KEY-----/g,
  },

  // PEM private key header followed by base64 content (catches partial/inline keys)
  {
    type: "private-key",
    pattern: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\\n][A-Za-z0-9+/=\s\\n]{50,}/g,
  },

  // AWS access key IDs
  {
    type: "aws-key",
    pattern: /AKIA[0-9A-Z]{16}/g,
  },

  // AWS secret access keys (40-char base64 after context keyword)
  {
    type: "aws-secret",
    pattern:
      /((?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY|aws_secret_key|secret_access_key|SecretAccessKey)\s*[:=]\s*['"]?)[A-Za-z0-9/+=]{40}/g,
    replacer: (match, type) => {
      const m = match.match(
        /((?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY|aws_secret_key|secret_access_key|SecretAccessKey)\s*[:=]\s*['"]?)/
      );
      return m ? `${m[1]}[REDACTED:${type}]` : `[REDACTED:${type}]`;
    },
  },

  // GitHub tokens (various prefixes)
  {
    type: "github-token",
    pattern: /(?:ghp_|gho_|ghs_|ghu_)[A-Za-z0-9_]{36,}/g,
  },

  // GitHub PAT (fine-grained)
  {
    type: "github-token",
    pattern: /github_pat_[A-Za-z0-9_]{22,}/g,
  },

  // Anthropic API keys
  {
    type: "anthropic-key",
    pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g,
  },

  // OpenAI API keys (sk- followed by 40+ chars, but NOT sk-ant-)
  {
    type: "openai-key",
    pattern: /sk-(?!ant-)[A-Za-z0-9_-]{40,}/g,
  },

  // Bearer tokens (must come before generic auth-header)
  {
    type: "bearer-token",
    pattern: /Bearer\s+[A-Za-z0-9_\-.~+/]+=*/g,
  },

  // Authorization headers (non-Bearer)
  {
    type: "auth-header",
    pattern: /(Authorization:\s*)\S+(?:\s+\S+)*/g,
    replacer: (match, type) => {
      // Don't double-redact Bearer tokens already handled
      if (match.includes("[REDACTED:bearer-token]")) return match;
      const m = match.match(/(Authorization:\s*)/);
      return m ? `${m[1]}[REDACTED:${type}]` : `[REDACTED:${type}]`;
    },
  },

  // Password in URLs (://user:pass@host)
  {
    type: "password-url",
    pattern: /:\/\/([^:@\s]+):([^@\s]+)@/g,
    replacer: (_match, type) => `://[REDACTED:${type}]@`,
  },
] as const;

/**
 * Patterns that look like secrets but are actually benign.
 * These are checked to prevent false positives.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{3,8}$/;
const DATA_URL_PATTERN = /^data:[^;]+;base64,/;

export class Sanitizer {
  /**
   * Sanitize text by replacing detected secrets with [REDACTED:<type>] placeholders.
   *
   * @param text - The text to sanitize
   * @returns The sanitized text with secrets replaced
   */
  sanitize(text: string): string {
    if (!text) return text;

    // Guard against ReDoS on very large inputs
    let result = text.length > 1_000_000 ? text.slice(0, 1_000_000) : text;

    for (const { type, pattern, replacer } of PATTERNS) {
      // Reset lastIndex for global regexes
      pattern.lastIndex = 0;

      if (replacer) {
        result = result.replace(pattern, (match) => replacer(match, type));
      } else {
        result = result.replace(pattern, `[REDACTED:${type}]`);
      }
    }

    return result;
  }

  /**
   * Check if a string looks like a false positive (UUID, hex color, data URL).
   * Exposed for testing purposes.
   */
  static isFalsePositive(value: string): boolean {
    return (
      UUID_PATTERN.test(value) ||
      HEX_COLOR_PATTERN.test(value) ||
      DATA_URL_PATTERN.test(value.trim())
    );
  }
}
