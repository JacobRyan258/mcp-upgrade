/**
 * Cross-site request forgery defence for state-changing route handlers.
 *
 * Every mutating endpoint in this application authenticates from a cookie, and
 * a cookie rides along on a cross-site request whether or not the other site
 * can read the reply. `SameSite=Lax` — which is what Supabase sets — stops
 * cross-site *subresource* requests but explicitly still sends the cookie on a
 * top-level form POST, so it is not sufficient on its own.
 *
 * That gap is reachable in practice. `POST /api/scans` accepts
 * `multipart/form-data`, which a plain HTML form can produce with no preflight,
 * so any page on the internet could have burned a signed-in visitor's scan
 * allowance. `POST /api/stripe/checkout` and `/api/stripe/portal` read no body
 * at all, so an empty cross-site form POST reached them too, and
 * `/api/auth/sign-out` could be used to log somebody out at will. The attacker
 * never reads the response — CORS stops that — but the side effect has already
 * happened, and a side effect is the whole point of a forgery.
 *
 * Two independent signals, checked in that order:
 *
 *   1. `Sec-Fetch-Site`, set by the browser itself and unforgeable by page
 *      script. `same-origin` is the only acceptable value. `same-site` is
 *      refused as well: a sibling subdomain is not this application.
 *   2. `Origin`, compared against the configured canonical URL. This is the
 *      fallback for clients that do not send Fetch Metadata.
 *
 * A request carrying neither header is refused. Browsers always send `Origin`
 * on POST, so the only callers this turns away are non-browser clients, which
 * have no business at these endpoints — and the Stripe webhook, which is
 * deliberately not wrapped in this check because it is a server-to-server call
 * authenticated by a signature over its body rather than by a cookie.
 */
import { readPublicEnv } from './env';

export function isSameOrigin(request: Request): boolean {
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite) return fetchSite === 'same-origin';

  const origin = request.headers.get('origin');
  if (!origin) return false;

  try {
    return new URL(origin).origin === new URL(readPublicEnv().NEXT_PUBLIC_APP_URL).origin;
  } catch {
    return false;
  }
}
