import { defineConfig, devices } from '@playwright/test';

/**
 * Browser-level tests.
 *
 * Split into two projects along the line of what a run can honestly guarantee:
 *
 *   `public` needs no credential beyond the Supabase public configuration. It
 *   covers everything reachable without an account — the marketing pages, the
 *   security headers, and, more importantly, every access-control decision made
 *   *before* a user exists: the dashboard gate, the 401s, the cross-site
 *   forgery refusals and the open-redirect handling. This project is safe to run
 *   in CI on every commit and is the one that would catch a regression in the
 *   authorization boundary.
 *
 *   `journey` drives real sign-up, scanning and billing. It needs a live
 *   database, the service-role key and Stripe test credentials, so it is skipped
 *   unless `E2E_LIVE=1` is set. Making it opt-in rather than best-effort is
 *   deliberate: a suite that silently degrades to "passed because it did not
 *   run" is worse than no suite, and third-party outages must not fail an
 *   unrelated commit.
 *
 * The dev server is used rather than `next start` because the production
 * startup check refuses a build whose inlined app URL is localhost when it is
 * marked as a deployment, and because a failed assertion in a built artifact is
 * far harder to read than a dev-server stack trace.
 */
const PORT = Number(process.env.E2E_PORT ?? 3100);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  // Every spec here asserts on server behaviour, so a flaky retry would hide a
  // real intermittent fault rather than paper over a rendering race.
  retries: process.env.CI ? 1 : 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    {
      name: 'public',
      testMatch: /(public|access-control)\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'journey',
      testMatch: /journey\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: `npm run dev -- --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      // The dev server loads apps/web/.env.local for everything else. This one
      // is overridden so same-origin checks and redirects agree with the port
      // Playwright actually drives.
      NEXT_PUBLIC_APP_URL: BASE_URL,
    },
  },
});
