/**
 * Executable entrypoint. Kept separate from `index.ts` so that importing the
 * CLI as a library (tests, embedding) never runs it.
 */
import { EXIT_INTERNAL } from '../constants.js';
import { sanitizeReportText } from '../scanner/redaction.js';
import { main } from './index.js';

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`internal error: ${sanitizeReportText(message, 2_000)}\n`);
    process.exitCode = EXIT_INTERNAL;
  });
