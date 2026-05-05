import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  ECSClient,
  ListServicesCommand,
  DescribeServicesCommand,
} from '@aws-sdk/client-ecs';
import { execute } from '../../app/lib/tools/list-ecs-services';
import { makeCtx } from '../helpers';

const ecs = mockClient(ECSClient);

beforeEach(() => ecs.reset());

describe('list_ecs_services', () => {
  it('lists then describes services and produces a token-efficient summary', async () => {
    ecs
      .on(ListServicesCommand)
      .resolves({ serviceArns: ['arn:aws:ecs:us-east-1:1:service/strata-dev/strata'] });
    ecs.on(DescribeServicesCommand).resolves({
      services: [
        {
          serviceName: 'strata',
          runningCount: 1,
          desiredCount: 1,
          pendingCount: 0,
          status: 'ACTIVE',
          launchType: 'FARGATE',
          deployments: [{ rolloutState: 'COMPLETED' }],
        },
      ],
    });

    const ctx = makeCtx();
    const out = (await execute({}, ctx)) as Record<string, any>;
    expect(out.cluster).toBe('strata-dev');
    expect(out.services).toHaveLength(1);
    expect(out.services[0].name).toBe('strata');
    expect(out.services[0].deploymentStatus).toBe('COMPLETED');

    // Cache hit: no second SDK call.
    await execute({}, ctx);
    expect(ecs.commandCalls(ListServicesCommand)).toHaveLength(1);
  });

  it('short-circuits when the cluster has no services', async () => {
    ecs.on(ListServicesCommand).resolves({ serviceArns: [] });
    const out = (await execute({}, makeCtx())) as Record<string, any>;
    expect(out.services).toEqual([]);
    expect(ecs.commandCalls(DescribeServicesCommand)).toHaveLength(0);
  });
});
