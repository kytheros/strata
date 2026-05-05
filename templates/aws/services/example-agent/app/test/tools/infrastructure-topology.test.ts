import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  EC2Client,
  DescribeVpcsCommand,
  DescribeSubnetsCommand,
  DescribeNatGatewaysCommand,
  DescribeVpcEndpointsCommand,
} from '@aws-sdk/client-ec2';
import {
  ECSClient,
  ListServicesCommand,
  DescribeServicesCommand,
} from '@aws-sdk/client-ecs';
import { RDSClient, DescribeDBClustersCommand } from '@aws-sdk/client-rds';
import {
  ElasticLoadBalancingV2Client,
  DescribeLoadBalancersCommand,
  DescribeTargetGroupsCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { execute } from '../../app/lib/tools/infrastructure-topology';
import { makeCtx } from '../helpers';

const ec2 = mockClient(EC2Client);
const ecs = mockClient(ECSClient);
const rds = mockClient(RDSClient);
const elb = mockClient(ElasticLoadBalancingV2Client);

beforeEach(() => {
  ec2.reset();
  ecs.reset();
  rds.reset();
  elb.reset();
});

describe('infrastructure_topology', () => {
  it('composes the four sub-tools into a single summary', async () => {
    ec2.on(DescribeVpcsCommand).resolves({ Vpcs: [{ VpcId: 'vpc-1' }] });
    ec2.on(DescribeSubnetsCommand).resolves({
      Subnets: [{ SubnetId: 'subnet-a' }, { SubnetId: 'subnet-b' }],
    });
    ec2.on(DescribeNatGatewaysCommand).resolves({
      NatGateways: [{ NatGatewayId: 'nat-1' }, { NatGatewayId: 'nat-2' }],
    });
    ec2.on(DescribeVpcEndpointsCommand).resolves({ VpcEndpoints: [] });

    ecs.on(ListServicesCommand).resolves({ serviceArns: ['arn:s/strata'] });
    ecs.on(DescribeServicesCommand).resolves({
      services: [
        { serviceName: 'strata', runningCount: 1, desiredCount: 1, status: 'ACTIVE' },
      ],
    });

    rds.on(DescribeDBClustersCommand).resolves({
      DBClusters: [{ DBClusterIdentifier: 'strata-dev', Status: 'available' }],
    });

    elb.on(DescribeLoadBalancersCommand).resolves({
      LoadBalancers: [
        {
          LoadBalancerArn: 'arn:lb/1',
          LoadBalancerName: 'strata-dev',
          Scheme: 'internal',
          State: { Code: 'active' },
        },
      ],
    });
    elb.on(DescribeTargetGroupsCommand).resolves({ TargetGroups: [] });

    const ctx = makeCtx();
    const out = (await execute({}, ctx)) as Record<string, any>;
    expect(out.vpc.vpcCount).toBe(1);
    expect(out.vpc.subnetCount).toBe(2);
    expect(out.vpc.natGatewayCount).toBe(2);
    expect(out.ecs.serviceCount).toBe(1);
    expect((out.aurora as any).status).toBe('available');
    expect(out.loadBalancers.count).toBe(1);
    expect(out.loadBalancers.summary[0].name).toBe('strata-dev');
  });
});
