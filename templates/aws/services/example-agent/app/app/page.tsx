// Public landing page. If the user is signed in, surface a link to /chat;
// otherwise render the "Sign in with Cognito" button. The button hits
// /api/auth/login which builds the OAuth state nonce + sets the state
// cookie + 302s to the Hosted UI.
//
// Server component — reads the session cookie at request time.

import { cookies } from 'next/headers';
import Link from 'next/link';
import { config } from './lib/config';

export const dynamic = 'force-dynamic';

export default function Page({
  searchParams,
}: {
  searchParams: { reason?: string; error?: string };
}) {
  const sessionCookie = cookies().get(config.app.sessionCookieName);
  const signedIn = Boolean(sessionCookie?.value);

  return (
    <main>
      <h1>Strata Example Agent</h1>
      <p>
        AWS-introspection chat surface for the Strata-on-AWS deploy.
        Federated sign-in via Cognito; access is restricted to allowlisted
        emails.
      </p>

      {searchParams.reason === 'unauthenticated' && (
        <div className="notice">
          You need to sign in to use the chat surface.
        </div>
      )}
      {searchParams.error === 'oauth_failed' && (
        <div className="notice">
          Sign-in failed. If you keep seeing this, your email may not be
          on the access allowlist. Contact the operator.
        </div>
      )}
      {searchParams.error === 'not_approved' && (
        <div className="notice">
          Your account is pending approval. The operator will be notified
          shortly.
        </div>
      )}

      {signedIn ? (
        <p>
          <Link href="/chat" className="btn">
            Open chat
          </Link>
        </p>
      ) : (
        <p>
          <a href="/api/auth/login" className="btn">
            Sign in
          </a>
        </p>
      )}

      <p style={{ marginTop: '3rem', fontSize: '0.875rem', color: '#9ca3af' }}>
        Backed by <code>strata-on-aws</code>. Tool catalog: AWS SDK
        read-only (wired in AWS-3.3).
      </p>
    </main>
  );
}
