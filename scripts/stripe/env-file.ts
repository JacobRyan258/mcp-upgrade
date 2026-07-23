/**
 * Writing secrets into a local environment file, carefully.
 *
 * The dangerous version of this feature rewrites the file from a template and
 * throws away everything it did not put there. This one edits in place: it
 * touches only the Stripe keys it manages, leaves every comment, blank line and
 * unrelated value exactly where it was, and takes a backup first.
 *
 * Two refusals are absolute, and neither can be overridden by a flag:
 *
 *   A file tracked by git is never written. Putting a live signing secret into
 *   a tracked file is a one-keystroke mistake with a permanent consequence —
 *   git history is forever, and the secret is compromised the moment it is
 *   pushed.
 *
 *   A file git does not ignore is never written, even if it happens to be
 *   untracked right now. Untracked-and-not-ignored is precisely the file that
 *   `git add .` sweeps up next week.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export class EnvFileError extends Error {
  readonly guidance: string;
  constructor(message: string, guidance: string) {
    super(message);
    this.name = 'EnvFileError';
    this.guidance = guidance;
  }
}

export interface GitProbe {
  isTracked(file: string): boolean;
  isIgnored(file: string): boolean;
}

/** Answers both questions with git itself, so .gitignore precedence is never re-implemented. */
export function gitProbe(cwd: string): GitProbe {
  const run = (args: string[]): { ok: boolean; stdout: string } => {
    try {
      const stdout = execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return { ok: true, stdout };
    } catch {
      return { ok: false, stdout: '' };
    }
  };

  return {
    isTracked(file) {
      return run(['ls-files', '--error-unmatch', '--', file]).ok;
    },
    isIgnored(file) {
      // `check-ignore` exits 0 when the path *is* ignored, 1 when it is not.
      return run(['check-ignore', '--quiet', '--no-index', '--', file]).ok;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Rewriting                                                                   */
/* -------------------------------------------------------------------------- */

export interface ApplyResult {
  content: string;
  updated: string[];
  added: string[];
  unchanged: string[];
}

function serialise(value: string): string {
  return /^[A-Za-z0-9_./:@+-]*$/.test(value) ? value : JSON.stringify(value);
}

function lineFor(key: string, value: string, indent = ''): string {
  return `${indent}${key}=${serialise(value)}`;
}

/**
 * Sets values in an env file's text.
 *
 * A key that is present but commented out — which is how this repository ships
 * `apps/web/.env.local`, with the Stripe block deliberately disabled — is
 * uncommented in place rather than duplicated at the end of the file. That
 * keeps the explanatory comment sitting directly above the value it explains.
 */
export function applyEnvValues(content: string, values: Record<string, string>): ApplyResult {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  let lines = content.length === 0 ? [] : content.split(/\r?\n/);

  const updated: string[] = [];
  const added: string[] = [];
  const unchanged: string[] = [];

  for (const [key, value] of Object.entries(values)) {
    const pattern = new RegExp(`^(\\s*)(#\\s*)?(${escape(key)})\\s*=(.*)$`);
    const live: number[] = [];
    const commented: number[] = [];

    lines.forEach((line, index) => {
      const match = pattern.exec(line);
      if (!match) return;
      if (match[2]) commented.push(index);
      else live.push(index);
    });

    if (live.length > 0) {
      // Every uncommented occurrence is set, not just the last one that dotenv
      // would honour. Leaving a stale earlier line is how a "fixed" value goes
      // on being wrong under a loader with different precedence.
      let changed = false;
      for (const index of live) {
        const indent = pattern.exec(lines[index]!)?.[1] ?? '';
        const next = lineFor(key, value, indent);
        if (lines[index] !== next) {
          lines[index] = next;
          changed = true;
        }
      }
      (changed ? updated : unchanged).push(key);
      continue;
    }

    const lastCommented = commented.at(-1);
    if (lastCommented !== undefined) {
      const indent = pattern.exec(lines[lastCommented]!)?.[1] ?? '';
      lines[lastCommented] = lineFor(key, value, indent);
      updated.push(key);
      continue;
    }

    added.push(key);
  }

  if (added.length > 0) {
    while (lines.length > 0 && lines.at(-1)!.trim() === '') lines.pop();
    if (lines.length > 0) lines.push('');
    lines.push('# Added by scripts/setup-stripe.ts.');
    for (const key of added) lines.push(lineFor(key, values[key]!));
    lines = [...lines, ''];
  } else if (content.endsWith('\n') && lines.at(-1) !== '') {
    lines.push('');
  }

  return { content: lines.join(newline), updated, added, unchanged };
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

/** Minimal env parsing: enough to read back a value this script wrote. */
export function readEnvValue(content: string, key: string): string | null {
  const pattern = new RegExp(`^\\s*${escape(key)}\\s*=(.*)$`);
  let found: string | null = null;
  for (const line of content.split(/\r?\n/)) {
    const match = pattern.exec(line);
    if (!match) continue;
    const raw = match[1]!.trim();
    found =
      (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
        ? raw.slice(1, -1)
        : raw.replace(/\s+#.*$/, '');
  }
  return found;
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                     */
/* -------------------------------------------------------------------------- */

export interface WriteRequest {
  /** Path as the operator typed it, resolved against `repoRoot`. */
  file: string;
  repoRoot: string;
  values: Record<string, string>;
  git: GitProbe;
  dryRun: boolean;
}

export interface WriteResult {
  file: string;
  created: boolean;
  backup: string | null;
  updated: string[];
  added: string[];
  unchanged: string[];
}

export function writeEnvFile(request: WriteRequest): WriteResult {
  const absolute = path.resolve(request.repoRoot, request.file);
  const relative = path.relative(request.repoRoot, absolute);

  if (relative.startsWith('..')) {
    throw new EnvFileError(
      `${request.file} is outside the repository.`,
      'Give a path inside the repo, such as apps/web/.env.local.',
    );
  }
  if (request.git.isTracked(relative)) {
    throw new EnvFileError(
      `${relative} is tracked by git.`,
      'Refusing to write credentials into a file that is under version control. ' +
        'Untrack it first (git rm --cached), make sure .gitignore covers it, and ' +
        'rotate anything already committed.',
    );
  }
  if (!request.git.isIgnored(relative)) {
    throw new EnvFileError(
      `${relative} is not ignored by git.`,
      'Refusing to write credentials into a file that a later `git add .` would ' +
        'stage. Add a rule for it to .gitignore and run this again.',
    );
  }

  const exists = existsSync(absolute);
  const before = exists ? readFileSync(absolute, 'utf8') : '';
  const result = applyEnvValues(before, request.values);
  const changed = result.updated.length > 0 || result.added.length > 0;

  if (request.dryRun || !changed) {
    return {
      file: relative,
      created: false,
      backup: null,
      updated: result.updated,
      added: result.added,
      unchanged: result.unchanged,
    };
  }

  let backup: string | null = null;
  if (exists) {
    const backupPath = `${absolute}.bak`;
    if (!request.git.isIgnored(path.relative(request.repoRoot, backupPath))) {
      throw new EnvFileError(
        `${path.relative(request.repoRoot, backupPath)} would not be ignored by git.`,
        'The backup would contain the same credentials as the file itself. ' +
          'Extend .gitignore to cover it, then run this again.',
      );
    }
    copyFileSync(absolute, backupPath);
    backup = path.relative(request.repoRoot, backupPath);
  }

  writeFileSync(absolute, result.content, { encoding: 'utf8', mode: 0o600 });

  return {
    file: relative,
    created: !exists,
    backup,
    updated: result.updated,
    added: result.added,
    unchanged: result.unchanged,
  };
}
