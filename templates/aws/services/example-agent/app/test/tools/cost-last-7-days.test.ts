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
  it('aggregates daily costs by service and sorts descending', async () => {
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

    await execute({}, ctx);
    expect(ce.commandCalls(GetCostAndUsageCommand)).toHaveLength(1);
  });
});
