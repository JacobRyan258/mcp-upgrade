/**
 * Server-side request forgery defences.
 *
 * The attacker's goal is to make the worker issue a request to something inside
 * our network — most valuably the cloud metadata endpoint at 169.254.169.254,
 * which hands out instance credentials to anything that asks.
 *
 * The two ways in are the initial URL and a redirect, so both are tested. The
 * redirect tests substitute the fetch implementation and the DNS resolver, so
 * a chain can be driven deterministically; the allow-list and address rules
 * under test are the real ones, unchanged.
 */
import { describe, expect, it, vi } from 'vitest';
import type { LookupAddress } from 'node:dns';
import { checkUrlShape, isAllowedHost, isForbiddenAddress, safeFetch, validateTarget } from '../src/net.js';
import { IngestionError } from '../src/errors.js';

function categoryOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof IngestionError) return error.category;
    return `unexpected:${String(error)}`;
  }
  return 'no-throw';
}

async function asyncCategoryOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof IngestionError) return error.category;
    return `unexpected:${String(error)}`;
  }
  return 'no-throw';
}

describe('address classification', () => {
  const forbidden = [
    // Loopback and unspecified.
    '127.0.0.1', '127.1.2.3', '0.0.0.0', '0.1.2.3',
    // The prize: cloud instance metadata.
    '169.254.169.254', '169.254.0.1',
    // RFC1918.
    '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.0.1',
    // Carrier-grade NAT.
    '100.64.0.1', '100.127.255.255',
    // Reserved and documentation.
    '192.0.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1',
    // Multicast and broadcast.
    '224.0.0.1', '239.255.255.255', '255.255.255.255',
    // IPv6.
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:169.254.169.254', '::ffff:10.0.0.1',
    '64:ff9b::1', '2001:db8::1', '2002:c0a8:0001::1',
    // Not addresses at all.
    'localhost', 'metadata.google.internal', 'not-an-ip', '',
  ];

  for (const address of forbidden) {
    it(`refuses ${address || '(empty)'}`, () => {
      expect(isForbiddenAddress(address)).toBe(true);
    });
  }

  const allowed = ['140.82.121.4', '8.8.8.8', '1.1.1.1', '185.199.108.153', '2606:50c0:8000::153'];
  for (const address of allowed) {
    it(`allows public address ${address}`, () => {
      expect(isForbiddenAddress(address)).toBe(false);
    });
  }
});

describe('host allow-list', () => {
  it('accepts exactly the GitHub hosts the worker needs', () => {
    for (const host of [
      'api.github.com',
      'codeload.github.com',
      'github.com',
      'objects.githubusercontent.com',
    ]) {
      expect(isAllowedHost(host)).toBe(true);
      expect(isAllowedHost(host.toUpperCase())).toBe(true);
    }
  });

  it('rejects lookalikes, subdomains and everything else', () => {
    for (const host of [
      'evil.com',
      'github.com.evil.com',
      'notgithub.com',
      'raw.githubusercontent.com',
      'gist.github.com',
      'localhost',
      '169.254.169.254',
      'metadata.google.internal',
      '',
    ]) {
      expect(isAllowedHost(host)).toBe(false);
    }
  });
});

describe('URL shape checks need no network', () => {
  it('accepts a canonical GitHub API URL', () => {
    expect(checkUrlShape('https://api.github.com/repos/o/r').hostname).toBe('api.github.com');
  });

  it('rejects non-https schemes', () => {
    expect(categoryOf(() => checkUrlShape('http://api.github.com/x'))).toBe('source_url_forbidden_host');
    expect(categoryOf(() => checkUrlShape('file:///etc/passwd'))).toBe('source_url_forbidden_host');
    expect(categoryOf(() => checkUrlShape('gopher://api.github.com/x'))).toBe('source_url_forbidden_host');
    expect(categoryOf(() => checkUrlShape('ftp://api.github.com/x'))).toBe('source_url_forbidden_host');
  });

  it('rejects embedded credentials', () => {
    expect(categoryOf(() => checkUrlShape('https://user:pw@api.github.com/x'))).toBe(
      'source_url_forbidden_host',
    );
  });

  it('rejects a non-default port even on an allowed host', () => {
    expect(categoryOf(() => checkUrlShape('https://api.github.com:8080/x'))).toBe(
      'source_url_forbidden_host',
    );
    expect(categoryOf(() => checkUrlShape('https://api.github.com:22/x'))).toBe(
      'source_url_forbidden_host',
    );
  });

  it('rejects internal hosts outright', () => {
    for (const url of [
      'https://169.254.169.254/latest/meta-data/',
      'https://localhost/x',
      'https://127.0.0.1/x',
      'https://[::1]/x',
      'https://10.0.0.1/x',
      'https://metadata.google.internal/computeMetadata/v1/',
    ]) {
      expect(categoryOf(() => checkUrlShape(url))).toBe('source_url_forbidden_host');
    }
  });

  it('rejects garbage', () => {
    expect(categoryOf(() => checkUrlShape('not a url'))).toBe('source_url_invalid');
  });
});

