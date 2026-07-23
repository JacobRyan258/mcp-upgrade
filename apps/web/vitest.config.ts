import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Playwright specs live in e2e/ and are run by `npm run test:e2e`.
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules/**', '.next/**', 'e2e/**'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
