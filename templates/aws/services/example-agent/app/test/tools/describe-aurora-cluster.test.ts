import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { RDSClient, DescribeDBClustersCommand } from '@aws-sdk/client-rds';
import { execute } from '../../app/lib/tools/describe-aurora-cluster';
import { makeCtx } from '../helpers';

const rds = mockClient(RDSClient);
beforeEach(() => rds.reset());

describe('describe_aurora_cluster', () => {
  it('summarizes a found cluster and caches the response', async () => {
    rds.on(DescribeDBClustersCommand).resolves({
      DBClusters: [
        {
          DBClusterIdentifier: 'strata-dev',
          Status: 'available',
          Engine: 'aurora-postgresql',
          EngineVersion: '15.5',
          Endpoint: 'strata-dev.cluster-x.us-east-1.rds.amazonaws.com',
          ReaderEndpoint: 'strata-dev.cluster-ro-x.us-east-1.rds.amazonaws.com',
          ServerlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 4 },
          BackupRetentionPeriod: 7,
          StorageEncrypted: true,
          DeletionProtection: true,
        },
      ],
    });

    const ctx = makeCtx();
    const out = (await execute({}, ctx)) as Record<string, any>;
    expect(out.found).toBe(true);
    expect(out.engineVersion).toBe('15.5');
    expect(out.serverlessV2.maxCapacity).toBe(4);
    expect(out.storageEncrypted).toBe(true);

    await execute({}, ctx);
    expect(rds.commandCalls(DescribeDBClustersCommand)).toHaveLength(1);
  });

  it('reports not-found cleanly when the cluster does not exist', async () => {
    rds.on(DescribeDBClustersCommand).resolves({ DBClusters: [] });
    const out = (await execute({ clusterId: 'strata-staging' }, makeCtx())) as Record<string, any>;
    expect(out.found).toBe(false);
    expect(out.clusterId).toBe('strata-staging');
  });

  it('rejects cluster identifiers outside the strata-* namespace before any SDK call', async () => {
    rds.on(DescribeDBClustersCommand).resolves({ DBClusters: [] });
    const ctx = makeCtx();

    await expect(
      execute({ clusterId: 'production-billing-db' }, ctx),
    ).rejects.toThrow(/outside the allowed strata-\* namespace/);
    await expect(
      execute({ clusterId: 'arn:aws:rds:us-east-1:111:cluster:other' }, ctx),
    ).rejects.toThrow(/outside the allowed/);

    expect(rds.commandCalls(DescribeDBClustersCommand)).toHaveLength(0);
  });
});
