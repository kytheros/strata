// Chat backend — STUB. AWS-3.3 replaces this body with the SDK tool
// catalog + Anthropic SDK tool-use loop + ElastiCache LRU wrapper.
//
// The auth gate is real: every request is verified end-to-end, including
// group membership. This is the contract AWS-3.3 inherits.

import { NextResponse, type NextRequest } from 'next/server';
import { authenticateRequest } from '../../lib/auth-middleware';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(_request: NextRequest) {
  const auth = await authenticateRequest();
  if (!auth.ok) {
    return NextResponse.json({ error: auth.reason }, { status: auth.status });
  }

  return NextResponse.json({
    message:
      'AWS-3.3 will populate this with the SDK tool catalog + Anthropic loop',
    user: {
      sub: auth.claims.sub,
      email: auth.claims.email,
      groups: auth.claims.groups,
    },
  });
}
