/**
 * Outbound request safety.
 *
 * The worker makes exactly two kinds of outbound request: the GitHub API and a
 * GitHub archive download. Both take a user-influenced value (owner and repo),
 * so both are treated as an SSRF vector.
 *
 * Two defences, and both are required:
 *
 *   1. The host must be on a fixed allow-list. This is checked on the initial
 *      URL and again on every redirect hop, because a redirect is a
 *      server-controlled URL and the allow-list is meaningless if only the
 *      first request is checked.
 *   2. The host's resolved addresses must all be public. A hostname on the
 *      allow-list that resolves to 169.254.169.254 is still an attack; DNS is
 *      not controlled by us, and DNS entries change between the check and the
 *      connection, so the connection itself is pinned to an address that was
 *      verified.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent } from 'undici';
import type { LookupAddress } from 'node:dns';
import { IngestionError } from './errors.js';

/** Hosts the worker may ever connect to. */
const ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  'api.github.com',
  'codeload.github.com',
  'github.com',
  'objects.githubusercontent.com',
]);

/**
 * True when an address is one a server should never be made to connect to:
 * loopback, private ranges, link-local (including the cloud metadata address),
 * carrier-grade NAT, multicast, broadcast and the various reserved blocks.
 */
export function isForbiddenAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isForbiddenIpv4(address);
  if (family === 6) return isForbiddenIpv6(address);
  // Not an IP literal at all — treat as unusable rather than allowed.
  return true;
}

function isForbiddenIpv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a = 0, b = 0] = parts;
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // RFC6598 carrier-grade NAT
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51) return true; // TEST-NET-2
  if (a === 203 && b === 0) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

function isForbiddenIpv6(address: string): boolean {
  const lower = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (lower === '::' || lower === '::1') return true; // unspecified, loopback
  if (lower.startsWith('fe80')) return true; // link-local
  if (/^f[cd]/.test(lower)) return true; // unique local
  if (lower.startsWith('ff')) return true; // multicast
  // IPv4-mapped and IPv4-compatible forms carry an embedded v4 address that
  // must be judged by the v4 rules, not waved through as "some IPv6 address".
  const mapped = /^(?:::ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped?.[1]) return isForbiddenIpv4(mapped[1]);
  if (lower.startsWith('64:ff9b:')) return true; // NAT64
  if (lower.startsWith('2001:db8')) return true; // documentation
  if (lower.startsWith('2002:')) return true; // 6to4, can encode a private v4
  return false;
}

export function isAllowedHost(hostname: string): boolean {
  return ALLOWED_HOSTS.has(hostname.toLowerCase());
}

export interface ValidatedTarget {
  url: URL;
  /** The verified address the connection is pinned to. */
  address: string;
  family: 4 | 6;
}

/**
 * The half of target validation that needs no network.
 *
 * Split out so it can be exercised exhaustively without DNS: scheme, embedded
 * credentials, port and the host allow-list are pure decisions about a string,
 * and they are the checks that reject the overwhelming majority of attacks.
 */
export function checkUrlShape(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new IngestionError('source_url_invalid', 'target is not a URL');
  }
  if (url.protocol !== 'https:') {
    throw new IngestionError('source_url_forbidden_host', 'target is not https');
  }
  if (url.username !== '' || url.password !== '') {
    throw new IngestionError('source_url_forbidden_host', 'target carries credentials');
  }
  if (url.port !== '' && url.port !== '443') {
    throw new IngestionError('source_url_forbidden_host', 'target uses a non-default port');
  }
  if (!isAllowedHost(url.hostname)) {
    throw new IngestionError('source_url_forbidden_host', 'target host is not on the allow-list');
  }
  return url;
}

/** Resolver seam. Tests substitute a deterministic one; production uses DNS. */
export type AddressResolver = (hostname: string) => Promise<LookupAddress[]>;

const defaultResolver: AddressResolver = (hostname) => dnsLookup(hostname, { all: true });

/**
 * Validates a URL's scheme, host and every resolved address.
 *
 * Returns the address the caller must actually connect to. Resolving here and
 * connecting to the returned address closes the window between the check and
 * the connection in which DNS could change beneath us.
 */
export async function validateTarget(
  rawUrl: string,
  resolver: AddressResolver = defaultResolver,
): Promise<ValidatedTarget> {
  const url = checkUrlShape(rawUrl);

  let addresses: LookupAddress[];
  try {
    addresses = await resolver(url.hostname);
  } catch {
    throw new IngestionError('source_download_failed', 'target host did not resolve');
  }
  if (addresses.length === 0) {
    throw new IngestionError('source_download_failed', 'target host resolved to no addresses');
  }
  // Every address must be acceptable, not just the one we pick. A host with one
  // public and one private address is a DNS-rebinding setup.
  for (const candidate of addresses) {
    if (isForbiddenAddress(candidate.address)) {
      throw new IngestionError(
        'source_url_forbidden_host',
        'target host resolves to a non-public address',
      );
    }
  }
  const chosen = addresses[0]!;
  return {
    url,
    address: chosen.address,
    family: chosen.family === 6 ? 6 : 4,
  };
}

