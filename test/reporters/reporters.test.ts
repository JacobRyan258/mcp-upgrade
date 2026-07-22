import { describe, expect, it } from 'vitest';
import { renderChecklistReport } from '../../src/reporters/checklist.js';
import { renderJsonReport } from '../../src/reporters/json.js';
import { renderTextReport } from '../../src/reporters/text.js';
import { wrap } from '../../src/reporters/text.js';
import { ANSI_PATTERN, fixture, reportFor } from '../helpers.js';
import type { ScanReport } from '../../src/types.js';

const LEGACY = fixture('legacy-session-server');
const CLEAN = fixture('clean-stdio-server');
const DEPRECATED = fixture('deprecated-features-server');

describe('text reporter', () => {
  it('renders every required section', async () => {
    const report = await reportFor(LEGACY);
    const text = renderTextReport(report, { color: false, verbose: false });

    for (const section of [
      'MCP Upgrade Scanner',
      'Target: MCP 2026-07-28 RC',
      'Repository',
      'Transport:',
      'SDK:',
      'Files',
      'Scanned:',
      'Found:',
      'Why this matters:',
      'Migration:',
      'Source:',
      'Summary',
      'Estimated migration readiness',
      'Estimated migration effort',
      'Unique files requiring changes',
      'MCP Apps readiness',
    ]) {
      expect(text, `missing section: ${section}`).toContain(section);
    }
  });

  it('identifies itself as targeting a release candidate', async () => {
    const report = await reportFor(CLEAN);
    const text = renderTextReport(report, { color: false, verbose: false });
    expect(text).toContain('release candidate');
    expect(text).toContain('not yet published');
  });

  it('states the score is not an official certification', async () => {
    const report = await reportFor(LEGACY);
    const text = renderTextReport(report, { color: false, verbose: false });
    expect(text).toContain('Estimated migration readiness');
    expect(text).toContain('not an official Model Context Protocol certification');
  });

  it('emits no ANSI when color is disabled', async () => {
    const report = await reportFor(LEGACY);
    const text = renderTextReport(report, { color: false, verbose: false });
    expect(ANSI_PATTERN.test(text)).toBe(false);
  });

  it('emits ANSI when color is enabled', async () => {
    const report = await reportFor(LEGACY);
    const text = renderTextReport(report, { color: true, verbose: false });
    expect(ANSI_PATTERN.test(text)).toBe(true);
  });

  it('does not print a doubled SEP identifier in the source line', async () => {
    const report = await reportFor(LEGACY);
    const text = renderTextReport(report, { color: false, verbose: false });
    expect(text).not.toMatch(/SEP-\d+ — SEP-\d+/);
    expect(text).toContain('SEP-2567 — Sessionless MCP via Explicit State Handles');
  });

  it('groups findings by level and then category', async () => {
    const report = await reportFor(DEPRECATED);
    const text = renderTextReport(report, { color: false, verbose: false });

    const errorAt = text.indexOf('ERROR — ');
    const warningAt = text.indexOf('WARNING — ');
    expect(errorAt).toBeGreaterThan(-1);
    expect(warningAt).toBeGreaterThan(errorAt);
  });

  it('describes warnings as still functional, never as breaking', async () => {
    const report = await reportFor(DEPRECATED);
    const text = renderTextReport(report, { color: false, verbose: false });
    expect(text).toContain('Still fully functional during the deprecation window');
  });

  it('lists ignored comment-only evidence under --verbose', async () => {
    const { report, trace, commentOnlyMatches } = await (
      await import('../helpers.js')
    ).scanFixture(fixture('docs-only-matches'), { verbose: true });

    const text = renderTextReport(report, {
      color: false,
      verbose: true,
      trace,
      commentOnlyMatches,
    });

    expect(text).toContain('Verbose: rule execution');
    expect(text).toContain('Verbose: ignored evidence');
    expect(text).toContain('mcp-session-id');
  });

  it('says so plainly when there are no findings', async () => {
    const report = await reportFor(CLEAN);
    const text = renderTextReport(report, { color: false, verbose: false });
    expect(text).toContain('No findings.');
  });

  it('wraps prose without losing or duplicating words', () => {
    const sentence = 'the quick brown fox jumps over the lazy dog again and again';
    const lines = wrap(sentence, 20);
    expect(lines.every((line) => line.length <= 20)).toBe(true);
    expect(lines.join(' ')).toBe(sentence);
  });
});

