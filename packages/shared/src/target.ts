/**
 * The protocol revision the hosted service scans against.
 *
 * Duplicated from the scanner deliberately. The web app must not import
 * `mcp-upgrade`, because doing so pulls the scanning engine — and `node:fs`
 * with it — into a bundle that also serves browser code. The worker, which
 * depends on both packages, asserts that these values match the scanner's own,
 * so the duplication cannot drift silently.
 */
export const DEFAULT_TARGET_VERSION = '2026-07-28';
export const BASELINE_PROTOCOL_VERSION = '2025-11-25';

/** True when the target is a release candidate rather than a final spec. */
export const TARGET_IS_RELEASE_CANDIDATE = true;
