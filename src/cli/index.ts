import { Command, CommanderError } from 'commander';
import {
  DEFAULT_TARGET_VERSION,
  EXIT_INTERNAL,
  EXIT_OK,
  EXIT_USAGE,
  RC_DISCLAIMER,
  SCANNER_VERSION,
} from '../constants.js';
import { sanitizeReportText } from '../scanner/redaction.js';
import { InternalScannerError, UsageError } from '../types.js';
import type { RawScanOptions } from './commands/scan.js';
import { runScanCommand } from './commands/scan.js';

/**
 * CLI entrypoint.
 *
 * Exit codes are the contract:
 *   0 — scan completed, nothing reached the failure threshold
 *   1 — scan completed, findings reached the failure threshold
 *   2 — invalid arguments or unreadable target
 *   3 — internal scanner failure
 *
 * 1 never means "the scanner broke", which is why every unexpected throw is
 * funnelled to 3.
 */

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const defaultIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

/** Redacts hostile argv/path text while retaining Commander's line structure. */
export function sanitizeDiagnosticText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => sanitizeReportText(line, 2_000))
    .join('\n');
}

/**
 * Builds the command tree. `onExitCode` receives the scan's exit code, since a
 * commander action handler has no return channel.
 */
export function buildProgram(io: CliIo, onExitCode: (code: number) => void): Command {
  const program = new Command();

  program
    .name('mcp-upgrade')
    .description(
      'Find what breaks before you upgrade your MCP server.\n' +
        `Scans JavaScript and TypeScript MCP servers for MCP ${DEFAULT_TARGET_VERSION} ` +
        'release-candidate compatibility problems.\n\n' +
        RC_DISCLAIMER,
    )
    .version(SCANNER_VERSION, '-v, --version', 'Print CLI version')
    .helpOption('-h, --help', 'Print help')
    .showHelpAfterError('(run `mcp-upgrade scan --help` for usage)')
    .configureOutput({
      writeOut: io.stdout,
      writeErr: (text) => io.stderr(sanitizeDiagnosticText(text)),
    })
    .exitOverride();

  program
    .command('scan')
    .description('Scan a repository directory or an individual source file')
    .argument('<path>', 'Repository directory or individual source file')
    .option('-f, --format <format>', 'Output format: text | json | checklist', 'text')
    .option('-t, --target <version>', 'Target MCP specification', DEFAULT_TARGET_VERSION)
    .option('--ignore <patterns>', 'Comma-separated glob patterns to ignore')
    .option('--include-tests', 'Include test and fixture directories')
    .option('--min-confidence <level>', 'Minimum confidence: low | medium | high', 'low')
    .option('--ci', 'Enable finding-threshold exit codes for CI')
    .option('--fail-on <level>', 'Failure threshold with --ci: error | warning | review', 'error')
    .option('--no-color', 'Disable ANSI terminal formatting')
    .option('--verbose', 'Show files scanned and rule execution details (text format only)')
    .configureOutput({
      writeOut: io.stdout,
      writeErr: (text) => io.stderr(sanitizeDiagnosticText(text)),
    })
    .exitOverride()
    .addHelpText(
      'after',
      '\nExit codes:\n' +
        '  0  Scan completed; no finding reached the configured failure threshold\n' +
        '  1  Scan completed; findings reached the configured failure threshold\n' +
        '  2  Invalid CLI arguments, unreadable target, or partial scan\n' +
        '  3  Internal scanner failure\n' +
        '\nExamples:\n' +
        '  $ npx mcp-upgrade scan ./my-mcp-server\n' +
        '  $ npx mcp-upgrade scan ./src/server.ts --format json > report.json\n' +
        '  $ npx mcp-upgrade scan . --format checklist\n' +
        '  $ npx mcp-upgrade scan . --ci --fail-on error\n',
    )
    .action(async (targetPath: string, options: RawScanOptions) => {
      const result = await runScanCommand(targetPath, options);
      io.stdout(result.stdout);
      onExitCode(result.exitCode);
    });

  return program;
}

export async function main(argv: string[] = process.argv, io: CliIo = defaultIo): Promise<number> {
  let exitCode = EXIT_OK;
  let commandRan = false;
  const program = buildProgram(io, (code) => {
    exitCode = code;
    commandRan = true;
  });

  // Bare invocation is a usage error, not a successful run: print help but
  // exit 2, so scripts that forgot their arguments fail loudly.
  if (argv.length <= 2) {
    io.stderr(`${program.helpInformation()}\n`);
    return EXIT_USAGE;
  }

  try {
    await program.parseAsync(argv);
    if (!commandRan) {
      io.stderr(`${program.helpInformation()}\n`);
      return EXIT_USAGE;
    }
    return exitCode;
  } catch (error) {
    // `--help` and `--version` come through exitOverride as CommanderErrors.
    if (error instanceof CommanderError) {
      if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version') {
        return EXIT_OK;
      }
      // Commander also emits `commander.help` when `--` leaves the root command
      // with no operand. Only its explicit `help [command]` form is successful.
      if (error.code === 'commander.help' && argv[2] === 'help') return EXIT_OK;
      // Commander has already written its own diagnostic through configureOutput.
      return EXIT_USAGE;
    }

    if (error instanceof UsageError) {
      io.stderr(`error: ${sanitizeReportText(error.message, 2_000)}\n`);
      return EXIT_USAGE;
    }

    if (error instanceof InternalScannerError) {
      io.stderr(`internal error: ${sanitizeReportText(error.message, 2_000)}\n`);
      return EXIT_INTERNAL;
    }

    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`internal error: ${sanitizeReportText(message, 2_000)}\n`);
    return EXIT_INTERNAL;
  }
}
