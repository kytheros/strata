import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  S3Client,
  ListBucketsCommand,
  GetBucketEncryptionCommand,
  GetBucketLocationCommand,
} from '@aws-sdk/client-s3';
import { execute } from '../../app/lib/tools/s3-bucket-summary';
import { makeCtx } from '../helpers';

const s3 = mockClient(S3Client);
beforeEach(() => s3.reset());

describe('s3_bucket_summary', () => {
  it('summarizes encryption posture and treats us-east-1 null location correctly', async () => {
    s3.on(ListBucketsCommand).resolves({
      Buckets: [
        { Name: 'strata-state', CreationDate: new Date('2026-01-01T00:00:00Z') },
        { Name: 'strata-data', CreationDate: new Date('2026-02-01T00:00:00Z') },
      ],
    });
    s3.on(GetBucketLocationCommand, { Bucket: 'strata-state' }).resolves({
      LocationConstraint: undefined,
    });
    s3.on(GetBucketLocationCommand, { Bucket: 'strata-data' }).resolves({
      LocationConstraint: 'us-west-2' as any,
    });
    s3.on(GetBucketEncryptionCommand, { Bucket: 'strata-state' }).resolves({
      ServerSideEncryptionConfiguration: {
        Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms' } }],
      },
    });
    s3.on(GetBucketEncryptionCommand, { Bucket: 'strata-data' }).rejects({
      name: 'ServerSideEncryptionConfigurationNotFoundError',
    });

    const ctx = makeCtx();
    const out = (await execute({}, ctx)) as Record<string, any>;
    expect(out.count).toBe(2);
    const stateBucket = out.buckets.find((b: any) => b.name === 'strata-state');
    expect(stateBucket.region).toBe('us-east-1');
    expect(stateBucket.encryption).toBe('aws:kms');
    const dataBucket = out.buckets.find((b: any) => b.name === 'strata-data');
    expect(dataBucket.region).toBe('us-west-2');
    expect(dataBucket.encryption).toBe('unconfigured');
  });
});
