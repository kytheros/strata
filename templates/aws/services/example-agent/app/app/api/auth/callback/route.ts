// OAuth callback — Cognito redirects here after the user authenticates
// via Hosted UI (which itself may have federated to Google/GitHub).
//
// Steps:
//   1. Validate the state nonce against the cookie set by /api/auth/login
//      (CSRF protection — prevents an attacker from forging a callback).
//   2. Exchange the authorization code for tokens via the Hosted UI
//      /oauth2/token endpoint (confidential client — uses Basic auth).
//   3. Verify the access token's signature + audience + group membership.
//   4. Drop the access token into an HttpOnly Secure SameSite=Lax cookie
//      and 302 the browser to /chat.
//
// SameSite=Lax: required because the callback redirect arrives via a
// cross-site GET (Cognito Hosted UI → this app). Strict cookies wouldn't
// be sent. HttpOnly: prevents JS access. Secure: cookie only sent over
// HTTPS — fine because the app sits behind ALB/API GW with TLS.

import { NextResponse, type NextRequest } from 'next/server';
import { exchangeCodeForTokens } from '../../../lib/cognito-client';
import { config } from '../../../lib/config';
import { hasRequiredGroup, verifyAccessToken } from '../../../lib/jwt-verify';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  // Cognito surfaces federation errors here (e.g. user clicked Cancel,
  // or the federated IdP rejected the user). Redirect with a friendly
  // message instead of leaking the raw provider error.
  if (error) {
    return NextResponse.redirect(`${config.app.appUrl}/?error=oauth_failed`);
  }

  const stateCookie = request.cookies.get(config.app.stateCookieName);
  if (!code || !state || !stateCookie || stateCookie.value !== state) {
    return NextResponse.redirect(`${config.app.appUrl}/?error=oauth_failed`);
  }

  let tokens;
  try {
    tokens = await exchangeCodeForTokens(
      code,
      `${config.app.appUrl}/api/auth/callback`,
    );
  } catch {
    return NextResponse.redirect(`${config.app.appUrl}/?error=oauth_failed`);
  }

  // Deep-verify the access token before trusting it.
  let claims;
  try {
    claims = await verifyAccessToken(tokens.access_token);
  } catch {
    return NextResponse.redirect(`${config.app.appUrl}/?error=oauth_failed`);
  }

  // Group gate — federated email passed Pre-signup allowlist (per
  // AWS-3.2 Lambda) and was placed in `approved` by the
  // PostConfirmation Lambda. Until those Lambdas wire up (AWS-3.2),
  // dev users won't have the group and will land back at the home page
  // with a "pending approval" notice.
  if (!hasRequiredGroup(claims)) {
    const response = NextResponse.redirect(
      `${config.app.appUrl}/?error=not_approved`,
    );
    response.cookies.delete(config.app.stateCookieName);
    return response;
  }

  // Mint the session. Cookie lifetime matches the access token's
  // expires_in so re-login happens before the verifier rejects expired
  // tokens. Refresh-token flow lands in a follow-up ticket.
  const response = NextResponse.redirect(`${config.app.appUrl}/chat`);
  response.cookies.set(config.app.sessionCookieName, tokens.access_token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: tokens.expires_in,
  });
  response.cookies.delete(config.app.stateCookieName);
  return response;
}
