/**
 * Cross-site request forgery defence.
 *
 * Every mutating endpoint authenticates from a cookie, and `SameSite=Lax` — what
 * Supabase sets — still attaches that cookie to a top-level cross-site form
 * POST. So the cookie alone never proved the request came from this
 * application, and three endpoints were reachable that way: `/api/scans` accepts
 * `multipart/form-data` (no preflight, so a plain HTML form reaches it and burns
 * the victim's scan allowance), `/api/stripe/checkout` and `/api/stripe/portal`
 * read no body at all (so an empty form POST reaches them), and
 * `/api/auth/sign-out` could be fired to log somebody out at will.
 *
 * These tests pin the decision function. The Stripe webhook is deliberately not
 * covered by it — that route is server-to-server and is authenticated by a
 * signature over its raw body, and it carries no Origin header at all.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { resetEnvCache } from '../src/lib/env';
import { isSameOrigin } from '../src/lib/origin';

const APP_ORIGIN = 'https://upgrade.jacobryanlive.com';

beforeAll(() => {
  process.env.NEXT_PUBLIC_APP_URL = APP_ORIGIN;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';
  resetEnvCache();
});

function request(headers: Record<string, string>): Request {
  return new Request(`${APP_ORIGIN}/api/scans`, { method: 'POST', headers });
}

describe('Fetch Metadata is trusted first', () => {
  it('accepts a same-origin request', () => {
    expect(isSameOrigin(request({ 'sec-fetch-site': 'same-origin' }))).toBe(true);
  });

  it('refuses a cross-site request', () => {
    expect(isSameOrigin(request({ 'sec-fetch-site': 'cross-site' }))).toBe(false);
  });

  it('refuses a same-site request from a sibling subdomain', () => {
    // A subdomain is not this application, and on a shared parent domain it may
    // not even be under our control.
    expect(isSameOrigin(request({ 'sec-fetch-site': 'same-site' }))).toBe(false);
  });

  it('refuses a directly-initiated navigation', () => {
    // `none` means the user typed it or it came from a bookmark. Nothing in
    // this application performs a mutation that way.
    expect(isSameOrigin(request({ 'sec-fetch-site': 'none' }))).toBe(false);
  });

  it('is not fooled by an Origin header when Fetch Metadata contradicts it', () => {
    // Page script can set neither header, but a non-browser client can set
    // Origin freely. Sec-Fetch-Site is browser-controlled, so it wins.
    expect(
      isSameOrigin(request({ 'sec-fetch-site': 'cross-site', origin: APP_ORIGIN })),
    ).toBe(false);
  });
});

describe('Origin is the fallback for clients without Fetch Metadata', () => {
  it('accepts an exactly matching origin', () => {
    expect(isSameOrigin(request({ origin: APP_ORIGIN }))).toBe(true);
  });

  it('refuses a different host', () => {
    expect(isSameOrigin(request({ origin: 'https://evil.example' }))).toBe(false);
  });

  it('refuses a scheme downgrade on the right host', () => {
    expect(isSameOrigin(request({ origin: 'http://upgrade.jacobryanlive.com' }))).toBe(false);
  });

  it('refuses a subdomain of the real origin', () => {
    expect(isSameOrigin(request({ origin: 'https://evil.upgrade.jacobryanlive.com' }))).toBe(false);
  });

  it('refuses a prefix-matching lookalike domain', () => {
    // The check compares parsed origins, not string prefixes, so this domain —
    // which a `startsWith` would have accepted — is refused.
    expect(
      isSameOrigin(request({ origin: 'https://upgrade.jacobryanlive.com.evil.example' })),
    ).toBe(false);
  });

  it('refuses the literal string "null"', () => {
    // Sent by a sandboxed iframe or after a redirect chain.
    expect(isSameOrigin(request({ origin: 'null' }))).toBe(false);
  });

  it('refuses a malformed origin', () => {
    expect(isSameOrigin(request({ origin: 'not a url' }))).toBe(false);
  });
});

describe('a request proving nothing is refused', () => {
  it('refuses a request with neither header', () => {
    // Browsers always send Origin on POST. Only a non-browser client arrives
    // bare, and none of these endpoints is meant for one.
    expect(isSameOrigin(request({}))).toBe(false);
  });
});
