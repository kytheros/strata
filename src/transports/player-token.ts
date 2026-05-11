import { createHmac, timingSafeEqual } from 'crypto';

export interface PlayerTokenClaims {
  v: 2;
  playerId: string;
  worldId: string;
  issuedAt: number;
}

export interface MintInput {
  playerId: string;
  worldId: string;
}

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

function b64urlDecode(s: string): string {
  return Buffer.from(s, 'base64url').toString('utf8');
}

export function mintPlayerToken(input: MintInput, secret: string): string {
  const payload: PlayerTokenClaims = {
    v: 2,
    playerId: input.playerId,
    worldId: input.worldId,
    issuedAt: Date.now(),
  };
  const header = 'strata_v2';
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

/**
 * Verify a player token against the current secret.
 *
 * @param token - The raw bearer token to verify.
 * @param secret - The current signing secret (STRATA_TOKEN_SECRET).
 * @param previousSecret - Optional previous secret (STRATA_TOKEN_SECRET_PREVIOUS).
 *   When supplied, tokens that fail verification against `secret` are retried
 *   against `previousSecret` to support a rolling rotation grace window.
 *   Only `secret` is ever used for signing — `previousSecret` is accept-only.
 */
export function verifyPlayerToken(
  token: string,
  secret: string,
  previousSecret?: string,
): PlayerTokenClaims {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'strata_v2') {
    throw new Error('invalid token format');
  }
  const [header, body, sig] = parts;

  function tryVerify(s: string): boolean {
    const expected = createHmac('sha256', s).update(`${header}.${body}`).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  if (!tryVerify(secret) && !(previousSecret && tryVerify(previousSecret))) {
    throw new Error('invalid token signature');
  }

  const claims = JSON.parse(b64urlDecode(body)) as PlayerTokenClaims;
  if (claims.v !== 2) throw new Error('unsupported token version');
  return claims;
}
