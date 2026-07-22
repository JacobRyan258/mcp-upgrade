/**
 * Hostile archive extraction.
 *
 * Every case here is an archive built to break out of the destination
 * directory, to exhaust a resource, or to make the extractor write something it
 * should not. The assertions are on *both* halves of the outcome: that the
 * right error category comes back, and that the filesystem outside the job
 * directory is untouched.
 */
import { readdir, readFile, rm, stat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ABSOLUTE_LIMITS, ingestionLimitsFor, planLimits } from '@mcp-upgrade/shared';
import type { IngestionLimits } from '@mcp-upgrade/shared';
import { extractZip, planEntry, removeJobDirectory } from '../src/zip.js';
import { IngestionError } from '../src/errors.js';
import {
  MCP_PROJECT,
  bombContent,
  makeTempDir,
  writeZip,
  writeZipWithHostileName,
} from './archives.js';

let workspace: string;
let destination: string;
let canary: string;

const LIMITS: IngestionLimits = ingestionLimitsFor(planLimits('free'));

function far(): number {
  return Date.now() + 120_000;
}

beforeEach(async () => {
  workspace = await makeTempDir('zip-test-');
  destination = path.join(workspace, 'root', 'src');
  await mkdir(destination, { recursive: true });
  // A file the traversal payloads aim at. Its survival is the real assertion.
  canary = path.join(workspace, 'CANARY.txt');
  await import('node:fs/promises').then((fs) => fs.writeFile(canary, 'untouched'));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

async function expectCategory(promise: Promise<unknown>, category: string): Promise<void> {
  await expect(promise).rejects.toThrow(IngestionError);
  await promise.catch((error: unknown) => {
    expect(error).toBeInstanceOf(IngestionError);
    expect((error as IngestionError).category).toBe(category);
  });
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
      else out.push(rel);
    }
  }
  await walk(root, '');
  return out.sort();
}

describe('a well-formed archive extracts correctly', () => {
  it('writes exactly the scannable files', async () => {
    const archive = path.join(workspace, 'ok.zip');
    await writeZip(archive, MCP_PROJECT);

    const result = await extractZip(archive, destination, { limits: LIMITS, deadline: far() });

    expect(result.filesWritten).toBe(2);
    expect(await listFiles(destination)).toEqual(['package.json', 'src/index.ts']);
    expect(result.bytesWritten).toBeGreaterThan(0);
  });

  it('preserves file contents byte for byte', async () => {
    const archive = path.join(workspace, 'ok.zip');
    await writeZip(archive, [{ name: 'a.ts', content: 'const secret = 1;\n' }]);
    await extractZip(archive, destination, { limits: LIMITS, deadline: far() });
    expect(await readFile(path.join(destination, 'a.ts'), 'utf8')).toBe('const secret = 1;\n');
  });

  it('creates files without group or world permissions', async () => {
    const archive = path.join(workspace, 'ok.zip');
    await writeZip(archive, [{ name: 'a.ts', content: 'x' }]);
    await extractZip(archive, destination, { limits: LIMITS, deadline: far() });
    const mode = (await stat(path.join(destination, 'a.ts'))).mode & 0o777;
    expect(mode & 0o077).toBe(0);
  });

  it('strips the leading component for a GitHub-style archive', async () => {
    const archive = path.join(workspace, 'gh.zip');
    await writeZip(archive, [
      { name: 'repo-abc123/package.json', content: '{}' },
      { name: 'repo-abc123/src/index.ts', content: 'export const a = 1;' },
    ]);
    await extractZip(archive, destination, {
      limits: LIMITS,
      deadline: far(),
      stripLeadingComponent: true,
    });
    expect(await listFiles(destination)).toEqual(['package.json', 'src/index.ts']);
  });
});

