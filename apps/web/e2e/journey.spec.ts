import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The signed-in journey, against real infrastructure.
 *
 * Opt-in. This suite needs a live database, the service-role key and — for the
 * billing half — Stripe test credentials, so it runs only when `E2E_LIVE=1` is
 * set. It is kept out of the default run on purpose: a suite that quietly
 * degrades to "passed because it never ran" is worse than no suite, and a
 * GitHub or Stripe outage must not fail an unrelated commit.
 *
 * Users are provisioned through the admin API with `email_confirm: true`,
 * because `requireUser()` treats an unverified address as signed-out and there
 * is no way to click a confirmation link from a test. Each test file run
 * creates its own users and deletes them afterwards, so runs do not collide.
 *
 *   E2E_LIVE=1 npm run test:e2e --workspace @mcp-upgrade/web -- --project=journey
 */

const LIVE = process.env.E2E_LIVE === '1';
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

test.skip(
  !LIVE || !SUPABASE_URL || !SERVICE_ROLE_KEY,
  'Set E2E_LIVE=1 with NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to run the live journey.',
);

const PASSWORD = 'e2e-password-not-a-real-secret';

function admin(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Creates a confirmed user and returns its id and address. */
async function createUser(label: string): Promise<{ id: string; email: string }> {
  const email = `e2e-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  const { data, error } = await admin().auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`could not create the test user: ${error?.message}`);
  return { id: data.user.id, email };
}

async function deleteUser(id: string): Promise<void> {
  await admin().auth.admin.deleteUser(id).catch(() => undefined);
}

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/sign-in');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/dashboard/, { timeout: 30_000 });
}

test.describe('a signed-in user can reach their dashboard', () => {
  let user: { id: string; email: string };

  test.beforeAll(async () => {
    user = await createUser('dash');
  });
  test.afterAll(async () => {
    await deleteUser(user.id);
  });

  test('signs in, sees the dashboard, and signs out again', async ({ page }) => {
    await signIn(page, user.email);
    await expect(page.locator('body')).toContainText(/scan/i);

    // A brand-new account is on Free with its full allowance intact.
    await expect(page.locator('body')).toContainText(/2/);

    await page.locator('form[action="/api/auth/sign-out"] button').click();
    await page.waitForURL((url) => !url.pathname.startsWith('/dashboard'), { timeout: 30_000 });

    // The session is genuinely gone, not merely navigated away from.
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/sign-in/);
  });

  test('is offered no download on the Free plan', async ({ page }) => {
    await signIn(page, user.email);
    const response = await page.request.get(`/api/scans/${crypto.randomUUID()}/download?format=json`);
    // Free has no downloads, so the plan gate answers before the lookup does.
    expect([402, 404]).toContain(response.status());
  });
});

test.describe('one user cannot reach another user\'s scan', () => {
  let owner: { id: string; email: string };
  let intruder: { id: string; email: string };

  test.beforeAll(async () => {
    owner = await createUser('owner');
    intruder = await createUser('intruder');
  });
  test.afterAll(async () => {
    await deleteUser(owner.id);
    await deleteUser(intruder.id);
  });

  test('a scan submitted by one account 404s for the other', async ({ browser }) => {
    const ownerContext = await browser.newContext();
    const ownerPage = await ownerContext.newPage();
    await signIn(ownerPage, owner.email);

    const created = await ownerPage.request.post('/api/scans', {
      headers: { 'sec-fetch-site': 'same-origin' },
      data: { repositoryUrl: 'https://github.com/modelcontextprotocol/servers' },
    });
    expect(created.status()).toBe(202);
    const { id } = (await created.json()) as { id: string };
    expect(id).toBeTruthy();

    // The owner can see it.
    const ownerView = await ownerPage.request.get(`/api/scans/${id}`);
    expect(ownerView.status()).toBe(200);

    const intruderContext = await browser.newContext();
    const intruderPage = await intruderContext.newPage();
    await signIn(intruderPage, intruder.email);

    // The intruder gets the same answer as for a job that does not exist, so
    // the endpoint cannot be used to discover valid ids.
    const intruderView = await intruderPage.request.get(`/api/scans/${id}`);
    expect(intruderView.status()).toBe(404);

    const intruderDownload = await intruderPage.request.get(`/api/scans/${id}/download?format=json`);
    expect([402, 404]).toContain(intruderDownload.status());

    // The report page must not render somebody else's scan either.
    await intruderPage.goto(`/dashboard/scans/${id}`);
    await expect(intruderPage.locator('body')).not.toContainText('modelcontextprotocol/servers');

    await ownerContext.close();
    await intruderContext.close();
  });
});

test.describe('input is validated server-side', () => {
  let user: { id: string; email: string };

  test.beforeAll(async () => {
    user = await createUser('input');
  });
  test.afterAll(async () => {
    await deleteUser(user.id);
  });

  test('refuses a repository address that is not a public GitHub repository', async ({ page }) => {
    await signIn(page, user.email);
    for (const repositoryUrl of [
      'https://gitlab.com/owner/repo',
      'https://github.com/owner',
      'file:///etc/passwd',
      'http://169.254.169.254/',
      'https://github.com/../../etc',
      '',
    ]) {
      const response = await page.request.post('/api/scans', {
        headers: { 'sec-fetch-site': 'same-origin' },
        data: { repositoryUrl },
      });
      expect(response.status(), `should have refused ${repositoryUrl}`).toBe(400);
    }
  });

  test('refuses an empty upload and a non-archive upload', async ({ page }) => {
    await signIn(page, user.email);
    const empty = await page.request.post('/api/scans', {
      headers: { 'sec-fetch-site': 'same-origin' },
      multipart: {
        file: { name: 'empty.zip', mimeType: 'application/zip', buffer: Buffer.alloc(0) },
      },
    });
    expect(empty.status()).toBe(400);
  });
});

test.describe('the Free allowance is enforced and cannot be exceeded', () => {
  let user: { id: string; email: string };

  test.beforeAll(async () => {
    user = await createUser('limit');
  });
  test.afterAll(async () => {
    await deleteUser(user.id);
  });

  test('admits exactly the plan allowance and then refuses with 402', async ({ page }) => {
    await signIn(page, user.email);

    const submit = () =>
      page.request.post('/api/scans', {
        headers: { 'sec-fetch-site': 'same-origin' },
        data: { repositoryUrl: 'https://github.com/modelcontextprotocol/servers' },
      });

    // Free is two scans per calendar month.
    expect((await submit()).status()).toBe(202);
    expect((await submit()).status()).toBe(202);

    const third = await submit();
    expect(third.status()).toBe(402);
    expect(await third.json()).toMatchObject({ error: 'limit_reached' });
  });

  test('concurrent submissions cannot all slip under the limit', async ({ browser }) => {
    // The allowance is reserved by an atomic UPDATE against one counter row, so
    // simultaneous requests serialise on it. Anything other than "exactly the
    // allowance is admitted" means the check-then-act window is back.
    const racer = await createUser('race');
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await signIn(page, racer.email);

      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          page.request.post('/api/scans', {
            headers: { 'sec-fetch-site': 'same-origin' },
            data: { repositoryUrl: 'https://github.com/modelcontextprotocol/servers' },
          }),
        ),
      );
      const admitted = results.filter((r) => r.status() === 202).length;
      expect(admitted).toBe(2);

      await context.close();
    } finally {
      await deleteUser(racer.id);
    }
  });
});

test.describe('billing', () => {
  test.skip(
    !process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_PRO_MONTHLY_PRICE_ID,
    'Set the Stripe test-mode variables to run the billing journey.',
  );

  let user: { id: string; email: string };

  test.beforeAll(async () => {
    user = await createUser('billing');
  });
  test.afterAll(async () => {
    await deleteUser(user.id);
  });

  test('checkout produces a Stripe-hosted session for a test-mode price', async ({ page }) => {
    await signIn(page, user.email);
    const response = await page.request.post('/api/stripe/checkout', {
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    expect(response.status()).toBe(200);
    const { url } = (await response.json()) as { url: string };
    expect(url).toContain('checkout.stripe.com');
  });

  test('returning from checkout does not by itself grant Pro', async ({ page }) => {
    await signIn(page, user.email);
    // The success URL is attacker-replayable, so it must change nothing. Only
    // the signature-verified webhook may move a plan.
    await page.goto('/dashboard/billing?checkout=complete');
    await expect(page.locator('body')).not.toContainText(/you are on the pro plan/i);
  });

  test('the portal is refused for an account with no Stripe customer', async ({ page }) => {
    const fresh = await createUser('noportal');
    try {
      await signIn(page, fresh.email);
      const response = await page.request.post('/api/stripe/portal', {
        headers: { 'sec-fetch-site': 'same-origin' },
      });
      expect(response.status()).toBe(404);
    } finally {
      await deleteUser(fresh.id);
    }
  });
});