describe('DNS results are validated, not trusted', () => {
  const resolver = (addresses: string[]) => async (): Promise<LookupAddress[]> =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

  it('accepts an allowed host resolving to a public address', async () => {
    const target = await validateTarget(
      'https://api.github.com/repos/o/r',
      resolver(['140.82.121.4']),
    );
    expect(target.address).toBe('140.82.121.4');
    expect(target.family).toBe(4);
  });

  it('rejects an allowed host that resolves to the metadata address', async () => {
    expect(
      await asyncCategoryOf(
        validateTarget('https://api.github.com/x', resolver(['169.254.169.254'])),
      ),
    ).toBe('source_url_forbidden_host');
  });

  it('rejects an allowed host that resolves to loopback', async () => {
    expect(
      await asyncCategoryOf(validateTarget('https://codeload.github.com/x', resolver(['127.0.0.1']))),
    ).toBe('source_url_forbidden_host');
  });

  it('rejects a rebinding setup where only one address is private', async () => {
    // A host answering with both a public and a private address is the classic
    // DNS-rebinding shape: the check might see the public one and the
    // connection might use the private one.
    expect(
      await asyncCategoryOf(
        validateTarget('https://api.github.com/x', resolver(['140.82.121.4', '10.0.0.5'])),
      ),
    ).toBe('source_url_forbidden_host');
  });

  it('rejects a host that resolves to nothing', async () => {
    expect(await asyncCategoryOf(validateTarget('https://api.github.com/x', resolver([])))).toBe(
      'source_download_failed',
    );
  });

  it('rejects a host whose resolution fails', async () => {
    expect(
      await asyncCategoryOf(
        validateTarget('https://api.github.com/x', async () => {
          throw new Error('ENOTFOUND');
        }),
      ),
    ).toBe('source_download_failed');
  });
});

describe('redirects are re-validated on every hop', () => {
  const publicResolver = async (): Promise<LookupAddress[]> => [
    { address: '140.82.121.4', family: 4 },
  ];

  function redirectingFetch(chain: Array<{ status: number; location?: string }>): typeof fetch {
    let index = 0;
    return vi.fn(async () => {
      const step = chain[Math.min(index, chain.length - 1)];
      index += 1;
      const headers = new Headers();
      if (step?.location) headers.set('location', step.location);
      return new Response(step?.status === 200 ? 'ok' : null, {
        status: step?.status ?? 200,
        headers,
      });
    }) as unknown as typeof fetch;
  }

  it('follows a redirect between two allowed hosts', async () => {
    const response = await safeFetch('https://codeload.github.com/o/r/zip/abc', {
      timeoutMs: 5_000,
      fetchImpl: redirectingFetch([
        { status: 302, location: 'https://objects.githubusercontent.com/archive.zip' },
        { status: 200 },
      ]),
      resolver: publicResolver,
    });
    expect(response.status).toBe(200);
    expect(response.url).toBe('https://objects.githubusercontent.com/archive.zip');
  });

  it('refuses a redirect to the cloud metadata service', async () => {
    expect(
      await asyncCategoryOf(
        safeFetch('https://api.github.com/repos/o/r', {
          timeoutMs: 5_000,
          fetchImpl: redirectingFetch([
            { status: 302, location: 'https://169.254.169.254/latest/meta-data/iam/' },
          ]),
          resolver: publicResolver,
        }),
      ),
    ).toBe('source_url_forbidden_host');
  });

  it('refuses a redirect to a private address', async () => {
    for (const location of [
      'https://10.0.0.1/internal',
      'https://192.168.1.1/admin',
      'https://127.0.0.1:8080/',
      'https://[::1]/',
    ]) {
      expect(
        await asyncCategoryOf(
          safeFetch('https://api.github.com/repos/o/r', {
            timeoutMs: 5_000,
            fetchImpl: redirectingFetch([{ status: 302, location }]),
            resolver: publicResolver,
          }),
        ),
      ).toBe('source_url_forbidden_host');
    }
  });

  it('refuses a redirect to an unrelated public host', async () => {
    expect(
      await asyncCategoryOf(
        safeFetch('https://api.github.com/repos/o/r', {
          timeoutMs: 5_000,
          fetchImpl: redirectingFetch([{ status: 302, location: 'https://evil.example/collect' }]),
          resolver: publicResolver,
        }),
      ),
    ).toBe('source_url_forbidden_host');
  });

  it('refuses a redirect that downgrades the scheme', async () => {
    expect(
      await asyncCategoryOf(
        safeFetch('https://api.github.com/repos/o/r', {
          timeoutMs: 5_000,
          fetchImpl: redirectingFetch([{ status: 302, location: 'http://api.github.com/x' }]),
          resolver: publicResolver,
        }),
      ),
    ).toBe('source_url_forbidden_host');
  });

  it('refuses a redirect to a non-HTTP scheme', async () => {
    for (const location of ['file:///etc/passwd', 'gopher://evil.example/', 'data:text/plain,x']) {
      expect(
        await asyncCategoryOf(
          safeFetch('https://api.github.com/repos/o/r', {
            timeoutMs: 5_000,
            fetchImpl: redirectingFetch([{ status: 302, location }]),
            resolver: publicResolver,
          }),
        ),
      ).toBe('source_url_forbidden_host');
    }
  });

  it('refuses a redirect chain that never terminates', async () => {
    expect(
      await asyncCategoryOf(
        safeFetch('https://api.github.com/repos/o/r', {
          timeoutMs: 5_000,
          maxRedirects: 3,
          fetchImpl: redirectingFetch([
            { status: 302, location: 'https://api.github.com/loop' },
          ]),
          resolver: publicResolver,
        }),
      ),
    ).toBe('source_download_failed');
  });

  it('refuses a redirect with no location header', async () => {
    expect(
      await asyncCategoryOf(
        safeFetch('https://api.github.com/repos/o/r', {
          timeoutMs: 5_000,
          fetchImpl: redirectingFetch([{ status: 302 }]),
          resolver: publicResolver,
        }),
      ),
    ).toBe('source_download_failed');
  });

  it('resolves a relative redirect against the current URL and still validates it', async () => {
    const response = await safeFetch('https://api.github.com/repos/o/r', {
      timeoutMs: 5_000,
      fetchImpl: redirectingFetch([
        { status: 301, location: '/repos/o/r/commits/main' },
        { status: 200 },
      ]),
      resolver: publicResolver,
    });
    expect(response.url).toBe('https://api.github.com/repos/o/r/commits/main');
  });

  it('re-runs the DNS check on the redirect target, not just the first host', async () => {
    // First hop resolves publicly, second resolves to loopback. Validating only
    // the initial URL would let this through.
    let call = 0;
    const flipFlopResolver = async (): Promise<LookupAddress[]> => {
      call += 1;
      return call === 1
        ? [{ address: '140.82.121.4', family: 4 }]
        : [{ address: '127.0.0.1', family: 4 }];
    };
    expect(
      await asyncCategoryOf(
        safeFetch('https://api.github.com/repos/o/r', {
          timeoutMs: 5_000,
          fetchImpl: redirectingFetch([
            { status: 302, location: 'https://codeload.github.com/o/r/zip/abc' },
            { status: 200 },
          ]),
          resolver: flipFlopResolver,
        }),
      ),
    ).toBe('source_url_forbidden_host');
  });
});