describe('path traversal', () => {
  const payloads = [
    '../../CANARY.txt',
    '../../../etc/passwd.ts',
    'a/../../../CANARY.txt',
    './../../CANARY.txt',
  ];

  for (const payload of payloads) {
    it(`refuses ${JSON.stringify(payload)} and leaves the target untouched`, async () => {
      const archive = path.join(workspace, 'trav.zip');
      await writeZipWithHostileName(archive, payload, 'PWNED');

      await expectCategory(
        extractZip(archive, destination, { limits: LIMITS, deadline: far() }),
        'archive_unsafe_entry',
      );
      expect(await readFile(canary, 'utf8')).toBe('untouched');
    });
  }

  it('refuses an absolute path', async () => {
    const archive = path.join(workspace, 'abs.zip');
    await writeZipWithHostileName(archive, '/etc/cron.d/evil.ts', 'PWNED');
    await expectCategory(
      extractZip(archive, destination, { limits: LIMITS, deadline: far() }),
      'archive_unsafe_entry',
    );
  });

  it('refuses a Windows drive-letter path', async () => {
    const archive = path.join(workspace, 'drive.zip');
    await writeZipWithHostileName(archive, 'C:/Windows/evil.ts', 'PWNED');
    await expectCategory(
      extractZip(archive, destination, { limits: LIMITS, deadline: far() }),
      'archive_unsafe_entry',
    );
  });

  it('refuses a UNC path', async () => {
    const archive = path.join(workspace, 'unc.zip');
    await writeZipWithHostileName(archive, '//host/share/evil.ts', 'PWNED');
    await expectCategory(
      extractZip(archive, destination, { limits: LIMITS, deadline: far() }),
      'archive_unsafe_entry',
    );
  });

  it('refuses a backslash separator', async () => {
    const archive = path.join(workspace, 'back.zip');
    await writeZipWithHostileName(archive, '..\\..\\CANARY.txt', 'PWNED');
    await expectCategory(
      extractZip(archive, destination, { limits: LIMITS, deadline: far() }),
      'archive_unsafe_entry',
    );
    expect(await readFile(canary, 'utf8')).toBe('untouched');
  });

  it('refuses a NUL byte in the entry name', async () => {
    const archive = path.join(workspace, 'nul.zip');
    // `evil.ts\0.png` — the extension check would see `.png`, the filesystem
    // would see `evil.ts`.
    const name = `evil.ts${String.fromCharCode(0)}.png`;
    await writeZipWithHostileName(archive, name, 'PWNED');
    await expectCategory(
      extractZip(archive, destination, { limits: LIMITS, deadline: far() }),
      'archive_unsafe_entry',
    );
  });

  it('refuses other control characters and newlines', async () => {
    for (const [index, code] of [10, 13, 27, 127].entries()) {
      const archive = path.join(workspace, `ctrl-${index}.zip`);
      await writeZipWithHostileName(archive, `ev${String.fromCharCode(code)}il.ts`, 'PWNED');
      await expectCategory(
        extractZip(archive, destination, { limits: LIMITS, deadline: far() }),
        'archive_unsafe_entry',
      );
    }
  });
});

describe('links are never created', () => {
  it('refuses a symbolic link entry', async () => {
    const archive = path.join(workspace, 'link.zip');
    // Mode 0o120777 is S_IFLNK. The content of a symlink entry is its target.
    await writeZip(archive, [
      { name: 'evil.ts', content: '/etc/passwd', mode: 0o120777 },
    ]);
    await expectCategory(
      extractZip(archive, destination, { limits: LIMITS, deadline: far() }),
      'archive_unsafe_entry',
    );
  });

  it('refuses a symlink pointing back into the job root', async () => {
    const archive = path.join(workspace, 'link2.zip');
    await writeZip(archive, [{ name: 'a.ts', content: '../../CANARY.txt', mode: 0o120777 }]);
    await expectCategory(
      extractZip(archive, destination, { limits: LIMITS, deadline: far() }),
      'archive_unsafe_entry',
    );
  });

  it('refuses a FIFO or device entry', async () => {
    const archive = path.join(workspace, 'fifo.zip');
    // 0o010000 is S_IFIFO.
    await writeZip(archive, [{ name: 'pipe.ts', content: '', mode: 0o010666 }]);
    await expectCategory(
      extractZip(archive, destination, { limits: LIMITS, deadline: far() }),
      'archive_unsafe_entry',
    );
  });

  it('accepts a normal file whose mode is a plain regular-file mode', async () => {
    const archive = path.join(workspace, 'reg.zip');
    await writeZip(archive, [{ name: 'a.ts', content: 'x', mode: 0o100644 }]);
    const result = await extractZip(archive, destination, { limits: LIMITS, deadline: far() });
    expect(result.filesWritten).toBe(1);
  });
});

