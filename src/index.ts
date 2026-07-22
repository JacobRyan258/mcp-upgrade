/**
 * Programmatic entrypoint.
 *
 * The JSON report shape (`ScanReport`) is the stable public interface; this
 * module exposes the same scan the CLI runs, for embedding in other tooling.
 */
export * from './types.js';
export { ALL_RULES, ruleById } from './scanner/rules/index.js';
export { runScan } from './scanner/engine.js';
export type { EngineOptions, ScanResult, CommentOnlyMatch } from './scanner/engine.js';
export { renderTextReport } from './reporters/text.js';
export { renderJsonReport } from './reporters/json.js';
export { renderChecklistReport } from './reporters/checklist.js';
export { resolveOptions, runScanCommand, computeExitCode } from './cli/commands/scan.js';
export {
  SCANNER_VERSION,
  DEFAULT_TARGET_VERSION,
  BASELINE_PROTOCOL_VERSION,
  KNOWN_TARGETS,
  RC_DISCLAIMER,
  DEFAULT_IGNORE_PATTERNS,
  EXIT_OK,
  EXIT_FINDINGS,
  EXIT_USAGE,
  EXIT_INTERNAL,
} from './constants.js';
