/**
 * Executable entrypoint. Kept separate from `index.ts` so that importing the
 * CLI as a library (tests, embedding) never runs it.
 */
import { EXIT_INTERNAL } from '../constants.js';
import { main } from './index.js';

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`internal error: ${String(error)}\n`);
    process.exitCode = EXIT_INTERNAL;
  });
