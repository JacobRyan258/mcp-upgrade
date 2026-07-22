import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const externalRoot = process.argv[2] ? path.resolve(process.argv[2]) : undefined;

function walk(root, relative = '') {
  const files = [];
  const directory = path.join(root, relative);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...walk(root, child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

/**
 * Tracked and new files, via git. Falls back to walking the working tree when
 * this is not a git checkout (a tarball export, or a consumer running the
 * script directly) rather than crashing the whole `verify` pipeline.
 */
function gitFiles() {
  try {
    return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\0')
      .filter(Boolean);
  } catch {
    console.warn('check-secrets: not a git checkout; scanning the working tree instead.');
    return walk(process.cwd()).filter((file) => !file.split(path.sep).includes('node_modules'));
  }
}

const files = (
  externalRoot
    ? walk(externalRoot)
    : [
        ...new Set(gitFiles()),
      ]
).sort();

// Deliberately fake credentials used to prove output redaction. Exact-value
// allowlisting keeps the scanner useful without exempting whole test files.
const allowed = new Set([
  'abc123def456ghi789',
  // AWS's own published documentation example pair, used to prove that the
  // sensitive half of a credential object is redacted.
  'AKIAIOSFODNN7EXAMPLE',
  'ASIAABCDEFGHIJKLMNOP',
  'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz012345',
  'github_pat_11ABCDEFGHIJKLMNOPQRSTUV',
  'glpat-ABCDEFGHIJKLMNOPqrst',
  'npm_abcDEF0123456789abcDEF0123456789',
  'rk_live_AbCdEfGhIjKlMnOp',
  'sk-live-6f3aB9xQ2mZ7pL0wN4tR8vK1cD5eH2jS',
  'sk-live-9tG4hW2xQ8mZ7pL0wN4tR8vK1cD5eH2j',
  'sk-proj-AbCdEfGhIjKlMnOpQrSt',
  'sk-proj-abcdefghijklmnopqrstuvwx',
  'sk_live_abcdefghij0123456789',
  'whsec_abcDEF0123456789xyzw',
]);

const patterns = [
  {
    kind: 'private key',
    regex: /-----BEGIN[A-Z ]*PRIVATE KEY-----/g,
    value: (match) => match[0],
  },
  {
    kind: 'vendor token',
    regex:
      /\b((?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{22,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{28,}|(?:sk|rk)_live_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9]{16,}|(?:AKIA|ASIA)[0-9A-Z]{16}))\b/g,
    value: (match) => match[1],
  },
  {
    kind: 'authorization token',
    regex: /\b(?:Bearer|Basic|Token)\s+([A-Za-z0-9._~+/=-]{12,})/g,
    value: (match) => match[1],
  },
];

const findings = [];
for (const file of files) {
  let content;
  try {
    content = readFileSync(externalRoot ? path.join(externalRoot, file) : file, 'utf8');
  } catch {
    continue;
  }
  if (content.includes('\0')) continue;

  for (const pattern of patterns) {
    pattern.regex.lastIndex = 0;
    for (const match of content.matchAll(pattern.regex)) {
      const value = pattern.value(match);
      if (allowed.has(value)) continue;
      const offset = match.index ?? 0;
      const line = content.slice(0, offset).split('\n').length;
      findings.push(`${file}:${line} (${pattern.kind})`);
    }
  }
}

if (findings.length > 0) {
  console.error('Potential secrets found. Values are intentionally not printed:');
  for (const finding of findings) console.error(`  ${finding}`);
  process.exitCode = 1;
} else {
  const scope = externalRoot ? 'artifact files' : 'tracked or non-ignored untracked files';
  console.log(`Secret check passed (${files.length} ${scope}).`);
}