describe('resource exhaustion', () => {
  it('refuses more files than the limit allows', async () => {
    const archive = path.join(workspace, 'many.zip');
    const entries = Array.from({ length: 60 }, (_unused, i) => ({
      name: `src/file-${i}.ts`,
      content: `export const v${i} = ${i};`,
    }));
    await writeZip(archive, entries);

    const limits = ingestionLimitsFor(planLimits('free'), { maxFiles: 10 });
    await expectCategory(
      extractZip(archive, destination, { limits, deadline: far() }),
      'archive_too_many_files',
    );
  });

  it('refuses a single file larger than the per-file limit', async () => {
    const archive = path.join(workspace, 'big.zip');
    await writeZip(archive, [{ name: 'big.ts', content: bombContent(3) }]);

    const limits = ingestionLimitsFor(planLimits('free'), { maxFileBytes: 1024 * 1024 });
    await expectCategory(
      extractZip(archive, destination, { limits, deadline: far() }),
      'archive_file_too_large',
    );
  });

  it('refuses an archive that expands beyond the total limit', async () => {
    const archive = path.join(workspace, 'total.zip');
    await writeZip(archive, [
      { name: 'a.ts', content: bombContent(2) },
      { name: 'b.ts', content: bombContent(2) },
      { name: 'c.ts', content: bombContent(2) },
    ]);

    const limits = ingestionLimitsFor(planLimits('free'), {
      maxExpandedBytes: 3 * 1024 * 1024,
      maxFileBytes: 4 * 1024 * 1024,
    });
    await expectCategory(
      extractZip(archive, destination, { limits, deadline: far() }),
      'archive_expanded_too_large',
    );
  });

  it('stops a compression bomb rather than writing it all out', async () => {
    const archive = path.join(workspace, 'bomb.zip');
    // 24 MB of a single repeated byte compresses to a few kilobytes.
    await writeZip(archive, [{ name: 'bomb.ts', content: bombContent(24), compress: true }]);

    const compressedSize = (await stat(archive)).size;
    expect(compressedSize).toBeLessThan(200 * 1024);

    const limits = ingestionLimitsFor(planLimits('free'), {
      maxFileBytes: 8 * 1024 * 1024,
      maxExpandedBytes: 10 * 1024 * 1024,
    });
    await expectCategory(
      extractZip(archive, destination, { limits, deadline: far() }),
      'archive_file_too_large',
    );

    // The critical assertion: extraction aborted mid-stream rather than after
    // materialising 24 MB.
    const written = await listFiles(destination);
    let total = 0;
    for (const file of written) total += (await stat(path.join(destination, file))).size;
    expect(total).toBeLessThanOrEqual(limits.maxFileBytes + 1024 * 1024);
  });

  it('refuses an archive exceeding the compression ratio limit', async () => {
    const archive = path.join(workspace, 'ratio.zip');
    await writeZip(archive, [{ name: 'r.ts', content: bombContent(4), compress: true }]);

    const limits = ingestionLimitsFor(planLimits('free'), {
      maxFileBytes: 8 * 1024 * 1024,
      maxExpandedBytes: 64 * 1024 * 1024,
      maxCompressionRatio: 50,
    });
    await expectCategory(
      extractZip(archive, destination, { limits, deadline: far() }),
      'archive_expanded_too_large',
    );
  });

  it('refuses an entry nested deeper than the depth limit', async () => {
    const archive = path.join(workspace, 'deep.zip');
    const deep = `${Array.from({ length: 40 }, (_u, i) => `d${i}`).join('/')}/x.ts`;
    await writeZip(archive, [{ name: deep, content: 'x' }]);
    await expectCategory(
      extractZip(archive, destination, { limits: LIMITS, deadline: far() }),
      'archive_unsafe_entry',
    );
  });

  it('refuses an entry name longer than the path limit', async () => {
    const archive = path.join(workspace, 'long.zip');
    await writeZip(archive, [{ name: `${'a'.repeat(2000)}.ts`, content: 'x' }]);
    await expectCategory(
      extractZip(archive, destination, { limits: LIMITS, deadline: far() }),
      'archive_unsafe_entry',
    );
  });

  it('aborts once the deadline has passed', async () => {
    const archive = path.join(workspace, 'slow.zip');
    await writeZip(archive, MCP_PROJECT);
    await expectCategory(
      extractZip(archive, destination, { limits: LIMITS, deadline: Date.now() - 1 }),
      'scan_timeout',
    );
  });
});

