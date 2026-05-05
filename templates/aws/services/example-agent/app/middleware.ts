// Edge middleware: redirects unauthenticated browsers visiting /chat to
// the Cognito Hosted UI authorize endpoint.
//
// IMPORTANT: middleware runs on the Edge runtime, which does NOT include
// the Node `crypto` module, the AWS SDK, or aws-jwt-verify's network
// fetcher. We intentionally do NOT verify the JWT here — only check that
// a session cookie is present. Deep verification (signature + group
// membership) happens in API routes via app/lib/auth-middleware.ts and in
// the page-level server component for /chat.
//
// Reason: redirecting an unauthenticated user is the common path; doing
// JWKS network fetches in middleware adds latency to every page load.

import { NextResponse, type NextRequest } from 'next/server';

const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME ?? 'eag_session';

export function middleware(request: NextRequest) {
  // Only gate /chat (and any future authenticated routes added below).
  // /, /login, /api/auth/* are intentionally public.
  const sessionCookie = request.cookies.get(SESSION_COOKIE);
  if (sessionCookie?.value) {
    return NextResponse.next();
  }

  // No session — bounce to the landing page, which will render the
  // "Sign in" button. We don't redirect directly to Cognito here so the
  // user has a chance to read the access-policy notice before federating.
  const url = request.nextUrl.clone();
  url.pathname = '/';
  url.searchParams.set('reason', 'unauthenticated');
  return NextResponse.redirect(url);
}

export const config = {
  // Only match the chat surface. /api/* routes do their own deeper check.
  matcher: ['/chat/:path*'],
};
