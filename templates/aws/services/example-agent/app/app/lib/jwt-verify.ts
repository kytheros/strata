// Wraps aws-jwt-verify with a single shared verifier instance.
//
// CognitoJwtVerifier caches JWKS keys internally and rotates them on RSAs
// it hasn't seen before. We intentionally instantiate one verifier at module
// scope so each Lambda/ECS process pays the JWKS-fetch cost once at boot,
// not per request.
//
// Verifier rejects:
//   - tokens whose `iss` doesn't match the constructed issuer
//   - tokens whose `aud`/`client_id` doesn't match config.cognito.clientId
//   - expired tokens (default 0 clock skew tolerance — Cognito clocks are NTP)
//   - tokens whose signing key isn't in the live JWKS

import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { config } from './config';

// Access tokens carry `cognito:groups`; ID tokens carry user attributes.
// We verify access tokens for authorization decisions because they're
// what API clients carry; ID tokens are surfaced to the React client only.
const accessVerifier = CognitoJwtVerifier.create({
  userPoolId: config.cognito.userPoolId,
  tokenUse: 'access',
  clientId: config.cognito.clientId,
});

const idVerifier = CognitoJwtVerifier.create({
  userPoolId: config.cognito.userPoolId,
  tokenUse: 'id',
  clientId: config.cognito.clientId,
});

export interface VerifiedAccessClaims {
  sub: string;
  username: string;
  email?: string;
  groups: string[];
  scope: string;
  // The full payload, for callers that want to read non-standard claims.
  raw: Record<string, unknown>;
}

export async function verifyAccessToken(token: string): Promise<VerifiedAccessClaims> {
  const payload = await accessVerifier.verify(token);
  const groupsRaw = (payload as Record<string, unknown>)['cognito:groups'];
  const groups = Array.isArray(groupsRaw) ? (groupsRaw as string[]) : [];
  return {
    sub: payload.sub,
    username: (payload as Record<string, unknown>)['username'] as string,
    email: (payload as Record<string, unknown>)['email'] as string | undefined,
    groups,
    scope: (payload as Record<string, unknown>)['scope'] as string,
    raw: payload as Record<string, unknown>,
  };
}

export interface VerifiedIdClaims {
  sub: string;
  email?: string;
  emailVerified?: boolean;
  raw: Record<string, unknown>;
}

export async function verifyIdToken(token: string): Promise<VerifiedIdClaims> {
  const payload = await idVerifier.verify(token);
  return {
    sub: payload.sub,
    email: (payload as Record<string, unknown>)['email'] as string | undefined,
    emailVerified: (payload as Record<string, unknown>)['email_verified'] as
      | boolean
      | undefined,
    raw: payload as Record<string, unknown>,
  };
}

export function hasRequiredGroup(claims: VerifiedAccessClaims): boolean {
  return claims.groups.includes(config.cognito.requiredGroup);
}
