// Initiates the OAuth code flow: generates a state nonce, stores it in
// an HttpOnly cookie, then 302s the user to the Cognito Hosted UI
// authorize endpoint.
//
// SameSite=Lax is required (Strict breaks the OAuth redirect path —
// Strict cookies don't get sent on cross-site GET navigations, so the
// callback can't read the state cookie).

import { NextResponse } from 'next/server';
import { buildAuthorizeUrl, newOauthState } from '../../../lib/cognito-client';
import { config } from '../../../lib/config';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const state = newOauthState();
  const redirectUri = `${config.app.appUrl}/api/auth/callback`;
  const authorizeUrl = buildAuthorizeUrl(state, redirectUri);

  const response = NextResponse.redirect(authorizeUrl);
  response.cookies.set(config.app.stateCookieName, state, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 600, // 10 minutes — covers a slow federation round-trip
  });
  return response;
}
