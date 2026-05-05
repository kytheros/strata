// Authenticated chat surface. Real UI + tool catalog land in AWS-3.3.
//
// This server component performs deep verification of the access token
// (signature + group membership) before rendering. It deliberately
// duplicates the work middleware.ts skipped — middleware is the cheap
// front-line gate; this is the authoritative gate that consults JWKS.

import { redirect } from 'next/navigation';
import { authenticateRequest } from '../lib/auth-middleware';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function ChatPage() {
  const result = await authenticateRequest();

  if (!result.ok) {
    if (result.status === 401) {
      // Stale or missing token — bounce to landing for a fresh login.
      redirect('/?reason=unauthenticated');
    }
    if (result.status === 403) {
      // Authenticated but not approved — show the friendly notice.
      redirect('/?error=not_approved');
    }
  }

  // Type narrowing — TypeScript doesn't see redirect() as never.
  if (!result.ok) {
    return null;
  }

  const { claims } = result;

  return (
    <main>
      <h1>Chat</h1>
      <p>
        Welcome <code>{claims.email ?? claims.username}</code>. The chat
        surface comes online in <strong>AWS-3.3</strong>, when the SDK
        tool catalog and the Anthropic loop wire up.
      </p>

      <div className="notice">
        Auth round-trip verified. Groups: <code>{claims.groups.join(', ')}</code>.
      </div>

      <p>
        <a href="/api/auth/logout" className="btn">
          Sign out
        </a>
      </p>
    </main>
  );
}
