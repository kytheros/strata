// Shared fixtures + mock helpers for the per-tool unit tests.

import { InMemoryToolCache } from '../app/lib/cache';
import type { ToolContext } from '../app/lib/tools/context';

export function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    region: 'us-east-1',
    clusterName: 'strata-dev',
    auroraClusterId: 'strata-dev',
    logGroupPrefix: '/ecs/strata-dev',
    cache: new InMemoryToolCache(),
    ...overrides,
  };
}
