import { expect, test } from '@playwright/test';

/**
 * The authorization boundary, exercised through a real browser.
 *
 * Everything here is decided before a user exists, which is what makes it
 * runnable without credentials — and what makes it the most valuable suite to
 * run on every commit. A regression in any of these is a security defect, not a
 * cosmetic one.
 */

const UUID_A = '11111111-1111-4111-8111-111111111111';

test.describe('the dashboard is closed to anonymous visitors', () => {
  for (const path of ['/dashboard', '/dashboard/billing', `/dashboard/scans/${UUID_A}`]) {
    test(`redirects ${path} to sign-in`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/sign-in/);
      // The destination is preserved so the user lands where they were going.
      expect(new URL(page.url()).searchParams.get('next')).toBe(path);
    });
  }
});

test.describe('the API refuses anonymous callers', () => {
  test('GET a scan status is 401, not 404 or 500', async ({ request }) => {
    const response = await request.get(`/api/scans/${UUID_A}`);
    expect(response.status()).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'unauthorized' });
  });

  test('GET a report download is 401', async ({ request }) => {
    const response = await request.get(`/api/scans/${UUID_A}/download?format=json`);
    expect(response.status()).toBe(401);
  });

  test('POST a scan is refused', async ({ request }) => {
    // No Origin header at all: the forgery check refuses this before auth is
    // even consulted, so 403 rather than 401 is the correct answer.
    const response = await request.post('/api/scans', {
      data: { repositoryUrl: 'https://github.com/owner/repository' },
    });
    expect([401, 403]).toContain(response.status());
  });
});

test.describe('cross-site request forgery is refused', () => {
  // `SameSite=Lax` still attaches the session cookie to a top-level cross-site
  // form POST, so these endpoints need an origin check of their own. Each
  // request below carries a foreign Origin, exactly as a browser would send it
  // from an attacker's page.
  const forged = { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' };

  test('a forged scan submission is refused', async ({ request }) => {
    const response = await request.post('/api/scans', {
      headers: forged,
      data: { repositoryUrl: 'https://github.com/owner/repository' },
    });
    expect(response.status()).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'forbidden' });
  });

  test('a forged multipart upload is refused before the body is read', async ({ request }) => {
    // multipart/form-data is a CORS-simple content type, so a plain HTML form
    // on any site could send this. It was the cheapest way to burn a signed-in
    // visitor's scan allowance.
    const response = await request.post('/api/scans', {
      headers: forged,
      multipart: {
        file: { name: 'x.zip', mimeType: 'application/zip', buffer: Buffer.from('PK') },
      },
    });
    expect(response.status()).toBe(403);
  });

  test('a forged checkout is refused', async ({ request }) => {
    // This handler reads no body, so an empty cross-site form POST reached it.
    const response = await request.post('/api/stripe/checkout', { headers: forged });
    expect(response.status()).toBe(403);
  });

  test('a forged billing-portal request is refused', async ({ request }) => {
    const response = await request.post('/api/stripe/portal', { headers: forged });
    expect(response.status()).toBe(403);
  });

  test('a forged sign-out is refused', async ({ request }) => {
    const response = await request.post('/api/auth/sign-out', {
      headers: forged,
      maxRedirects: 0,
    });
    expect(response.status()).toBe(403);
  });

  test('a same-origin request is not caught by the check', async ({ request, baseURL }) => {
    // The check must refuse forgeries without breaking the application itself:
    // a genuine same-origin call gets past it and is refused on authentication
    // instead, which proves the 403s above are about origin and not about the
    // endpoint being broken.
    const response = await request.post('/api/stripe/checkout', {
      headers: { origin: baseURL!, 'sec-fetch-site': 'same-origin' },
    });
    expect(response.status()).toBe(401);
  });
});

test.describe('the Stripe webhook authenticates by signature, not by origin', () => {
  test('an unsigned payload is refused', async ({ request }) => {
    const response = await request.post('/api/stripe/webhook', {
      data: { id: 'evt_forged', type: 'customer.subscription.updated' },
    });
    // 400 when billing is configured and the signature is missing, 503 when it
    // is not configured at all. Never 200, and never a processed event.
    expect([400, 503]).toContain(response.status());
  });

  test('a forged signature is refused', async ({ request }) => {
    const response = await request.post('/api/stripe/webhook', {
      headers: { 'stripe-signature': 't=1,v1=deadbeef' },
      data: { id: 'evt_forged', type: 'customer.subscription.updated' },
    });
    expect([400, 503]).toContain(response.status());
  });

  test('the webhook is not reachable by GET', async ({ request }) => {
    const response = await request.get('/api/stripe/webhook');
    expect(response.status()).toBe(405);
  });
});

test.describe('the auth callback cannot be turned into a phishing hop', () => {
  for (const [label, next] of [
    ['an absolute external URL', 'https://evil.example/steal'],
    ['a protocol-relative URL', '//evil.example/steal'],
    ['a backslash-smuggled URL', '/\\evil.example'],
  ] as const) {
    test(`refuses ${label} and stays on this origin`, async ({ page }) => {
      // No code is supplied, so the handler redirects to sign-in. What matters
      // is that it never leaves this origin for an attacker-supplied one.
      //
      // The host is compared rather than the whole base URL: Next normalises
      // 127.0.0.1 to localhost when it builds the redirect, so an exact string
      // match would fail on a correct redirect.
      await page.goto(`/auth/callback?next=${encodeURIComponent(next)}`);
      const landed = new URL(page.url());
      expect(['localhost', '127.0.0.1']).toContain(landed.hostname);
      expect(page.url()).not.toContain('evil.example');
      // And it landed on the sign-in page, not on the attacker's path.
      expect(landed.pathname).toBe('/sign-in');
    });
  }
});

test.describe('malformed identifiers are rejected without leaking', () => {
  for (const id of ['not-a-uuid', '../../etc/passwd', '00000000-0000-0000-0000-00000000000']) {
    test(`refuses ${id}`, async ({ request }) => {
      const response = await request.get(`/api/scans/${encodeURIComponent(id)}`);
      // Unauthenticated, so 401 comes first; the point is that nothing 500s and
      // nothing reveals whether the id could ever have existed.
      expect([400, 401, 404]).toContain(response.status());
    });
  }
});
