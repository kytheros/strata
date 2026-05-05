// Chat backend (AWS-3.3).
//
// Flow per turn:
//   1. authenticateRequest() — reuse the AWS-3.1 gate. Returns the verified
//      Cognito sub on success.
//   2. Recall: strata.searchHistory({ query }) — pulls relevant memories
//      from prior sessions.
//   3. Memory write: strata.storeMemory({ memory_text: userMessage,
//      type: 'episodic' }).
//   4. Run the Anthropic SDK tool-use loop (agent-loop.ts) with the 10
//      AWS SDK wrappers, ElastiCache LRU, and a system prompt that
//      grounds the model in the deploy's role + the recall context.
//   5. Memory write: store the assistant's final response so the next
//      session can recall it.
//   6. Return { message, toolCalls } so the UI can render which tools
//      were used.
//
// We don't catch storeMemory failures — the auth-proxy contract is
// load-bearing; if it's wrong, the operator should know rather than chat
// against a memory layer that isn't recording. Tool-execution errors are
// swallowed inside executeTool() and surfaced to the model as
// `{ error, message }` so the loop can recover.

import { NextResponse, type NextRequest } from 'next/server';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import { authenticateRequest } from '../../lib/auth-middleware';
import { StrataClient } from '../../lib/strata-client';
import { runAgentLoop, SYSTEM_PROMPT_TEMPLATE } from '../../lib/agent-loop';
import { ToolCache } from '../../lib/cache';
import { buildDefaultContext } from '../../lib/tools/context';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface ChatRequestBody {
  message?: unknown;
}

// Module-level singleton — reused across warm Lambda / Fargate task
// lifetimes. Construction is cheap; the Redis connection inside is lazy.
const cache = new ToolCache();

export async function POST(request: NextRequest) {
  const auth = await authenticateRequest();
  if (!auth.ok) {
    return NextResponse.json({ error: auth.reason }, { status: auth.status });
  }

  let body: ChatRequestBody = {};
  try {
    body = (await request.json()) as ChatRequestBody;
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON body. Expected { message: string }.' },
      { status: 400 },
    );
  }

  const userMessage =
    typeof body.message === 'string' ? body.message.trim() : '';

  if (!userMessage) {
    return NextResponse.json(
      { error: 'Empty message.' },
      { status: 400 },
    );
  }

  const strata = new StrataClient(auth.claims.sub);

  // 1. Recall — search prior memories scoped to this user.
  let recall: Array<Record<string, unknown>> = [];
  try {
    const history = await strata.searchHistory({
      query: userMessage,
      limit: 10,
    });
    recall = history.results ?? [];
  } catch (err) {
    // Recall is best-effort. If Strata is down, log and continue with an
    // empty recall context rather than 500'ing the chat.
    // eslint-disable-next-line no-console
    console.error('[chat] searchHistory failed:', err);
  }

  // 2. Persist the user turn before we even call the model — if the loop
  // fails, we still want the question recorded.
  await strata.storeMemory({
    memory_text: userMessage,
    type: 'episodic',
    tags: ['user_turn'],
  });

  // 3. Compose the system prompt. The recall context is appended as JSON
  // so the model can ignore it cleanly when irrelevant.
  const systemPrompt = `${SYSTEM_PROMPT_TEMPLATE}\n${
    recall.length > 0
      ? JSON.stringify(recall.slice(0, 10))
      : '(no prior memories matched)'
  }`;

  // 4. Run the loop.
  const messages: MessageParam[] = [{ role: 'user', content: userMessage }];
  const ctx = buildDefaultContext(cache);
  const result = await runAgentLoop({ systemPrompt, messages, ctx });

  // 5. Persist the assistant's response. Tag separately so the recall
  // tool can de-bias toward operator turns later if needed.
  if (result.finalText) {
    await strata.storeMemory({
      memory_text: result.finalText,
      type: 'episodic',
      tags: ['assistant_turn'],
    });
  }

  return NextResponse.json({
    message: result.finalText,
    toolCalls: result.toolCalls,
    iterations: result.iterations,
    stoppedReason: result.stoppedReason,
  });
}
