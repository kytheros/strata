import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  EC2Client,
  DescribeVpcsCommand,
  DescribeSubnetsCommand,
  DescribeNatGatewaysCommand,
  DescribeVpcEndpointsCommand,
} from '@aws-sdk/client-ec2';
import { execute } from '../../app/lib/tools/list-vpc-resources';
import { makeCtx } from '../helpers';

const ec2 = mockClient(EC2Client);
beforeEach(() => ec2.reset());

describe('list_vpc_resources', () => {
  it('runs the four describes in parallel and merges results', async () => {
    ec2
      .on(DescribeVpcsCommand)
      .resolves({ Vpcs: [{ VpcId: 'vpc-1', CidrBlock: '10.40.0.0/16', IsDefault: false }] });
    ec2.on(DescribeSubnetsCommand).resolves({
      Subnets: [
        { SubnetId: 'subnet-a', VpcId: 'vpc-1', AvailabilityZone: 'us-east-1a', CidrBlock: '10.40.1.0/24', MapPublicIpOnLaunch: false },
      ],
    });
    ec2.on(DescribeNatGatewaysCommand).resolves({
      NatGateways: [
        {
          NatGatewayId: 'nat-1',
          SubnetId: 'subnet-a',
          VpcId: 'vpc-1',
        },
      ],
    } as any);
    ec2.on(DescribeVpcEndpointsCommand).resolves({
      VpcEndpoints: [
        {
          VpcEndpointId: 'vpce-1',
          ServiceName: 'com.amazonaws.us-east-1.s3',
          VpcEndpointType: 'Gateway',
        },
      ],
    } as any);

    const ctx = makeCtx();
    const out = (await execute({}, ctx)) as Record<string, any>;
    expect(out.vpcs).toHaveLength(1);
    expect(out.subnets[0].az).toBe('us-east-1a');
    expect(out.natGateways[0].id).toBe('nat-1');
    expect(out.vpcEndpoints[0].type).toBe('Gateway');

    await execute({}, ctx);
    expect(ec2.commandCalls(DescribeVpcsCommand)).toHaveLength(1);
  });
});
