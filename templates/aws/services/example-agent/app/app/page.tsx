// Public landing page. If the user is signed in, surface a link to /chat;
// otherwise render the "Sign in with Cognito" button. The button hits
// /api/auth/login which builds the OAuth state nonce + sets the state
// cookie + 302s to the Hosted UI.
//
// Server component — reads the session cookie at request time.

import { cookies } from 'next/headers';
import Link from 'next/link';
import { config } from './lib/config';
import { AppHeader } from './components/AppHeader';

export const dynamic = 'force-dynamic';

const NOTICES = {
  unauthenticated: {
    tone: 'warn' as const,
    body: 'You need to sign in to use the chat surface.',
  },
  oauth_failed: {
    tone: 'error' as const,
    body: 'Sign-in failed. If you keep seeing this, your email may not be on the access allowlist. Contact the operator.',
  },
  not_approved: {
    tone: 'warn' as const,
    body: 'Your account is pending approval. The operator will be notified shortly.',
  },
};

export default function Page({
  searchParams,
}: {
  searchParams: { reason?: string; error?: string };
}) {
  const sessionCookie = cookies().get(config.app.sessionCookieName);
  const signedIn = Boolean(sessionCookie?.value);
  const noticeKey =
    searchParams.reason === 'unauthenticated'
      ? 'unauthenticated'
      : searchParams.error === 'oauth_failed'
        ? 'oauth_failed'
        : searchParams.error === 'not_approved'
          ? 'not_approved'
          : null;
  const notice = noticeKey ? NOTICES[noticeKey] : null;

  return (
    <>
      <AppHeader signedIn={signedIn} />
      <main>
        <section className="hero">
          <span className="hero-eyebrow">
            <span aria-hidden="true">●</span> AWS Introspection
          </span>
          <h1>Strata Example Agent</h1>
          <p className="hero-lede">
            An authenticated chat surface for the Strata-on-AWS deploy. Ask
            Claude about cost, alarms, ECS, VPC, or logs &mdash; it answers by
            calling read-only AWS APIs in this account.
          </p>

          {notice && (
            <div
              className={`notice${notice.tone === 'error' ? ' notice--error' : ''}`}
              role={notice.tone === 'error' ? 'alert' : 'status'}
            >
              <svg
                className="notice-icon"
                viewBox="0 0 20 20"
                fill="currentColor"
                aria-hidden="true"
              >
                <path
                  fillRule="evenodd"
                  d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm.75-11.25a.75.75 0 0 0-1.5 0v4.5a.75.75 0 0 0 1.5 0v-4.5ZM10 15a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
                  clipRule="evenodd"
                />
              </svg>
              <span>{notice.body}</span>
            </div>
          )}

          <div className="hero-cta-row">
            {signedIn ? (
              <>
                <Link href="/chat" className="btn btn--primary">
                  Continue to chat
                  <span className="btn-arrow" aria-hidden="true">
                    →
                  </span>
                </Link>
                <a href="/api/auth/logout" className="btn btn--ghost">
                  Sign out
                </a>
              </>
            ) : (
              <a href="/api/auth/login" className="btn btn--primary">
                Sign in with Google
                <span className="btn-arrow" aria-hidden="true">
                  →
                </span>
              </a>
            )}
          </div>

          <dl className="hero-meta">
            <div>
              <dt>Auth</dt>
              <dd>Cognito · allowlist-gated</dd>
            </div>
            <div>
              <dt>Model</dt>
              <dd>Claude Sonnet 4.6</dd>
            </div>
            <div>
              <dt>Tools</dt>
              <dd>10 AWS read-only</dd>
            </div>
            <div>
              <dt>Backend</dt>
              <dd>strata-on-aws</dd>
            </div>
          </dl>
        </section>
      </main>
    </>
  );
}
