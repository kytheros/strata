// Chat backend.
//
// AWS-3.2 wires the Strata memory client onto this route: every authenticated
// user turn is stored as an episodic memory before we return. The chat
// response itself is still a stub — AWS-3.3 replaces the body with the SDK
// tool catalog + Anthropic SDK tool-use loop.
//
// The auth gate is real: every request is verified end-to-end, including
// group membership. This is the contract AWS-3.3 inherits.

import { NextResponse, type NextRequest } from 'next/server';
import { authenticateRequest } from '../../lib/auth-middleware';
import { StrataClient } from '../../lib/strata-client';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface ChatRequestBody {
  message?: unknown;
}

export async function POST(request: NextRequest) {
  const auth = await authenticateRequest();
  if (!auth.ok) {
    return NextResponse.json({ error: auth.reason }, { status: auth.status });
  }

  let body: ChatRequestBody = {};
  try {
    body = (await request.json()) as ChatRequestBody;
  } catch {
    // No body / non-JSON body — that's fine; the stub keeps going so we can
    // exercise the memory-store path even with a curl ping.
  }

  const userMessage =
    typeof body.message === 'string' ? body.message.trim() : '';

  // Dogfood Strata as the conversational memory backend. The Cognito `sub`
  // claim is the user UUID Strata indexes under. We deliberately do NOT
  // catch storeMemory errors here — if memory storage fails, the user
  // should know rather than chat against a backend that isn't recording
  // turns. AWS-3.3 may revisit this when the agent loop lands and there
  // are real recall failures to weigh against.
  if (userMessage) {
    const strata = new StrataClient(auth.claims.sub);
    await strata.storeMemory({
      memory_text: userMessage,
      type: 'episodic',
      tags: [],
    });
  }

  // AWS-3.3 replaces this stub with:
  //   - a recall step (strata.searchHistory({ query: userMessage, ... }))
  //   - the Anthropic SDK tool-use loop
  //   - per-tool ElastiCache LRU caching
  return NextResponse.json({
    message: 'AWS-3.3 will populate this with the SDK tool catalog + Anthropic loop',
    user: {
      sub: auth.claims.sub,
      email: auth.claims.email,
      groups: auth.claims.groups,
    },
    memory_recorded: Boolean(userMessage),
  });
}
