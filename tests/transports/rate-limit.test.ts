import { describe, it, expect } from 'vitest';
import { checkTenantRateLimit } from '../../src/transports/middleware.js';

describe('checkTenantRateLimit', () => {
  it('allows under the limit', async () => {
    const counters = new Map<string, number>();
    const result = await checkTenantRateLimit('tenant-a', { counters, limit: 60, windowSec: 60, now: () => 0 });
    expect(result.allowed).toBe(true);
  });

  it('blocks at the limit', async () => {
    const counters = new Map<string, number>();
    for (let i = 0; i < 60; i++) {
      await checkTenantRateLimit('tenant-a', { counters, limit: 60, windowSec: 60, now: () => 0 });
    }
    const blocked = await checkTenantRateLimit('tenant-a', { counters, limit: 60, windowSec: 60, now: () => 0 });
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
  });
});
