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

  it('accepts allowed log group patterns', async () => {
    cwl.on(FilterLogEventsCommand).resolves({ events: [] });
    const ctx = makeCtx();

    await expect(
      execute({ logGroupName: '/ecs/strata-dev' }, ctx),
    ).resolves.toBeDefined();
    await expect(
      execute({ logGroupName: '/aws/lambda/strata-dev-mcp-canary' }, ctx),
    ).resolves.toBeDefined();
    await expect(
      execute({ logGroupName: '/aws/lambda/strata-dev-pre-signup' }, ctx),
    ).resolves.toBeDefined();
    await expect(
      execute({ logGroupName: '/aws/lambda/strata-dev-post-confirmation' }, ctx),
    ).resolves.toBeDefined();
  });

  it('rejects log groups outside the strata-dev namespace before any SDK call', async () => {
    cwl.on(FilterLogEventsCommand).resolves({ events: [] });
    const ctx = makeCtx();

    // The classic prompt-injection target — a log group in a different
    // namespace altogether.
    await expect(
      execute({ logGroupName: '/aws/lambda/billing-service' }, ctx),
    ).rejects.toThrow(/outside the allowed strata-dev namespace/);

    // Subtler attack — borrowing the strata-* prefix but with a path
    // shape we don't bless.
    await expect(
      execute({ logGroupName: '/aws/rds/cluster/strata-dev/audit' }, ctx),
    ).rejects.toThrow(/outside the allowed/);

    // Path-traversal-flavored — looks like an allowed pattern but isn't.
    await expect(
      execute({ logGroupName: '/ecs/strata-dev/../other' }, ctx),
    ).rejects.toThrow(/outside the allowed/);

    // SDK was never called for ANY of these rejections.
    expect(cwl.commandCalls(FilterLogEventsCommand)).toHaveLength(0);
  });
});
