// Sign out: clear the session cookie locally, then bounce through the
// Cognito Hosted UI /logout endpoint so the federated session is also
// cleared (otherwise the next /api/auth/login would silently re-sign-in
// the same user without prompting for credentials).

import { NextResponse } from 'next/server';
import { buildLogoutUrl } from '../../../lib/cognito-client';
import { config } from '../../../lib/config';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const logoutUrl = buildLogoutUrl(config.app.appUrl);
  const response = NextResponse.redirect(logoutUrl);
  response.cookies.delete(config.app.sessionCookieName);
  response.cookies.delete(config.app.stateCookieName);
  return response;
}
