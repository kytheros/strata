import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { execute } from '../../app/lib/tools/who-am-i';
import { makeCtx } from '../helpers';

const sts = mockClient(STSClient);

beforeEach(() => sts.reset());

describe('who_am_i', () => {
  it('returns identity summary on first call and caches it', async () => {
    sts.on(GetCallerIdentityCommand).resolves({
      Account: '624990353897',
      Arn: 'arn:aws:sts::624990353897:assumed-role/example-agent-dev/task',
      UserId: 'AROAEXAMPLE:task',
    });
    const ctx = makeCtx();

    const result = (await execute({}, ctx)) as Record<string, unknown>;
    expect(result.accountId).toBe('624990353897');
    expect(result.userArn).toContain('example-agent-dev');
    expect(result.region).toBe('us-east-1');
    expect(sts.calls()).toHaveLength(1);

    // Second call hits the cache, not STS.
    const second = await execute({}, ctx);
    expect(second).toEqual(result);
    expect(sts.calls()).toHaveLength(1);
  });
});
