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
  it('returns ALARM-state alarms when stateValue is passed and counts active correctly', async () => {
    cw.on(DescribeAlarmsCommand).resolves({
      MetricAlarms: [
        {
          AlarmName: 'strata-dev-aurora-cpu-high',
          StateValue: 'ALARM',
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
    const out = (await execute({ stateValue: 'ALARM' }, ctx)) as Record<string, any>;
    expect(out.activeCount).toBe(1);
    expect(out.totalCount).toBe(1);
    expect(out.stateFilter).toBe('ALARM');
    expect(out.alarms[0].name).toBe('strata-dev-aurora-cpu-high');
    expect(out.alarms[0].state).toBe('ALARM');
    expect(out.alarms[0].sinceUtc).toBe('2026-05-04T10:00:00.000Z');

    // Cache hit: same input → no second SDK call.
    await execute({ stateValue: 'ALARM' }, ctx);
    expect(cw.commandCalls(DescribeAlarmsCommand)).toHaveLength(1);
  });

  it('returns the full inventory when no stateValue is passed (no StateValue arg to CloudWatch)', async () => {
    // Mixed-state inventory — exactly the case the previous hard-coded
    // wrapper could not answer.
    cw.on(DescribeAlarmsCommand).resolves({
      MetricAlarms: [
        { AlarmName: 'strata-dev-a', StateValue: 'ALARM' },
        { AlarmName: 'strata-dev-b', StateValue: 'OK' },
        { AlarmName: 'strata-dev-c', StateValue: 'INSUFFICIENT_DATA' },
      ],
    });
    const ctx = makeCtx();
    const out = (await execute({}, ctx)) as Record<string, any>;
    expect(out.totalCount).toBe(3);
    expect(out.activeCount).toBe(1); // only the one in ALARM state
    expect(out.stateFilter).toBe('ANY');

    // Verify we did NOT pass StateValue to CloudWatch — that's the
    // promise of "no filter".
    const calls = cw.commandCalls(DescribeAlarmsCommand);
    expect(calls).toHaveLength(1);
    const args = calls[0].args[0].input as Record<string, unknown>;
    expect(args.StateValue).toBeUndefined();
  });

  it('forwards alarmNamePrefix and limit to the SDK', async () => {
    cw.on(DescribeAlarmsCommand).resolves({ MetricAlarms: [] });
    const ctx = makeCtx();
    await execute({ alarmNamePrefix: 'strata-dev-', limit: 25 }, ctx);

    const calls = cw.commandCalls(DescribeAlarmsCommand);
    expect(calls).toHaveLength(1);
    const args = calls[0].args[0].input as Record<string, unknown>;
    expect(args.AlarmNamePrefix).toBe('strata-dev-');
    expect(args.MaxRecords).toBe(25);
  });

  it('rejects an invalid stateValue at the schema layer (Zod) before any SDK call', async () => {
    cw.on(DescribeAlarmsCommand).resolves({ MetricAlarms: [] });
    const ctx = makeCtx();

    await expect(
      execute({ stateValue: 'BOGUS' as any }, ctx),
    ).rejects.toThrow();
    expect(cw.commandCalls(DescribeAlarmsCommand)).toHaveLength(0);
  });

  it('rejects out-of-range limit (Zod) before any SDK call', async () => {
    cw.on(DescribeAlarmsCommand).resolves({ MetricAlarms: [] });
    const ctx = makeCtx();

    await expect(execute({ limit: 500 }, ctx)).rejects.toThrow();
    await expect(execute({ limit: 0 }, ctx)).rejects.toThrow();
    expect(cw.commandCalls(DescribeAlarmsCommand)).toHaveLength(0);
  });
});
