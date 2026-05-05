// Authenticated chat surface (AWS-3.3).
//
// Two parts:
//   - Server component: reverifies the JWT (deep check via aws-jwt-verify
//     against JWKS), rejects unauthenticated/unapproved users.
//   - Client island: renders the chat UI and posts to /api/chat.
//
// Non-streaming on purpose. The AWS-3.3 exit criteria is "sub-second on a
// warm cache" which is a single-response interaction; streaming
// complexity isn't justified yet.

import { redirect } from 'next/navigation';
import { authenticateRequest } from '../lib/auth-middleware';
import ChatClient from './ChatClient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function ChatPage() {
  const result = await authenticateRequest();
  if (!result.ok) {
    if (result.status === 401) redirect('/?reason=unauthenticated');
    if (result.status === 403) redirect('/?error=not_approved');
    return null;
  }

  return (
    <main>
      <header className="chat-header">
        <h1>AWS Introspection</h1>
        <p>
          Signed in as <code>{result.claims.email ?? result.claims.username}</code>.{' '}
          <a href="/api/auth/logout">Sign out</a>
        </p>
      </header>
      <ChatClient />
    </main>
  );
}
