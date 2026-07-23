#!/usr/bin/env node
/**
 * Runs a command with the approved environment already loaded.
 *
 * This wrapper is the mechanism that makes root `.env` beat Next.js's
 * `apps/web/.env.local`, and it is worth being precise about why it works.
 * `@next/env` assigns a variable from a `.env*` file only when the value is not
 * already present in `process.env`. So a variable this wrapper sets before
 * `next` is spawned is one that `.env.local` cannot replace — the override is
 * closed by construction rather than by asking people to remember.
 *
 * It applies identically to `next build`, which matters more than it looks:
 * `NEXT_PUBLIC_*` values are inlined into the client bundle at build time, so a
 * build that read the wrong file would bake the wrong publishable key into
 * static assets where no runtime check could ever catch it.
 *
 * Usage:
 *   node scripts/with-env.mjs [--quiet] -- <command> [args...]
 */
import { spawn } from 'node:child_process';
import process from 'node:process';
import { loadRootEnv, EnvLoadError, REPO_ROOT } from './env/load.mjs';
import { summariseEnvironment } from './env/summary.mjs';

const argv = process.argv.slice(2);
const quiet = argv.includes('--quiet');
const separator = argv.indexOf('--');
const command = separator === -1 ? argv.filter((a) => a !== '--quiet') : argv.slice(separator + 1);

if (command.length === 0) {
  process.stderr.write('Usage: node scripts/with-env.mjs [--quiet] -- <command> [args...]\n');
  process.exit(2);
}

let result;
try {
  result = loadRootEnv();
} catch (error) {
  if (error instanceof EnvLoadError) {
    process.stderr.write(`\n  ${error.message}\n\n${indent(error.guidance)}\n\n`);
    process.exit(1);
  }
  throw error;
}

if (!quiet) {
  // Names, modes and masked identifiers only. Never a value.
  process.stderr.write(summariseEnvironment(result, REPO_ROOT));
}

const child = spawn(command[0], command.slice(1), {
  stdio: 'inherit',
  env: process.env,
  cwd: process.cwd(),
  shell: process.platform === 'win32',
});

child.on('error', (error) => {
  process.stderr.write(`Failed to start ${command[0]}: ${error.message}\n`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

/** @param {string} text */
function indent(text) {
  return text
    .split('\n')
    .map((line) => (line ? `  ${line}` : line))
    .join('\n');
}