describe('duplicate and colliding names', () => {
  it('refuses two entries with the same name', async () => {
    const archive = path.join(workspace, 'dup.zip');
    await writeZip(archive, [
      { name: 'a.ts', content: 'first' },
      { name: 'a.ts', content: 'second' },
    ]);
    await expectCategory(
      extractZip(archive, destination, { limits: LIMITS, deadline: far() }),
      'archive_unsafe_entry',
    );
  });

  it('refuses entries that collide only by case', async () => {
    const archive = path.join(workspace, 'case.zip');
    await writeZip(archive, [
      { name: 'Config.ts', content: 'safe' },
      { name: 'config.ts', content: 'malicious' },
    ]);
    await expectCategory(
      extractZip(archive, destination, { limits: LIMITS, deadline: far() }),
      'archive_unsafe_entry',
    );
  });

  it('refuses a trailing-dot name that Windows would fold together', async () => {
    const archive = path.join(workspace, 'dot.zip');
    await writeZipWithHostileName(archive, 'evil.ts.', 'PWNED');
    await expectCategory(
      extractZip(archive, destination, { limits: LIMITS, deadline: far() }),
      'archive_unsafe_entry',
    );
  });
});

describe('content filtering', () => {
  it('never unpacks a nested archive', async () => {
    const archive = path.join(workspace, 'nested.zip');
    await writeZip(archive, [
      ...MCP_PROJECT,
      { name: 'vendor-bundle.zip', content: bombContent(1) },
      { name: 'data.tar.gz', content: 'x' },
    ]);
    const result = await extractZip(archive, destination, { limits: LIMITS, deadline: far() });
    expect(result.skippedNestedArchives).toBe(2);
    expect(await listFiles(destination)).toEqual(['package.json', 'src/index.ts']);
  });

  it('reports an archive of nothing but nested archives distinctly', async () => {
    const archive = path.join(workspace, 'onlynested.zip');
    await writeZip(archive, [{ name: 'inner.zip', content: 'x' }]);
    await expectCategory(
      extractZip(archive, destination, { limits: LIMITS, deadline: far() }),
      'archive_nested_archive',
    );
  });

  it('skips binary and unsupported files without decompressing them', async () => {
    const archive = path.join(workspace, 'mixed.zip');
    await writeZip(archive, [
      ...MCP_PROJECT,
      { name: 'logo.png', content: bombContent(4) },
      { name: 'README.md', content: '# hello' },
      { name: 'binary.exe', content: bombContent(4) },
    ]);
    const result = await extractZip(archive, destination, { limits: LIMITS, deadline: far() });
    expect(result.skippedUnsupported).toBe(3);
    expect(result.bytesWritten).toBeLessThan(1024 * 100);
  });

  it('skips always-ignored directories entirely', async () => {
    const archive = path.join(workspace, 'ignored.zip');
    await writeZip(archive, [
      ...MCP_PROJECT,
      { name: 'node_modules/left-pad/index.js', content: 'module.exports = 1;' },
      { name: '.git/config', content: '[core]' },
      { name: 'dist/bundle.js', content: 'x' },
    ]);
    const result = await extractZip(archive, destination, { limits: LIMITS, deadline: far() });
    expect(result.skippedIgnored).toBe(3);
    expect(await listFiles(destination)).toEqual(['package.json', 'src/index.ts']);
  });

  it('reports an archive with nothing scannable', async () => {
    const archive = path.join(workspace, 'empty.zip');
    await writeZip(archive, [{ name: 'README.md', content: '# nothing here' }]);
    await expectCategory(
      extractZip(archive, destination, { limits: LIMITS, deadline: far() }),
      'archive_empty',
    );
  });
});

