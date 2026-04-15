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

export function verifyPlayerToken(token: string, secret: string): PlayerTokenClaims {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'strata_v2') {
    throw new Error('invalid token format');
  }
  const [header, body, sig] = parts;
  const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('invalid token signature');
  }
  const claims = JSON.parse(b64urlDecode(body)) as PlayerTokenClaims;
  if (claims.v !== 2) throw new Error('unsupported token version');
  return claims;
}