export interface SafeFetchOptions {
  /** Maximum redirect hops. Each one is fully re-validated. */
  maxRedirects?: number;
  timeoutMs: number;
  headers?: Record<string, string>;
  /** Aborts the response body once this many bytes have arrived. */
  maxBytes?: number;
  signal?: AbortSignal;
  /**
   * Test seams. Production always uses the platform `fetch` and real DNS; a
   * test substitutes both so a redirect chain can be driven deterministically.
   * Substituting them does not weaken the checks — the allow-list and the
   * address rules run identically either way, which is exactly what the
   * redirect tests are asserting.
   */
  fetchImpl?: typeof fetch;
  resolver?: AddressResolver;
}

/**
 * `fetch` init carrying an undici dispatcher.
 *
 * Two copies of undici's type definitions are reachable here — the ones bundled
 * with `@types/node` and the ones shipped by the `undici` package the runtime
 * `Agent` comes from — and TypeScript treats their `Dispatcher` types as
 * unrelated. Widening just that one field, rather than casting the whole init
 * object through `unknown`, keeps `redirect`, `signal` and `headers` fully
 * type-checked while letting the dispatcher through.
 */
type PinnedFetchInit = Omit<RequestInit, 'dispatcher'> & { dispatcher: unknown };

export interface SafeResponse {
  status: number;
  headers: Headers;
  /** The final URL after redirects, already validated. */
  url: string;
  body: ReadableStream<Uint8Array> | null;
}

/**
 * Performs a request with redirects followed manually.
 *
 * `redirect: 'manual'` rather than `'follow'` is the point: the platform
 * follower would happily chase a `Location` pointing at the metadata service,
 * and we would never see the hop.
 */
export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions,
): Promise<SafeResponse> {
  const maxRedirects = options.maxRedirects ?? 5;
  let current = rawUrl;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const target = await validateTarget(current, options.resolver);

    // Pin the connection to the address that was just verified, while keeping
    // the SNI and Host header set to the real hostname so TLS still validates
    // against the certificate for that name.
    //
    // This must be an undici `Agent` passed as `dispatcher`, not a
    // `node:https.Agent` passed as `agent`. Node's global `fetch` is undici,
    // and undici ignores an unrecognised `agent` property in silence — so the
    // previous spelling compiled, ran, and pinned nothing at all. The check
    // above still rejected private addresses, but the connection that followed
    // did its own fresh DNS resolution, which is precisely the window a
    // rebinding attack aims for.
    const dispatcher = new Agent({
      connect: {
        lookup: (_hostname, _options, callback) => {
          callback(null, [{ address: target.address, family: target.family }]);
        },
      },
      pipelining: 0,
    });

    const controller = new AbortController();
    const abortOnOuter = (): void => controller.abort();
    options.signal?.addEventListener('abort', abortOnOuter, { once: true });
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);

    const doFetch = options.fetchImpl ?? fetch;
    const init: PinnedFetchInit = {
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        // A descriptive agent is required by the GitHub API and is good
        // manners for the archive host.
        'user-agent': 'mcp-upgrade-scanner (+https://github.com/JacobRyan258/mcp-upgrade)',
        accept: 'application/vnd.github+json',
        ...options.headers,
      },
      // `dispatcher` is the documented undici extension, and is what Node's
      // fetch actually reads. `agent` is silently discarded.
      dispatcher,
    };

    let response: Response;
    try {
      response = await doFetch(target.url, init as RequestInit);
    } catch (error) {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abortOnOuter);
      await dispatcher.close().catch(() => undefined);
      if (controller.signal.aborted) {
        throw new IngestionError('source_download_failed', 'the request timed out');
      }
      throw new IngestionError('source_download_failed', 'the request failed', { cause: error });
    }
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abortOnOuter);

    const isRedirect = response.status >= 300 && response.status < 400;
    if (!isRedirect) {
      // The dispatcher owns the socket the body is still streaming over, so it
      // cannot be closed here — doing so truncates the archive mid-download.
      // Ownership is handed to the body instead: whoever finishes, cancels or
      // errors the stream releases the connection. A response with no body has
      // nothing left to wait for and is released immediately.
      return {
        status: response.status,
        headers: response.headers,
        url: target.url.toString(),
        body: response.body ? releaseWhenDone(response.body, dispatcher) : null,
      };
    }

    const location = response.headers.get('location');
    // Drain the redirect body so the socket is not left half-read, then release
    // this hop's dispatcher: the next hop resolves and pins a fresh address.
    await response.body?.cancel().catch(() => undefined);
    await dispatcher.close().catch(() => undefined);
    if (!location) {
      throw new IngestionError('source_download_failed', 'redirect without a location');
    }
    // Resolve relative redirects against the current URL, then re-validate from
    // scratch on the next iteration.
    try {
      current = new URL(location, target.url).toString();
    } catch {
      throw new IngestionError('source_url_forbidden_host', 'redirect location is not a URL');
    }
  }

  throw new IngestionError('source_download_failed', 'too many redirects');
}

/**
 * Ties a dispatcher's lifetime to the response body streaming over it.
 *
 * Without this the per-request agent would be left for the garbage collector,
 * which under a backlog means sockets accumulating faster than they are
 * reclaimed. `destroy` rather than `close` on the abnormal paths, because a
 * cancelled download should drop the connection rather than wait politely for
 * an upstream that may never finish sending.
 */
function releaseWhenDone(
  body: ReadableStream<Uint8Array>,
  dispatcher: Agent,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          await dispatcher.close().catch(() => undefined);
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
        await dispatcher.destroy().catch(() => undefined);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
      await dispatcher.destroy().catch(() => undefined);
    },
  });
}
