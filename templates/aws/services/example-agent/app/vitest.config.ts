import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Each tool test is independent; the redis cache is replaced with
    // InMemoryToolCache fixtures, so no network is required.
    globals: false,
  },
});
