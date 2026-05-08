import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { execute } from '../../app/lib/tools/list-log-groups';
import { makeCtx } from '../helpers';

const cwl = mockClient(CloudWatchLogsClient);
beforeEach(() => cwl.reset());

describe('list_log_groups', () => {
  it('returns only allowlisted strata-* groups even when CloudWatch returns more', async () => {
    // CloudWatch happily returns whatever IAM lets through. The tool is
    // responsible for filtering down to what the model is allowed to act on.
    cwl.on(DescribeLogGroupsCommand).resolves({
      logGroups: [
        { logGroupName: '/ecs/strata-dev', retentionInDays: 30, storedBytes: 12_345 },
        { logGroupName: '/aws/lambda/strata-dev-mcp-canary', retentionInDays: 14, storedBytes: 678 },
        { logGroupName: '/aws/lambda/billing-service', retentionInDays: 7, storedBytes: 99 }, // out
        { logGroupName: '/aws/rds/cluster/strata-dev/audit', retentionInDays: 30 }, // out
      ],
    });
    const ctx = makeCtx();
    const out = (await execute({}, ctx)) as Record<string, any>;
    expect(out.count).toBe(2);
    const names = out.logGroups.map((g: any) => g.name).sort();
    expect(names).toEqual([
      '/aws/lambda/strata-dev-mcp-canary',
      '/ecs/strata-dev',
    ]);

    // Caches.
    await execute({}, ctx);
    expect(cwl.commandCalls(DescribeLogGroupsCommand)).toHaveLength(1);
  });

  it('forwards namePrefix and limit to CloudWatch', async () => {
    cwl.on(DescribeLogGroupsCommand).resolves({ logGroups: [] });
    const ctx = makeCtx();
    await execute({ namePrefix: '/aws/lambda/strata-', limit: 10 }, ctx);

    const calls = cwl.commandCalls(DescribeLogGroupsCommand);
    expect(calls).toHaveLength(1);
    const args = calls[0].args[0].input as Record<string, unknown>;
    expect(args.logGroupNamePrefix).toBe('/aws/lambda/strata-');
    expect(args.limit).toBe(10);
  });

  it('rejects out-of-range limit (Zod) before any SDK call', async () => {
    cwl.on(DescribeLogGroupsCommand).resolves({ logGroups: [] });
    const ctx = makeCtx();

    await expect(execute({ limit: 0 }, ctx)).rejects.toThrow();
    await expect(execute({ limit: 1000 }, ctx)).rejects.toThrow();
    expect(cwl.commandCalls(DescribeLogGroupsCommand)).toHaveLength(0);
  });
});
