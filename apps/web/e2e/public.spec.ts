import { expect, test } from '@playwright/test';

/**
 * The public site.
 *
 * Renders, headers, and the handful of promises the marketing pages make that
 * the product has to keep. Nothing here needs an account.
 */

test.describe('the marketing pages render', () => {
  for (const [path, heading] of [
    ['/', /MCP/i],
    ['/pricing', /pricing|plan/i],
    ['/how-it-works', /how it works/i],
    ['/faq', /question/i],
    ['/coverage', /coverage|rule/i],
    ['/privacy', /privacy/i],
    ['/terms', /terms/i],
  ] as const) {
    test(`${path} responds and shows a heading`, async ({ page }) => {
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      await expect(page.locator('h1').first()).toBeVisible();
      await expect(page.locator('body')).toContainText(heading);
    });
  }

  test('an unknown path is a 404, not a crash', async ({ page }) => {
    const response = await page.goto('/no-such-page');
    expect(response?.status()).toBe(404);
  });
});

test.describe('the sign-in and sign-up pages are reachable', () => {
  for (const path of ['/sign-in', '/sign-up']) {
    test(`${path} renders a working form`, async ({ page }) => {
      await page.goto(path);
      await expect(page.locator('input[type="email"]')).toBeVisible();
      await expect(page.locator('input[type="password"]')).toBeVisible();
      await expect(page.locator('button[type="submit"]')).toBeEnabled();
    });
  }

  test('sign-up rejects a short password before contacting the auth server', async ({ page }) => {
    await page.goto('/sign-up');
    await page.locator('input[type="email"]').fill('someone@example.com');
    await page.locator('input[type="password"]').fill('short');
    await page.locator('button[type="submit"]').click();
    await expect(page.locator('body')).toContainText(/at least 10 characters/i);
  });
});

test.describe('security headers are set on every response', () => {
  test('the document carries the full header set', async ({ page }) => {
    const response = await page.goto('/');
    const headers = response!.headers();

    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['strict-transport-security']).toContain('max-age=');
    expect(headers['permissions-policy']).toContain('camera=()');

    const csp = headers['content-security-policy'] ?? '';
    // The report renders content that originated in somebody else's source, so
    // these three are the ones that matter most.
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("default-src 'self'");
  });

  test('the framework version is not advertised', async ({ page }) => {
    const response = await page.goto('/');
    expect(response!.headers()['x-powered-by']).toBeUndefined();
  });
});

test.describe('no server secret reaches the browser', () => {
  test('the rendered page and its scripts carry no server-only value', async ({ page }) => {
    const scripts: string[] = [];
    page.on('response', async (response) => {
      const type = response.headers()['content-type'] ?? '';
      if (type.includes('javascript') && response.status() === 200) {
        scripts.push(await response.text().catch(() => ''));
      }
    });

    const pages: string[] = [];
    for (const path of ['/', '/pricing', '/sign-in']) {
      await page.goto(path, { waitUntil: 'networkidle' });
      pages.push(await page.content());
    }

    // `/sign-in` is included deliberately: it is the page that instantiates the
    // browser Supabase client, so it is where a server key would actually show
    // up if one were ever swapped in for the anon key.
    const everything = [...pages, ...scripts].join('\n');

    // Every Supabase key is a JWT whose payload names the role it carries, so
    // the check decodes them rather than grepping for the word "service_role" —
    // which appears in @supabase/supabase-js's own JSDoc and would make this
    // test cry wolf on every run while telling us nothing about actual keys.
    const roles = new Set<string>();
    for (const token of everything.match(/eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g) ?? []) {
      try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));
        if (typeof payload.role === 'string') roles.add(payload.role);
      } catch {
        // Not a Supabase key. Anything undecodable carries no role to leak.
      }
    }

    // The service-role key bypasses row level security entirely. It reaching a
    // browser would be a total compromise of every user's data.
    expect([...roles]).not.toContain('service_role');
    // The anon key is public by design, and its presence proves this test is
    // actually looking at the bundle rather than at an empty string.
    expect([...roles]).toContain('anon');

    // The remaining server-only values have no ambiguous spelling.
    expect(everything).not.toContain('postgresql://');
    expect(everything).not.toMatch(/sk_(test|live)_/);
    expect(everything).not.toMatch(/whsec_/);
    // The worker shared secret, read from the environment this test runs in.
    const workerSecret = process.env.WORKER_SHARED_SECRET;
    if (workerSecret && workerSecret.length >= 32) {
      expect(everything).not.toContain(workerSecret);
    }
  });
});
