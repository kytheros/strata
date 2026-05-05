import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { execute } from '../../app/lib/tools/tail-recent-logs';
import { makeCtx } from '../helpers';

const cwl = mockClient(CloudWatchLogsClient);
beforeEach(() => cwl.reset());

describe('tail_recent_logs', () => {
  it('caps message length, emits ISO timestamps, and caches', async () => {
    cwl.on(FilterLogEventsCommand).resolves({
      events: [
        {
          timestamp: 1714809600000,
          message: 'X'.repeat(1000),
          logStreamName: 'stream-1',
        },
      ],
    });
    const ctx = makeCtx();
    const out = (await execute({ filterPattern: 'ERROR' }, ctx)) as Record<string, any>;
    expect(out.eventCount).toBe(1);
    expect(out.events[0].message).toHaveLength(500);
    expect(out.events[0].timestamp).toMatch(/Z$/);

    await execute({ filterPattern: 'ERROR' }, ctx);
    expect(cwl.commandCalls(FilterLogEventsCommand)).toHaveLength(1);
  });
});
