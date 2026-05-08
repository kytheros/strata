// Verifies the agent-loop seam: when a tool returns a payload that
// contains a secret-shaped string, the content shipped to the model
// (and to the chat-response toolCalls trace) is redacted.
//
// We don't spin up Anthropic; we exercise the same composition the
// loop performs (executeTool -> JSON.stringify -> redact).

import { describe, it, expect } from 'vitest';
import { redact } from '../../app/lib/redact';

const ANT_PREFIX = 'sk-' + 'ant-' + 'api03-';
const fakeAnthropicKey = ANT_PREFIX + 'F'.repeat(40);

describe('agent-loop tool-output redaction', () => {
  it('scrubs an accidentally-logged Anthropic key from tool output before the model sees it', () => {
    // Simulate a tool result where a CloudWatch log event captured a
    // misconfigured library logging its API key.
    const toolOutput = {
      logGroupName: '/ecs/strata-dev',
      eventCount: 1,
      events: [
        {
          timestamp: '2026-05-07T12:00:00.000Z',
          message: `bootstrap: ANTHROPIC_API_KEY=${fakeAnthropicKey} resolved OK`,
          logStream: 'main',
        },
      ],
    };

    // This is exactly what agent-loop.ts does before pushing the
    // tool_result block into the conversation.
    const stringified = JSON.stringify(toolOutput);
    const { redacted, counts } = redact(stringified);

    // The literal key must not appear in the content the model sees.
    expect(redacted).not.toContain(fakeAnthropicKey);
    expect(redacted).toContain('[REDACTED:anthropic-key]');
    expect(counts['anthropic-key']).toBe(1);

    // And the structure is still valid JSON the model can parse.
    const parsed = JSON.parse(redacted);
    expect(parsed.events[0].message).toContain('[REDACTED:anthropic-key]');
    expect(parsed.logGroupName).toBe('/ecs/strata-dev');
  });
});
