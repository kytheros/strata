import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CloudWatchClient,
  DescribeAlarmsCommand,
} from '@aws-sdk/client-cloudwatch';
import { execute } from '../../app/lib/tools/list-active-alarms';
import { makeCtx } from '../helpers';

const cw = mockClient(CloudWatchClient);
beforeEach(() => cw.reset());

describe('list_active_alarms', () => {
  it('returns only ALARM-state alarms with a token-efficient summary', async () => {
    cw.on(DescribeAlarmsCommand).resolves({
      MetricAlarms: [
        {
          AlarmName: 'strata-dev-aurora-cpu-high',
          MetricName: 'CPUUtilization',
          Namespace: 'AWS/RDS',
          Threshold: 80,
          ComparisonOperator: 'GreaterThanThreshold',
          StateReason: 'CPU at 92% for 5 datapoints',
          StateUpdatedTimestamp: new Date('2026-05-04T10:00:00Z'),
        },
      ],
    });
    const ctx = makeCtx();
    const out = (await execute({}, ctx)) as Record<string, any>;
    expect(out.activeCount).toBe(1);
    expect(out.alarms[0].name).toBe('strata-dev-aurora-cpu-high');
    expect(out.alarms[0].sinceUtc).toBe('2026-05-04T10:00:00.000Z');

    await execute({}, ctx);
    expect(cw.commandCalls(DescribeAlarmsCommand)).toHaveLength(1);
  });
});
