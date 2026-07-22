import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Database tests share one scratch database and assert on counters, so they
    // must not interleave.
    fileParallelism: false,
  },
});