describe('malformed input', () => {
  it('refuses a file that is not a ZIP at all', async () => {
    const archive = path.join(workspace, 'not.zip');
    await import('node:fs/promises').then((fs) =>
      fs.writeFile(archive, 'this is definitely not a zip file'),
    );
    await expectCategory(
      extractZip(archive, destination, { limits: LIMITS, deadline: far() }),
      'archive_invalid',
    );
  });

  it('refuses a truncated ZIP', async () => {
    const archive = path.join(workspace, 'trunc.zip');
    await writeZip(archive, MCP_PROJECT);
    const bytes = await readFile(archive);
    await import('node:fs/promises').then((fs) =>
      fs.writeFile(archive, bytes.subarray(0, Math.floor(bytes.length / 2))),
    );
    await expectCategory(
      extractZip(archive, destination, { limits: LIMITS, deadline: far() }),
      'archive_invalid',
    );
  });

  it('refuses an empty file', async () => {
    const archive = path.join(workspace, 'zero.zip');
    await import('node:fs/promises').then((fs) => fs.writeFile(archive, ''));
    await expectCategory(
      extractZip(archive, destination, { limits: LIMITS, deadline: far() }),
      'archive_invalid',
    );
  });
});

describe('planEntry refuses every hostile name on its own', () => {
  /**
   * These assertions matter because in the full pipeline yauzl rejects some of
   * these names before `planEntry` ever sees them. Two independent layers is
   * the intent, but a layer that is never exercised is a layer nobody knows is
   * broken — so this suite drives `planEntry` directly with the same payloads.
   */
  const nul = String.fromCharCode(0);
  const hostile: Array<[string, string]> = [
    ['parent traversal', '../../CANARY.txt'],
    ['deep traversal', '../../../etc/passwd.ts'],
    ['mid-path traversal', 'a/../../../CANARY.txt'],
    ['dot-prefixed traversal', './../../CANARY.txt'],
    ['absolute path', '/etc/cron.d/evil.ts'],
    ['drive letter', 'C:/Windows/evil.ts'],
    ['UNC path', '//host/share/evil.ts'],
    ['backslash separator', '..\\..\\CANARY.txt'],
    ['backslash only', 'a\\b.ts'],
    ['NUL byte', `evil.ts${nul}.png`],
    ['newline', `ev${String.fromCharCode(10)}il.ts`],
    ['carriage return', `ev${String.fromCharCode(13)}il.ts`],
    ['escape', `ev${String.fromCharCode(27)}il.ts`],
    ['delete', `ev${String.fromCharCode(127)}il.ts`],
    ['trailing dot', 'evil.ts.'],
    ['trailing space', 'evil.ts '],
    ['empty name', ''],
    ['only separators', '///'],
    ['current directory segment', 'a/./b.ts'],
  ];

  for (const [label, name] of hostile) {
    it(`refuses ${label}`, () => {
      expect(() => planEntry(name, LIMITS, 0)).toThrow(IngestionError);
      try {
        planEntry(name, LIMITS, 0);
      } catch (error) {
        expect((error as IngestionError).category).toBe('archive_unsafe_entry');
      }
    });
  }

  it('refuses a symbolic-link mode', () => {
    expect(() => planEntry('a.ts', LIMITS, 0o120777 << 16)).toThrow(IngestionError);
  });

  it('refuses a name longer than the limit', () => {
    expect(() => planEntry(`${'a'.repeat(2000)}.ts`, LIMITS, 0)).toThrow(IngestionError);
  });

  it('refuses a path deeper than the limit', () => {
    const deep = `${Array.from({ length: 40 }, (_u, i) => `d${i}`).join('/')}/x.ts`;
    expect(() => planEntry(deep, LIMITS, 0)).toThrow(IngestionError);
  });
});