describe('json reporter', () => {
  it('parses and carries the documented top-level shape', async () => {
    const report = await reportFor(LEGACY);
    const parsed = JSON.parse(renderJsonReport(report)) as ScanReport;

    expect(parsed.schemaVersion).toBe('1.0');
    expect(typeof parsed.scannerVersion).toBe('string');
    expect(() => new Date(parsed.generatedAt).toISOString()).not.toThrow();
    expect(parsed.target.protocolVersion).toBe('2026-07-28');
    expect(parsed.target.status).toBe('release-candidate');
    expect(parsed.target.baselineVersion).toBe('2025-11-25');
    expect(parsed.repository).toBeTypeOf('object');
    expect(parsed.summary).toBeTypeOf('object');
    expect(Array.isArray(parsed.findings)).toBe(true);
    expect(Array.isArray(parsed.files)).toBe(true);
  });

  it('gives every finding the full documented field set', async () => {
    const report = await reportFor(LEGACY);
    const parsed = JSON.parse(renderJsonReport(report)) as ScanReport;

    for (const finding of parsed.findings) {
      expect(typeof finding.ruleId).toBe('string');
      expect(['error', 'warning', 'review', 'info']).toContain(finding.level);
      expect(['high', 'medium', 'low']).toContain(finding.confidence);
      expect(typeof finding.category).toBe('string');
      expect(typeof finding.title).toBe('string');
      expect(typeof finding.file).toBe('string');
      expect(finding.line).toBeGreaterThan(0);
      expect(typeof finding.evidence).toBe('string');
      expect(finding.explanation.length).toBeGreaterThan(20);
      expect(finding.remediation.length).toBeGreaterThan(20);
      expect(finding.source.url).toMatch(/^https:\/\//);
      expect(['safe', 'suggested', 'manual', 'none']).toContain(finding.autofix);
    }
  });

  it('bounds evidence length', async () => {
    const report = await reportFor(LEGACY);
    for (const finding of report.findings) {
      expect(finding.evidence.length).toBeLessThanOrEqual(160);
      expect(finding.evidence).not.toContain('\n');
    }
  });

  it('contains no ANSI', async () => {
    const report = await reportFor(LEGACY);
    expect(ANSI_PATTERN.test(renderJsonReport(report))).toBe(false);
  });

  it('includes the score explanation and effort exclusions', async () => {
    const report = await reportFor(LEGACY);
    const parsed = JSON.parse(renderJsonReport(report)) as ScanReport;

    expect(parsed.summary.readiness.explanation).toContain('Started at 100');
    expect(parsed.summary.readiness.disclaimer).toContain('not an official');
    expect(parsed.summary.effort.excludes.length).toBeGreaterThan(0);
  });

  it('sorts files and rule counts deterministically', async () => {
    const report = await reportFor(LEGACY);
    const files = report.files.map((entry) => entry.file);
    expect([...files].sort((a, b) => a.localeCompare(b, 'en'))).toEqual(files);

    const ruleKeys = Object.keys(report.summary.byRule);
    expect([...ruleKeys].sort((a, b) => a.localeCompare(b, 'en'))).toEqual(ruleKeys);
  });
});

describe('checklist reporter', () => {
  it('produces Markdown with checkbox tasks and locations', async () => {
    const report = await reportFor(LEGACY);
    const markdown = renderChecklistReport(report);

    expect(markdown).toContain('## MCP 2026-07-28 Migration Checklist');
    expect(markdown).toContain('### Confirmed incompatibilities');
    expect(markdown).toMatch(/- \[ \] .+\(`MCP2026-SESSION-001`\)/);
    expect(markdown).toMatch(/ {2}- `src\/server\.ts:\d+`/);
    expect(markdown).toContain('### References');
  });

  it('separates deprecations and says they are not breaking changes', async () => {
    const report = await reportFor(DEPRECATED);
    const markdown = renderChecklistReport(report);

    expect(markdown).toContain('### Deprecations');
    expect(markdown).toContain('are not breaking changes');
  });

  it('contains no ANSI', async () => {
    const report = await reportFor(LEGACY);
    expect(ANSI_PATTERN.test(renderChecklistReport(report))).toBe(false);
  });

  it('reports a clean repository plainly', async () => {
    const report = await reportFor(CLEAN);
    const markdown = renderChecklistReport(report);
    expect(markdown).toContain('No blocking incompatibilities');
  });

  it('bounds the location list so it stays pasteable', async () => {
    const report = await reportFor(LEGACY);
    const markdown = renderChecklistReport(report);
    for (const line of markdown.split('\n')) {
      expect(line.length).toBeLessThan(400);
    }
  });
});