/**
 * Connection pinning.
 *
 * `validateTarget` proves every resolved address is public, then `safeFetch` is
 * supposed to connect to the address it just verified rather than resolving the
 * hostname a second time. Without that, the gap between the check and the
 * connect is a DNS-rebinding window: the same name answers with a public
 * address for the check and a private one for the connection.
 *
 * This regressed silently once already. The pinning was expressed as a
 * `node:https.Agent` passed in an `agent` field, but Node's global fetch is
 * undici, which reads `dispatcher` and ignores `agent` without complaint. The
 * code compiled, every existing test passed, and nothing was pinned. These two
 * tests fail against that spelling: the first proves the mechanism actually
 * diverts a connection, the second proves `safeFetch` uses that mechanism.
 */
describe('the connection is pinned to the verified address', () => {
  it('honours a dispatcher lookup, so a pinned address really is where we connect', async () => {
    const { createServer } = await import('node:http');
    const { Agent } = await import('undici');

    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('reached-the-pinned-server');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    let lookupCalls = 0;
    const dispatcher = new Agent({
      connect: {
        lookup: (_hostname, _options, callback) => {
          lookupCalls += 1;
          callback(null, [{ address: '127.0.0.1', family: 4 }]);
        },
      },
      pipelining: 0,
    });

    try {
      // A hostname that does not resolve to 127.0.0.1 by any normal means. If
      // the dispatcher is ignored, this cannot reach the local server at all.
      const response = await fetch(`http://pinning-probe.invalid:${port}/`, {
        dispatcher,
      } as unknown as RequestInit);
      expect(await response.text()).toBe('reached-the-pinned-server');
      expect(lookupCalls).toBeGreaterThan(0);
    } finally {
      await dispatcher.close().catch(() => undefined);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('passes a dispatcher to fetch, never a bare `agent` that undici discards', async () => {
    let seen: RequestInit | undefined;
    const capturingFetch = vi.fn(async (_url: unknown, init: RequestInit) => {
      seen = init;
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;

    await safeFetch('https://api.github.com/repos/o/r', {
      timeoutMs: 5_000,
      fetchImpl: capturingFetch,
      resolver: async () => [{ address: '140.82.121.4', family: 4 }],
    });

    const init = seen as (RequestInit & { dispatcher?: unknown; agent?: unknown }) | undefined;
    expect(init?.dispatcher).toBeDefined();
    expect(init?.agent).toBeUndefined();
  });
});
