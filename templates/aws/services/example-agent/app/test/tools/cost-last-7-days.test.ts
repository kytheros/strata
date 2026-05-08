import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CostExplorerClient,
  GetCostAndUsageCommand,
} from '@aws-sdk/client-cost-explorer';
import { execute } from '../../app/lib/tools/cost-last-7-days';
import { makeCtx } from '../helpers';

const ce = mockClient(CostExplorerClient);
beforeEach(() => ce.reset());

describe('cost_last_7_days', () => {
  it('aggregates daily costs by service and sorts descending (default 7-day window)', async () => {
    ce.on(GetCostAndUsageCommand).resolves({
      ResultsByTime: [
        {
          Groups: [
            { Keys: ['Amazon ECS'], Metrics: { UnblendedCost: { Amount: '1.50', Unit: 'USD' } } },
            { Keys: ['Amazon RDS'], Metrics: { UnblendedCost: { Amount: '4.25', Unit: 'USD' } } },
          ],
        },
        {
          Groups: [
            { Keys: ['Amazon ECS'], Metrics: { UnblendedCost: { Amount: '1.50', Unit: 'USD' } } },
            { Keys: ['Amazon RDS'], Metrics: { UnblendedCost: { Amount: '4.25', Unit: 'USD' } } },
          ],
        },
      ],
    });
    const ctx = makeCtx();
    const out = (await execute({}, ctx)) as Record<string, any>;
    expect(out.byService[0].service).toBe('Amazon RDS');
    expect(out.byService[0].amount).toBeCloseTo(8.5, 4);
    expect(out.byService[1].service).toBe('Amazon ECS');
    expect(out.total).toBeCloseTo(11.5, 4);
    expect(out.days).toBe(7);

    // periodStart should be exactly 7 days before periodEnd.
    const start = new Date(out.periodStart);
    const end = new Date(out.periodEnd);
    expect(Math.round((end.getTime() - start.getTime()) / 86_400_000)).toBe(7);

    await execute({}, ctx);
    expect(ce.commandCalls(GetCostAndUsageCommand)).toHaveLength(1);
  });

  it('honors a 30-day lookback when days=30 is passed and uses a distinct cache key', async () => {
    ce.on(GetCostAndUsageCommand).resolves({
      ResultsByTime: [
        {
          Groups: [
            { Keys: ['Amazon ECS'], Metrics: { UnblendedCost: { Amount: '10.00', Unit: 'USD' } } },
          ],
        },
      ],
    });
    const ctx = makeCtx();
    // Warm the 7-day cache first.
    await execute({}, ctx);
    // Now ask for 30 — cache must miss because the key is shaped on `days`.
    const out = (await execute({ days: 30 }, ctx)) as Record<string, any>;
    expect(out.days).toBe(30);
    const start = new Date(out.periodStart);
    const end = new Date(out.periodEnd);
    expect(Math.round((end.getTime() - start.getTime()) / 86_400_000)).toBe(30);

    expect(ce.commandCalls(GetCostAndUsageCommand)).toHaveLength(2);
  });

  it('rejects out-of-range days (Zod) before any SDK call', async () => {
    ce.on(GetCostAndUsageCommand).resolves({ ResultsByTime: [] });
    const ctx = makeCtx();

    await expect(execute({ days: 0 }, ctx)).rejects.toThrow();
    await expect(execute({ days: 365 }, ctx)).rejects.toThrow();
    expect(ce.commandCalls(GetCostAndUsageCommand)).toHaveLength(0);
  });
});
