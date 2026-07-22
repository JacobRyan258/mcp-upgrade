import { describe, expect, it } from 'vitest';
import { commitUrl, isCommitSha, parseGitHubRepoUrl, shortSha } from '../src/github.js';

function reject(input: unknown): string {
  const result = parseGitHubRepoUrl(input);
  expect(result.ok, `expected rejection for ${JSON.stringify(input)}`).toBe(false);
  return result.ok ? '' : result.reason;
}

function accept(input: string) {
  const result = parseGitHubRepoUrl(input);
  expect(result.ok, `expected acceptance for ${input}`).toBe(true);
  if (!result.ok) throw new Error('unreachable');
  return result.value;
}

describe('parseGitHubRepoUrl — accepted forms', () => {
  it('normalizes the canonical form', () => {
    expect(accept('https://github.com/JacobRyan258/mcp-upgrade')).toEqual({
      owner: 'JacobRyan258',
      repo: 'mcp-upgrade',
      normalizedUrl: 'https://github.com/JacobRyan258/mcp-upgrade',
      slug: 'JacobRyan258/mcp-upgrade',
    });
  });

  it('accepts trailing slashes, .git suffixes, www and a bare host', () => {
    for (const input of [
      'https://github.com/owner/repo/',
      'https://github.com/owner/repo.git',
      'https://www.github.com/owner/repo',
      'github.com/owner/repo',
      '  https://github.com/owner/repo  ',
      'http://github.com/owner/repo',
    ]) {
      expect(accept(input).normalizedUrl).toBe('https://github.com/owner/repo');
    }
  });

  it('preserves owner and repository case', () => {
    const value = accept('https://github.com/OwNeR/RePo');
    expect(value.slug).toBe('OwNeR/RePo');
  });

  it('accepts periods, underscores and hyphens in repository names', () => {
    expect(accept('https://github.com/o/my_repo.v2-beta').repo).toBe('my_repo.v2-beta');
  });

  it('does not mistake a repository named "sample" for a whitespace match', () => {
    expect(accept('https://github.com/owner/sample').repo).toBe('sample');
  });
});

describe('parseGitHubRepoUrl — SSRF and host confusion', () => {
  it('rejects every non-GitHub host', () => {
    expect(reject('https://gitlab.com/owner/repo')).toBe('forbidden-host');
    expect(reject('https://github.com.evil.example/owner/repo')).toBe('forbidden-host');
    expect(reject('https://evilgithub.com/owner/repo')).toBe('forbidden-host');
    expect(reject('https://raw.githubusercontent.com/o/r')).toBe('forbidden-host');
    expect(reject('https://api.github.com/repos/o/r')).toBe('forbidden-host');
  });

  it('rejects loopback, private and link-local targets', () => {
    for (const host of [
      'localhost',
      '127.0.0.1',
      '[::1]',
      '169.254.169.254',
      '10.0.0.5',
      '192.168.1.1',
      '172.16.0.1',
      'metadata.google.internal',
    ]) {
      expect(reject(`https://${host}/owner/repo`)).toBe('forbidden-host');
    }
  });

  it('rejects credentials embedded in the URL', () => {
    expect(reject('https://user:token@github.com/owner/repo')).toBe('credentials-in-url');
    expect(reject('https://token@github.com/owner/repo')).toBe('credentials-in-url');
  });

  it('rejects an explicit port even on the allowed host', () => {
    expect(reject('https://github.com:8080/owner/repo')).toBe('non-default-port');
    // The default port stated explicitly is still explicit, but `URL` normalises
    // it away, so it is accepted — assert that behaviour rather than assume it.
    expect(accept('https://github.com:443/owner/repo').slug).toBe('owner/repo');
  });

  it('rejects non-HTTP schemes and SSH forms', () => {
    expect(reject('git://github.com/owner/repo.git')).toBe('bad-scheme');
    expect(reject('ssh://git@github.com/owner/repo.git')).toBe('bad-scheme');
    expect(reject('git@github.com:owner/repo.git')).toBe('bad-scheme');
    expect(reject('file:///etc/passwd')).toBe('bad-scheme');
    expect(reject('javascript:alert(1)')).toBe('bad-scheme');
    expect(reject('data:text/plain,hello')).toBe('bad-scheme');
  });

  it('rejects unicode and case tricks on the host', () => {
    // Punycode resolution means a homograph host is not github.com.
    expect(reject('https://githυb.com/owner/repo')).toBe('forbidden-host');
    // Uppercase hosts normalise, so this one is genuinely GitHub.
    expect(accept('https://GITHUB.COM/owner/repo').slug).toBe('owner/repo');
  });
});

