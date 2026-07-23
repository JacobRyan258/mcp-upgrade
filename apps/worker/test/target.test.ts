/**
 * The web app cannot import the scanner — doing so would pull the scanning
 * engine and `node:fs` into a bundle that also serves browser code — so the
 * target protocol version is declared in the shared package too.
 *
 * The worker depends on both, which makes it the only place that can prove the
 * two declarations agree. If they ever diverge, jobs would be created for one
 * target and scanned against another, and the report would quietly describe a
 * different specification from the one requested.
 */
import { describe, expect, it } from 'vitest';
import {
  BASELINE_PROTOCOL_VERSION as SCANNER_BASELINE,
  DEFAULT_TARGET_VERSION as SCANNER_TARGET,
} from 'mcp-upgrade';
import {
  BASELINE_PROTOCOL_VERSION as SHARED_BASELINE,
  DEFAULT_TARGET_VERSION as SHARED_TARGET,
} from '@mcp-upgrade/shared';

describe('the shared target constants match the scanner', () => {
  it('agrees on the target protocol version', () => {
    expect(SHARED_TARGET).toBe(SCANNER_TARGET);
  });

  it('agrees on the baseline protocol version', () => {
    expect(SHARED_BASELINE).toBe(SCANNER_BASELINE);
  });
});
