/**
 * Every Next.js route that exists on disk must be committed to git.
 *
 * Regression guard for a real production 404: `.gitignore` had a bare
 * `coverage/` rule (intended for test-coverage output) that also matched the
 * `src/app/coverage/` route, so the public "Coverage" page built locally but was
 * never in the deployed tree — every "Coverage" nav link 404'd in production.
 *
 * A route file present on disk but absent from `git ls-files` will never reach
 * Vercel (which builds from the committed tree), so this asserts the two agree.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // apps/web/test
const appDir = join(here, '..', 'src', 'app');
const repoRoot = execSync('git rev-parse --show-toplevel', { cwd: here }).toString().trim();

// Next.js special files that define a routable or rendered segment.
const ROUTE_FILE = /^(page|route|layout|template|default|loading|error|not-found|global-error)\.(t|j)sx?$/;

function walkRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkRouteFiles(full));
    else if (ROUTE_FILE.test(entry.name)) out.push(full);
  }
  return out;
}

const toRepoRel = (p: string) => relative(repoRoot, p).split(sep).join('/');

const routeFiles = walkRouteFiles(appDir);
const tracked = new Set(
  execSync('git ls-files apps/web/src/app', { cwd: repoRoot })
    .toString()
    .split('\n')
    .filter(Boolean),
);

describe('every route on disk is committed to git', () => {
  it('actually discovers route files (guard against a broken walk)', () => {
    expect(routeFiles.length).toBeGreaterThan(0);
  });

  for (const file of routeFiles) {
    const rel = toRepoRel(file);
    it(`${rel} is tracked`, () => {
      expect(
        tracked.has(rel),
        `${rel} exists on disk but is not tracked by git, so it will 404 in production. Check .gitignore for a rule matching this path.`,
      ).toBe(true);
    });
  }
});
