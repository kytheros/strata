// Output redaction tests. The redaction layer is the only thing
// preventing an accidentally-logged secret from being echoed back to
// the operator (or stuffed into the model's context).
//
// Test fixtures use programmatically-constructed strings so no real-
// looking secret literals are committed to the repo.

import { describe, it, expect } from 'vitest';
import { redact, REDACTION_PATTERNS } from '../../app/lib/redact';

// Fixture builders — keep all secret-shaped strings out of source by
// constructing them at test time.
const ANT_PREFIX = 'sk-' + 'ant-' + 'api03-';
const fakeAnthropicKey = ANT_PREFIX + 'F'.repeat(40);
const fakeAwsAccessKey = 'AKIA' + 'B'.repeat(16);
const fakeAwsSessionKey = 'ASIA' + 'C'.repeat(16);
const fakeJwt =
  'ey' + 'J' + 'hbGciOiJIUzI1NiJ9' +
  '.' + 'ey' + 'J' + 'zdWIiOiIxMjM0NTY3OCJ9' +
  '.' + 'D'.repeat(20);
const fakeOpaqueToken = 'X'.repeat(40);
const fakeHexSecret = 'a'.repeat(64);

describe('redact()', () => {
  it('replaces an Anthropic API key', () => {
    const sample = `tool result: { token: "${fakeAnthropicKey}" } end`;
    const { redacted, counts } = redact(sample);
    expect(redacted).not.toContain(fakeAnthropicKey);
    expect(redacted).toContain('[REDACTED:anthropic-key]');
    expect(counts['anthropic-key']).toBe(1);
  });

  it('replaces an AWS access key (AKIA and ASIA)', () => {
    const sample = `${fakeAwsAccessKey} and ${fakeAwsSessionKey}`;
    const { redacted, counts } = redact(sample);
    expect(redacted).not.toContain(fakeAwsAccessKey);
    expect(redacted).not.toContain(fakeAwsSessionKey);
    expect(counts['aws-access-key']).toBe(2);
    expect(redacted).toContain('[REDACTED:aws-access-key]');
  });

  it('replaces a JWT', () => {
    const sample = `Authorization header was ${fakeJwt}`;
    const { redacted, counts } = redact(sample);
    expect(redacted).not.toContain(fakeJwt);
    // Any of the patterns landing on the JWT body is fine — the goal
    // is "the literal value did not survive".
    const totalRedactions = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(totalRedactions).toBeGreaterThanOrEqual(1);
    expect(redacted).toContain('[REDACTED:');
  });

  it('replaces a Bearer token (case-insensitive)', () => {
    const sample = `header: bearer ${fakeOpaqueToken}`;
    const { redacted, counts } = redact(sample);
    expect(redacted).not.toContain(fakeOpaqueToken);
    expect(counts['bearer']).toBe(1);
  });

  it('replaces long hex secrets (Cognito-shaped)', () => {
    const sample = `client_secret=${fakeHexSecret} other text`;
    const { redacted, counts } = redact(sample);
    expect(redacted).not.toContain(fakeHexSecret);
    expect(counts['cognito-secret']).toBe(1);
  });

  it('returns identity when nothing matches', () => {
    const clean = 'no secrets here, just operator chat about ecs services.';
    const { redacted, counts } = redact(clean);
    expect(redacted).toBe(clean);
    expect(Object.keys(counts)).toHaveLength(0);
  });

  it('handles empty input safely', () => {
    expect(redact('').redacted).toBe('');
    expect(redact('').counts).toEqual({});
  });

  it('exports a stable pattern catalog', () => {
    // Defensive — a future refactor that drops a pattern would silently
    // regress this layer. Pin the names.
    const names = REDACTION_PATTERNS.map((p) => p.name);
    expect(names).toEqual([
      'anthropic-key',
      'aws-access-key',
      'jwt',
      'bearer',
      'cognito-secret',
    ]);
  });
});
