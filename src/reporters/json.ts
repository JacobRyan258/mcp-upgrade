import type { ScanReport } from '../types.js';

/**
 * JSON report.
 *
 * This format is a stable public interface: `schemaVersion` is `"1.0"` and
 * consumers may rely on the field set. Future additions (SARIF export, hosted
 * validation, autofix metadata) go in as new optional fields rather than
 * changes to existing ones.
 *
 * Output is plain JSON with no ANSI, and deterministic apart from `generatedAt`.
 */
export function renderJsonReport(report: ScanReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