describe('planEntry decides correctly in isolation', () => {
  const attrs = 0;

  it('classifies supported source as writable', () => {
    for (const name of ['a.ts', 'src/b.tsx', 'c.js', 'd.mjs', 'e.cjs', 'f.json', 'g.yaml', 'h.yml']) {
      expect(planEntry(name, LIMITS, attrs).kind).toBe('write');
    }
  });

  it('classifies directories', () => {
    expect(planEntry('src/', LIMITS, attrs).kind).toBe('directory');
    expect(planEntry('src', LIMITS, 0x10).kind).toBe('directory');
  });

  it('normalises unicode before comparing', () => {
    // U+00E9 vs "e" + U+0301 must produce the same relative path, so a second
    // entry cannot masquerade as a different file.
    const composed = planEntry('café.ts', LIMITS, attrs);
    const decomposed = planEntry('café.ts', LIMITS, attrs);
    expect(composed.relativePath).toBe(decomposed.relativePath);
  });

  it('is bounded by the absolute limits, not just the plan', () => {
    const wide = ingestionLimitsFor(planLimits('pro'), {
      maxDepth: 10_000,
      maxPathLength: 10_000,
    });
    expect(wide.maxDepth).toBeLessThanOrEqual(ABSOLUTE_LIMITS.maxDepth);
    expect(wide.maxPathLength).toBeLessThanOrEqual(ABSOLUTE_LIMITS.maxPathLength);
  });
});

describe('cleanup refuses to act outside the scan root', () => {
  it('removes a job directory inside the root', async () => {
    const root = path.join(workspace, 'scans');
    const job = path.join(root, 'scan-abc');
    await mkdir(job, { recursive: true });
    await removeJobDirectory(root, job);
    await expect(stat(job)).rejects.toThrow();
  });

  it('refuses to remove the root itself', async () => {
    const root = path.join(workspace, 'scans');
    await mkdir(root, { recursive: true });
    await expect(removeJobDirectory(root, root)).rejects.toThrow(/outside the scan root/);
    expect((await stat(root)).isDirectory()).toBe(true);
  });

  it('refuses to remove a sibling of the root', async () => {
    const root = path.join(workspace, 'scans');
    await mkdir(root, { recursive: true });
    await expect(removeJobDirectory(root, workspace)).rejects.toThrow(/outside the scan root/);
    await expect(removeJobDirectory(root, path.join(workspace, 'other'))).rejects.toThrow(
      /outside the scan root/,
    );
    expect(await readFile(canary, 'utf8')).toBe('untouched');
  });

  it('refuses a traversal that resolves outside the root', async () => {
    const root = path.join(workspace, 'scans');
    await mkdir(root, { recursive: true });
    await expect(
      removeJobDirectory(root, path.join(root, '..', '..')),
    ).rejects.toThrow(/outside the scan root/);
  });
});
