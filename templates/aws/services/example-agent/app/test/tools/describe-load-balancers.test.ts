import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  ElasticLoadBalancingV2Client,
  DescribeLoadBalancersCommand,
  DescribeTargetGroupsCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { execute } from '../../app/lib/tools/describe-load-balancers';
import { makeCtx } from '../helpers';

const elb = mockClient(ElasticLoadBalancingV2Client);
beforeEach(() => elb.reset());

describe('describe_load_balancers', () => {
  it('cross-references target groups against their load balancers', async () => {
    elb.on(DescribeLoadBalancersCommand).resolves({
      LoadBalancers: [
        {
          LoadBalancerArn: 'arn:lb/strata',
          LoadBalancerName: 'strata-dev',
          DNSName: 'strata-dev.elb.amazonaws.com',
          Scheme: 'internet-facing',
          Type: 'application',
          State: { Code: 'active' },
        },
      ],
    });
    elb.on(DescribeTargetGroupsCommand).resolves({
      TargetGroups: [
        {
          TargetGroupName: 'strata-tg',
          Protocol: 'HTTP',
          Port: 3000,
          TargetType: 'ip',
          HealthCheckPath: '/health',
          LoadBalancerArns: ['arn:lb/strata'],
        },
      ],
    });
    const ctx = makeCtx();
    const out = (await execute({}, ctx)) as Record<string, any>;
    expect(out.count).toBe(1);
    expect(out.loadBalancers[0].targetGroups[0].name).toBe('strata-tg');
    await execute({}, ctx);
    expect(elb.commandCalls(DescribeLoadBalancersCommand)).toHaveLength(1);
  });
});
