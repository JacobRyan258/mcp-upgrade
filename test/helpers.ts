import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScan } from '../src/scanner/engine.js';
import { resolveOptions } from '../src/cli/commands/scan.js';
import type { RawScanOptions } from '../src/cli/commands/scan.js';
import type { Finding, ScanReport } from '../src/types.js';
import type { ScanResult } from '../src/scanner/engine.js';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const fixturesDir = path.join(repoRoot, 'test', 'fixtures');

export function fixture(name: string): string {
  return path.join(fixturesDir, name);
}

/** Frozen clock so two reports of the same tree compare byte-for-byte. */
const FIXED_NOW = new Date('2026-07-22T00:00:00.000Z');

/** Scans a path with the same option resolution the CLI uses. */
export async function scanFixture(
  target: string,
  raw: RawScanOptions = {},
): Promise<ScanResult> {
  const options = await resolveOptions(target, raw);
  return runScan(options, { now: () => FIXED_NOW });
}

export async function reportFor(target: string, raw: RawScanOptions = {}): Promise<ScanReport> {
  return (await scanFixture(target, raw)).report;
}

export function findingsFor(report: ScanReport, ruleId: string): Finding[] {
  return report.findings.filter((finding) => finding.ruleId === ruleId);
}

export function ruleIds(report: ScanReport): string[] {
  return [...new Set(report.findings.map((finding) => finding.ruleId))].sort();
}

/** Creates a throwaway directory of files and removes it afterwards. */
export async function withTempProject(
  files: Record<string, string>,
  run: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-upgrade-test-'));
  try {
    for (const [relative, content] of Object.entries(files)) {
      const absolute = path.join(dir, relative);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, content, 'utf8');
    }
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Matches any ANSI escape sequence. */
export const ANSI_PATTERN = /\[[0-9;]*[A-Za-z]/;
