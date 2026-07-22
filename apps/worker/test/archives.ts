/**
 * Hostile archive construction.
 *
 * `yazl` validates entry names and refuses to write a traversal path, an
 * absolute path or a backslash — which is correct of it, and useless for
 * testing an extractor against exactly those inputs.
 *
 * So archives are built with a placeholder name of the same byte length as the
 * hostile one, and the bytes are then patched in the finished file. The name
 * appears in both the local file header and the central directory and the
 * replacement is length-preserving, so every offset in the archive stays valid
 * and the result is a genuinely well-formed ZIP carrying a malicious name —
 * which is what a real attacker produces.
 */
import { createWriteStream } from 'node:fs';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import yazl from 'yazl';

export interface EntrySpec {
  name: string;
  content: string | Buffer;
  /** Unix mode. `0o120777` marks a symbolic link. */
  mode?: number;
  compress?: boolean;
}

export async function makeTempDir(prefix = 'worker-test-'): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

/** Writes a well-formed archive containing exactly these entries. */
export async function writeZip(destination: string, entries: EntrySpec[]): Promise<string> {
  const zip = new yazl.ZipFile();
  for (const entry of entries) {
    const buffer = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content);
    // `yazl.Options` declares every field as required, so the object is built
    // as a partial and widened at the call site rather than being filled in
    // with values that would change what the fixture archive actually contains.
    const options: Partial<yazl.Options> = {};
    if (entry.mode !== undefined) options.mode = entry.mode;
    if (entry.compress !== undefined) options.compress = entry.compress;
    zip.addBuffer(buffer, entry.name, options as yazl.Options);
  }
  zip.end();
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(destination);
    out.on('close', () => resolve());
    out.on('error', reject);
    zip.outputStream.on('error', reject);
    zip.outputStream.pipe(out);
  });
  return destination;
}

/**
 * Writes an archive whose entry name is patched to `hostileName` after the fact.
 *
 * `hostileName` must be the same byte length as `placeholder`, otherwise every
 * offset after the patched header would shift and the archive would be
 * malformed for the wrong reason.
 */
export async function writeZipWithHostileName(
  destination: string,
  hostileName: string,
  content = 'export const x = 1;\n',
  extraEntries: EntrySpec[] = [],
): Promise<string> {
  const hostileBytes = Buffer.from(hostileName, 'utf8');
  const placeholder = 'A'.repeat(hostileBytes.length);
  if (Buffer.byteLength(placeholder) !== hostileBytes.length) {
    throw new Error('placeholder length must match the hostile name byte length');
  }

  await writeZip(destination, [{ name: placeholder, content }, ...extraEntries]);

  const original = await readFile(destination);
  const placeholderBytes = Buffer.from(placeholder, 'utf8');
  const patched = Buffer.from(original);

  let replacements = 0;
  let index = patched.indexOf(placeholderBytes);
  while (index !== -1) {
    hostileBytes.copy(patched, index);
    replacements += 1;
    index = patched.indexOf(placeholderBytes, index + hostileBytes.length);
  }
  // A ZIP stores the name twice: local file header and central directory. Both
  // must be patched or the archive is inconsistent and the test would be
  // exercising a parse failure rather than the traversal defence.
  if (replacements < 2) {
    throw new Error(`expected to patch at least 2 name occurrences, patched ${replacements}`);
  }

  await writeFile(destination, patched);
  return destination;
}

/**
 * A compression-bomb approximation: highly compressible content that expands
 * far beyond its stored size.
 */
export function bombContent(megabytes: number): Buffer {
  return Buffer.alloc(megabytes * 1024 * 1024, 0x41);
}

/** A minimal but genuinely MCP-shaped project the scanner will classify. */
export const MCP_PROJECT: EntrySpec[] = [
  {
    name: 'package.json',
    content: JSON.stringify(
      {
        name: 'sample-mcp-server',
        version: '1.0.0',
        dependencies: { '@modelcontextprotocol/sdk': '^1.20.0' },
      },
      null,
      2,
    ),
  },
  {
    name: 'src/index.ts',
    content: [
      "import { Server } from '@modelcontextprotocol/sdk/server/index.js';",
      "import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';",
      '',
      'const transport = new StreamableHTTPServerTransport({',
      '  sessionIdGenerator: () => crypto.randomUUID(),',
      '});',
      '',
      "const server = new Server({ name: 'sample', version: '1.0.0' }, { capabilities: { logging: {} } });",
      'await server.connect(transport);',
      '',
    ].join('\n'),
  },
];
