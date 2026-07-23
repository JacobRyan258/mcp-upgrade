import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules/**'],
    environment: 'node',
    // Every test in here is either pure or hits a temporary directory. Nothing
    // reaches the network: the Stripe API is exercised through an in-memory
    // gateway, so a green suite never implies a real Stripe account exists.
    testTimeout: 15_000,
  },
});
