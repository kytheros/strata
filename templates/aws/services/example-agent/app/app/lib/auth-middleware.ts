// Server-side helpers used by API routes to assert the caller is a fully
// verified, group-gated user. The Edge middleware (middleware.ts) handles
// the *page* gate; this module is the API-route gate.
//
// Why both: middleware.ts can redirect unauthenticated browsers to the
// Hosted UI, but it intentionally cannot import the heavy aws-jwt-verify
// JWKS-fetching machinery (Edge runtime). API routes run on the Node
// runtime and can verify deeply.

import { cookies } from 'next/headers';
import { config } from './config';
import {
  hasRequiredGroup,
  verifyAccessToken,
  type VerifiedAccessClaims,
} from './jwt-verify';

export type AuthResult =
  | { ok: true; claims: VerifiedAccessClaims }
  | { ok: false; status: 401 | 403; reason: string };

// Read the session cookie and verify the JWT. Returns 401 if missing /
// invalid; 403 if the user is authenticated but not in the `approved`
// group (allowlist not yet enforced).
export async function authenticateRequest(): Promise<AuthResult> {
  const store = cookies();
  const sessionCookie = store.get(config.app.sessionCookieName);
  if (!sessionCookie) {
    return { ok: false, status: 401, reason: 'No session cookie' };
  }

  let claims: VerifiedAccessClaims;
  try {
    claims = await verifyAccessToken(sessionCookie.value);
  } catch (err) {
    // aws-jwt-verify throws JwtInvalidClaimError / JwtExpiredError / etc.
    // We collapse them all to 401 — the user just needs to re-auth. Don't
    // leak internal error shape to the client.
    return {
      ok: false,
      status: 401,
      reason: `Invalid or expired token: ${(err as Error).message}`,
    };
  }

  if (!hasRequiredGroup(claims)) {
    return {
      ok: false,
      status: 403,
      reason: `User is not in the '${config.cognito.requiredGroup}' group. Your account is pending approval.`,
    };
  }

  return { ok: true, claims };
}
