// Top-of-page chrome shared between landing & chat surfaces. Server
// component — no client JS needed for the header itself; sign-in/out is a
// link.
//
// The account/region badge gives operators a constant reminder of which
// AWS account they're querying so a sleepy 2am incident doesn't end with a
// command issued against the wrong env.

import Link from 'next/link';
import { config } from '../lib/config';

export type AppHeaderProps = {
  /** Render the right-side sign-out + identity slot. */
  signedIn?: boolean;
  /** The signed-in operator's email (or username) — surfaced next to sign-out. */
  identity?: string | null;
};

export function AppHeader({ signedIn = false, identity }: AppHeaderProps) {
  const accountId = process.env.AWS_ACCOUNT_ID ?? '';
  const region = config.cognito.region;

  return (
    <header className="app-header">
      <Link href="/" className="app-header-brand" aria-label="Strata Example Agent home">
        <span className="brand-mark" aria-hidden="true">
          S
        </span>
        <span>Strata Example Agent</span>
      </Link>
      <div className="app-header-meta">
        <span className="account-badge" title="AWS account & region this agent is querying">
          <span className="account-badge-dot" aria-hidden="true" />
          {accountId ? <code>{accountId}</code> : <code>aws</code>}
          <span aria-hidden="true">·</span>
          <code>{region}</code>
        </span>
        {signedIn && (
          <>
            {identity && (
              <span className="muted" title="Signed-in operator">
                {identity}
              </span>
            )}
            <a href="/api/auth/logout">Sign out</a>
          </>
        )}
      </div>
    </header>
  );
}
