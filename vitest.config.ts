import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Fixtures are scanner *input*, never test files.
    exclude: ['node_modules/**', 'dist/**', 'test/fixtures/**'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
