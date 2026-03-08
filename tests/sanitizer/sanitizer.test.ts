import { describe, it, expect } from "vitest";
import { Sanitizer } from "../../src/sanitizer/sanitizer.js";

describe("Sanitizer", () => {
  const sanitizer = new Sanitizer();

  describe("AWS access keys", () => {
    it("should redact AWS access key IDs", () => {
      const input = "export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE";
      const result = sanitizer.sanitize(input);
      expect(result).toBe("export AWS_ACCESS_KEY_ID=[REDACTED:aws-key]");
      expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE");
    });

    it("should redact AWS access keys embedded in config", () => {
      const input = `aws_access_key_id = AKIAI44QH8DHBEXAMPLE\nregion = us-east-1`;
      const result = sanitizer.sanitize(input);
      expect(result).toContain("[REDACTED:aws-key]");
      expect(result).toContain("region = us-east-1");
    });
  });

  describe("AWS secret keys", () => {
    it("should redact AWS secret access keys after context keyword", () => {
      const input =
        "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
      const result = sanitizer.sanitize(input);
      expect(result).toContain("[REDACTED:aws-secret]");
      expect(result).not.toContain("wJalrXUtnFEMI");
    });

    it("should redact AWS secret keys with quoted assignment", () => {
      const input =
        'AWS_SECRET_ACCESS_KEY="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"';
      const result = sanitizer.sanitize(input);
      expect(result).toContain("[REDACTED:aws-secret]");
      expect(result).not.toContain("wJalrXUtnFEMI");
    });
  });

  describe("GitHub tokens", () => {
    it("should redact ghp_ tokens", () => {
      const input = "GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn";
      const result = sanitizer.sanitize(input);
      expect(result).toContain("[REDACTED:github-token]");
      expect(result).not.toContain("ghp_ABCDEF");
    });

    it("should redact gho_ tokens", () => {
      const input = "token: gho_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn";
      const result = sanitizer.sanitize(input);
      expect(result).toContain("[REDACTED:github-token]");
    });

    it("should redact ghs_ tokens", () => {
      const input = "ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn";
      const result = sanitizer.sanitize(input);
      expect(result).toBe("[REDACTED:github-token]");
    });

    it("should redact ghu_ tokens", () => {
      const input = "ghu_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn";
      const result = sanitizer.sanitize(input);
      expect(result).toBe("[REDACTED:github-token]");
    });

    it("should redact github_pat_ tokens", () => {
      const input = "github_pat_11ABCDEF0123456789abcdefghijklmnop";
      const result = sanitizer.sanitize(input);
      expect(result).toBe("[REDACTED:github-token]");
    });
  });

  describe("Anthropic API keys", () => {
    it("should redact Anthropic API keys", () => {
      const input = "export ANTHROPIC_API_KEY=sk-ant-api03-abc123def456ghi789jkl012mno345pqr678stu901vwx";
      const result = sanitizer.sanitize(input);
      expect(result).toContain("[REDACTED:anthropic-key]");
      expect(result).not.toContain("sk-ant-api03");
    });
  });

  describe("OpenAI API keys", () => {
    it("should redact OpenAI API keys", () => {
      const input =
        "OPENAI_API_KEY=sk-proj-abc123def456ghi789jkl012mno345pqr678stu901";
      const result = sanitizer.sanitize(input);
      expect(result).toContain("[REDACTED:openai-key]");
      expect(result).not.toContain("sk-proj-abc123");
    });

    it("should not confuse OpenAI keys with Anthropic keys", () => {
      const input = "sk-ant-abc123def456ghi789jkl012mno345pqr678stu901vwx";
      const result = sanitizer.sanitize(input);
      expect(result).toContain("[REDACTED:anthropic-key]");
      expect(result).not.toContain("[REDACTED:openai-key]");
    });
  });

  describe("Bearer tokens", () => {
    it("should redact Bearer tokens", () => {
      const input = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
      const result = sanitizer.sanitize(input);
      expect(result).toContain("[REDACTED:bearer-token]");
      expect(result).not.toContain("eyJhbGciOiJIUzI1NiI");
    });
  });

  describe("Authorization headers", () => {
    it("should redact Authorization header values", () => {
      const input = "Authorization: Basic dXNlcjpwYXNzd29yZA==";
      const result = sanitizer.sanitize(input);
      expect(result).toContain("[REDACTED:auth-header]");
      expect(result).not.toContain("dXNlcjpwYXNzd29yZA==");
    });
  });

  describe("Password URLs", () => {
    it("should redact passwords in URLs", () => {
      const input = "postgres://admin:supersecret@localhost:5432/mydb";
      const result = sanitizer.sanitize(input);
      expect(result).toContain("[REDACTED:password-url]");
      expect(result).not.toContain("supersecret");
      expect(result).toContain("localhost:5432/mydb");
    });

    it("should redact passwords in https URLs", () => {
      const input = "https://user:p4ssw0rd@example.com/api";
      const result = sanitizer.sanitize(input);
      expect(result).toContain("[REDACTED:password-url]");
      expect(result).not.toContain("p4ssw0rd");
    });
  });

  describe("PEM private keys", () => {
    it("should redact PEM private key blocks", () => {
      const input = `Some text
-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWkF
base64encodedkeydata+here/example==
-----END RSA PRIVATE KEY-----
More text`;
      const result = sanitizer.sanitize(input);
      expect(result).toContain("[REDACTED:private-key]");
      expect(result).not.toContain("MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn");
      expect(result).toContain("Some text");
      expect(result).toContain("More text");
    });

    it("should redact EC private keys", () => {
      const input = `-----BEGIN EC PRIVATE KEY-----
MHQCAQEEIODsamplekeydata
-----END EC PRIVATE KEY-----`;
      const result = sanitizer.sanitize(input);
      expect(result).toBe("[REDACTED:private-key]");
    });
  });

  describe("false positives - should NOT redact", () => {
    it("should preserve UUIDs", () => {
      const input = 'const id = "550e8400-e29b-41d4-a716-446655440000"';
      const result = sanitizer.sanitize(input);
      expect(result).toBe(input);
    });

    it("should preserve hex color codes", () => {
      const input = "color: #ff5733; background: #ABC123";
      const result = sanitizer.sanitize(input);
      expect(result).toBe(input);
    });

    it("should preserve base64 in data URLs", () => {
      const input =
        "background: url(data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEA)";
      const result = sanitizer.sanitize(input);
      expect(result).toBe(input);
    });

    it("should preserve short sk- strings that are not API keys", () => {
      const input = "sk-short";
      const result = sanitizer.sanitize(input);
      expect(result).toBe(input);
    });

    it("should preserve URLs without credentials", () => {
      const input = "https://example.com/api/v1/users";
      const result = sanitizer.sanitize(input);
      expect(result).toBe(input);
    });

    it("should preserve normal code with hex-like strings", () => {
      const input = 'const hash = "a1b2c3d4e5f6"';
      const result = sanitizer.sanitize(input);
      expect(result).toBe(input);
    });
  });

  describe("multiple secrets in one text", () => {
    it("should redact multiple different secret types", () => {
      const input = `
export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
export GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn
export ANTHROPIC_API_KEY=sk-ant-api03-abc123def456ghi789jkl012mno345pqr678stu901vwx
`;
      const result = sanitizer.sanitize(input);
      expect(result).toContain("[REDACTED:aws-key]");
      expect(result).toContain("[REDACTED:github-token]");
      expect(result).toContain("[REDACTED:anthropic-key]");
    });
  });

  describe("edge cases", () => {
    it("should handle empty string", () => {
      expect(sanitizer.sanitize("")).toBe("");
    });

    it("should handle text with no secrets", () => {
      const input = "Just a normal conversation about coding.";
      expect(sanitizer.sanitize(input)).toBe(input);
    });

    it("should handle null-ish input gracefully", () => {
      expect(sanitizer.sanitize("")).toBe("");
    });
  });

  describe("isFalsePositive static method", () => {
    it("should detect UUIDs as false positives", () => {
      expect(
        Sanitizer.isFalsePositive("550e8400-e29b-41d4-a716-446655440000")
      ).toBe(true);
    });

    it("should detect hex colors as false positives", () => {
      expect(Sanitizer.isFalsePositive("#ff5733")).toBe(true);
    });

    it("should detect data URLs as false positives", () => {
      expect(
        Sanitizer.isFalsePositive("data:image/png;base64,iVBORw0K")
      ).toBe(true);
    });

    it("should not flag normal strings as false positives", () => {
      expect(Sanitizer.isFalsePositive("AKIAIOSFODNN7EXAMPLE")).toBe(false);
    });
  });

  describe("performance", () => {
    it("should sanitize 1MB of text in under 50ms", () => {
      // Generate 1MB of text with some embedded secrets
      const normalLine =
        "This is a normal line of conversation about coding and software development. ";
      const secretLines = [
        "export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
        "GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn",
        "sk-ant-api03-abc123def456ghi789jkl012mno345pqr678stu901vwx",
        "postgres://admin:supersecret@localhost:5432/mydb",
        "Authorization: Basic dXNlcjpwYXNzd29yZA==",
      ];

      // Fill up to ~1MB
      const targetSize = 1024 * 1024;
      const lines: string[] = [];
      let currentSize = 0;
      let secretIndex = 0;
      for (let i = 0; currentSize < targetSize; i++) {
        if (i > 0 && i % 100 === 0) {
          const secret = secretLines[secretIndex % secretLines.length];
          lines.push(secret);
          currentSize += secret.length + 1;
          secretIndex++;
        } else {
          lines.push(normalLine);
          currentSize += normalLine.length + 1;
        }
      }

      const largeText = lines.join("\n");
      expect(largeText.length).toBeGreaterThanOrEqual(targetSize);

      // Warm up
      sanitizer.sanitize(largeText);

      // Benchmark
      const start = performance.now();
      const result = sanitizer.sanitize(largeText);
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(50);
      expect(result).toContain("[REDACTED:aws-key]");
      expect(result).toContain("[REDACTED:github-token]");
      expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE");
    });
  });
});
