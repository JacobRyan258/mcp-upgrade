// Adds a shebang + exec bit to the built CLI entrypoint so the package works
// via `npx mcp-upgrade` and a global install without a wrapper script.
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'dist', 'cli', 'bin.js');
const shebang = '#!/usr/bin/env node\n';

const source = readFileSync(entry, 'utf8');
if (!source.startsWith('#!')) {
  writeFileSync(entry, shebang + source, 'utf8');
}
chmodSync(entry, 0o755);
// stderr, so `npm pack --json` and similar stay machine-readable.
console.error('made executable:', entry);
