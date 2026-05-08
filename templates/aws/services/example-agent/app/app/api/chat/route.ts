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
  // Legacy shape — single-turn (still used by test scripts and the
  // synthetic canary). Coerced to a one-message conversation.
  message?: unknown;
  // Full conversation history. Each entry is `{role, content}` matching
  // Anthropic's Messages API. The UI sends this so the model sees prior
  // turns and can reason across them ("can you check that?" needs the
  // assistant's prior turn for context).
  messages?: unknown;
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

  // Resolve the conversation. Two accepted shapes:
  //   1. { messages: [{role, content}, ...] } — full history (UI default)
  //   2. { message: string }                  — legacy single-turn
  let conversation: MessageParam[] = [];
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (
        m &&
        typeof m === 'object' &&
        'role' in m &&
        'content' in m &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' &&
        m.content.trim().length > 0
      ) {
        conversation.push({ role: m.role, content: m.content });
      }
    }
  } else if (typeof body.message === 'string' && body.message.trim()) {
    conversation = [{ role: 'user', content: body.message.trim() }];
  }

  if (conversation.length === 0 || conversation[conversation.length - 1].role !== 'user') {
    return NextResponse.json(
      {
        error:
          'Empty conversation. Expected { messages: [{role, content}, ...] } ending with a user turn.',
      },
      { status: 400 },
    );
  }

  // The most recent user turn drives recall + storage. Anthropic's
  // Messages API treats prior turns as model-side context only.
  const userMessage = conversation[conversation.length - 1].content as string;

  const strata = new StrataClient(auth.claims.sub);

  // 1. Cross-session recall — search prior memories scoped to this user.
  // Note: turn-level continuity comes from `conversation` above; Strata
  // recall is for cross-session semantic memory ("last week the operator
  // asked about NAT costs"), not the immediately-prior assistant turn.
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

  // 4. Run the loop with the full conversation.
  const ctx = buildDefaultContext(cache);
  const result = await runAgentLoop({ systemPrompt, messages: conversation, ctx });

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