describe('parseGitHubRepoUrl — path handling', () => {
  it('rejects subpaths rather than silently truncating them', () => {
    expect(reject('https://github.com/owner/repo/tree/main/src')).toBe('subpath-unsupported');
    expect(reject('https://github.com/owner/repo/blob/main/index.ts')).toBe('subpath-unsupported');
    expect(reject('https://github.com/owner/repo/releases')).toBe('subpath-unsupported');
  });

  it('rejects incomplete paths', () => {
    expect(reject('https://github.com/')).toBe('bad-path');
    expect(reject('https://github.com/owner')).toBe('bad-path');
  });

  it('rejects reserved first segments', () => {
    expect(reject('https://github.com/settings/profile')).toBe('reserved-owner');
    expect(reject('https://github.com/orgs/anything')).toBe('reserved-owner');
    expect(reject('https://github.com/gist/abc')).toBe('reserved-owner');
  });

  it('rejects encoded traversal and separators', () => {
    // WHATWG `URL` resolves `..` and `%2e%2e` while parsing, so these collapse
    // to a path with too few segments. The encoded separators survive parsing
    // and are caught when the segment is decoded. Either way the input is
    // refused — assert the reason the implementation actually produces rather
    // than the one the attack is named after.
    for (const input of [
      'https://github.com/owner/%2e%2e',
      'https://github.com/%2e%2e/repo',
      'https://github.com/owner/..',
      'https://github.com/owner/repo/../../etc',
      'https://github.com/owner/re%2fpo',
      'https://github.com/owner/re%5cpo',
      'https://github.com/owner/%2E%2E%2Fetc',
      'https://github.com/owner/repo%00',
    ]) {
      expect(reject(input)).toBe('bad-path');
    }
  });

  it('rejects invalid owner and repository shapes', () => {
    expect(reject('https://github.com/-owner/repo')).toBe('bad-owner');
    expect(reject('https://github.com/owner-/repo')).toBe('bad-owner');
    expect(reject(`https://github.com/${'a'.repeat(40)}/repo`)).toBe('bad-owner');
    expect(reject(`https://github.com/owner/${'a'.repeat(101)}`)).toBe('bad-repo');
    expect(reject('https://github.com/own er/repo')).toBe('bad-path');
  });

  it('rejects empty, non-string and oversized input', () => {
    expect(reject('')).toBe('empty');
    expect(reject('   ')).toBe('empty');
    expect(reject(null)).toBe('not-a-url');
    expect(reject(undefined)).toBe('not-a-url');
    expect(reject(42)).toBe('not-a-url');
    expect(reject({ toString: () => 'https://github.com/o/r' })).toBe('not-a-url');
    expect(reject(`https://github.com/owner/${'a'.repeat(600)}`)).toBe('bad-path');
  });

  it('rejects control characters used for request splitting', () => {
    const cr = String.fromCharCode(13);
    const lf = String.fromCharCode(10);
    const nul = String.fromCharCode(0);
    expect(reject(`https://github.com/owner/repo${cr}${lf}X-Injected: 1`)).toBe('not-a-url');
    expect(reject(`https://github.com/owner/repo${nul}`)).toBe('not-a-url');
  });
});

describe('commit helpers', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';

  it('validates SHA shape strictly', () => {
    expect(isCommitSha(sha)).toBe(true);
    expect(isCommitSha(sha.toUpperCase())).toBe(false);
    expect(isCommitSha(sha.slice(0, 39))).toBe(false);
    expect(isCommitSha(`${sha}0`)).toBe(false);
    expect(isCommitSha(null)).toBe(false);
  });

  it('builds a permalink only for a valid SHA', () => {
    expect(commitUrl({ owner: 'o', repo: 'r' }, sha)).toBe(
      `https://github.com/o/r/tree/${sha}`,
    );
    expect(commitUrl({ owner: 'o', repo: 'r' }, 'nope')).toBeNull();
    expect(shortSha(sha)).toBe('0123456');
    expect(shortSha('nope')).toBe('');
  });
});
