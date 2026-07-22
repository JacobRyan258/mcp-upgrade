#!/usr/bin/env node
// Removes every build artefact in the workspace without touching node_modules.
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const targets = [
  'packages/scanner/dist',
  'packages/shared/dist',
  'packages/database/dist',
  'apps/worker/dist',
  'apps/web/.next',
  'apps/web/test-results',
  'apps/web/playwright-report',
];

for (const target of targets) {
  rmSync(join(root, target), { recursive: true, force: true });
  console.log(`removed ${target}`);
}
