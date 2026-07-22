import { beforeAll, describe, expect, it } from 'vitest';
import { isScanReport, scanPath } from '../../src/index.js';
import type { ScanReport } from '../../src/index.js';
import { fixture } from '../helpers.js';

describe('ScanReport runtime schema invariants', () => {
  let report: ScanReport;

  beforeAll(async () => {
    report = await scanPath({ path: fixture('legacy-session-server') });
    expect(isScanReport(report)).toBe(true);
  });

  const copy = (): ScanReport => structuredClone(report);

  it('rejects impossible dates, line ranges, effort ranges, and non-official sources', () => {
    const invalidDate = copy();
    invalidDate.generatedAt = '2026-02-31T00:00:00.000Z';
    expect(isScanReport(invalidDate)).toBe(false);

    const invalidLines = copy();
    const lineFinding = invalidLines.findings[0];
    if (!lineFinding) throw new Error('legacy fixture must produce a finding');
    lineFinding.endLine = Math.max(1, lineFinding.line - 1);
    if (lineFinding.endLine === lineFinding.line) lineFinding.line++;
    expect(isScanReport(invalidLines)).toBe(false);

    const invalidEffort = copy();
    invalidEffort.summary.effort.minHours = invalidEffort.summary.effort.maxHours + 1;
    expect(isScanReport(invalidEffort)).toBe(false);

    const invalidItem = copy();
    const effortItem = invalidItem.summary.effort.items[0];
    if (!effortItem) throw new Error('legacy fixture must produce an effort item');
    effortItem.minHours = effortItem.maxHours + 1;
    expect(isScanReport(invalidItem)).toBe(false);

    for (const url of [
      'javascript:alert(1)',
      'http://modelcontextprotocol.io/specification/draft',
      'https://modelcontextprotocol.io.evil.example/specification/draft',
    ]) {
      const invalidSource = copy();
      const sourceFinding = invalidSource.findings[0];
      if (!sourceFinding) throw new Error('legacy fixture must produce a finding');
      sourceFinding.source.url = url;
      expect(isScanReport(invalidSource), url).toBe(false);
    }
  });

  it('rejects absolute, Windows, and traversal paths in portable report locations', () => {
    const mutateFindingPath = (file: string): ScanReport => {
      const candidate = copy();
      const finding = candidate.findings[0];
      if (!finding) throw new Error('legacy fixture must produce a finding');
      finding.file = file;
      return candidate;
    };

    expect(isScanReport(mutateFindingPath('/etc/passwd'))).toBe(false);
    expect(isScanReport(mutateFindingPath('C:\\Users\\person\\server.ts'))).toBe(false);
    expect(isScanReport(mutateFindingPath('../outside.ts'))).toBe(false);
    expect(isScanReport(mutateFindingPath('src/../outside.ts'))).toBe(false);

    const invalidFileRecord = copy();
    const fileRecord = invalidFileRecord.files[0];
    if (!fileRecord) throw new Error('legacy fixture must produce a file record');
    fileRecord.file = '/tmp/server.ts';
    expect(isScanReport(invalidFileRecord)).toBe(false);

    const invalidDeduction = copy();
    const deduction = invalidDeduction.summary.readiness.deductions[0];
    if (!deduction) throw new Error('legacy fixture must produce a score deduction');
    deduction.file = '../server.ts';
    expect(isScanReport(invalidDeduction)).toBe(false);

    const invalidEffortFile = copy();
    const effortItem = invalidEffortFile.summary.effort.items[0];
    if (!effortItem) throw new Error('legacy fixture must produce an effort item');
    effortItem.files = ['src\\server.ts'];
    expect(isScanReport(invalidEffortFile)).toBe(false);

    const invalidIssue = copy();
    invalidIssue.scanStatus = 'partial';
    invalidIssue.issues = [
      { code: 'analysis-limit', path: '../server.ts', message: 'analysis was bounded' },
    ];
    expect(isScanReport(invalidIssue)).toBe(false);
  });

  it('rejects summaries that contradict findings or file records', () => {
    const invalidCounts = copy();
    invalidCounts.summary.counts.error++;
    expect(isScanReport(invalidCounts)).toBe(false);

    const invalidByRule = copy();
    const finding = invalidByRule.findings[0];
    if (!finding) throw new Error('legacy fixture must produce a finding');
    invalidByRule.summary.byRule[finding.ruleId] =
      (invalidByRule.summary.byRule[finding.ruleId] ?? 0) + 1;
    expect(isScanReport(invalidByRule)).toBe(false);

    const invalidDiscoveryArithmetic = copy();
    invalidDiscoveryArithmetic.summary.filesDiscovered++;
    expect(isScanReport(invalidDiscoveryArithmetic)).toBe(false);

    const invalidScannedCount = copy();
    invalidScannedCount.summary.filesScanned++;
    invalidScannedCount.summary.filesDiscovered++;
    expect(isScanReport(invalidScannedCount)).toBe(false);

    const invalidFindingCount = copy();
    const file = invalidFindingCount.files.find((entry) => entry.scanned);
    if (!file) throw new Error('legacy fixture must produce a scanned file');
    file.findingCount++;
    expect(isScanReport(invalidFindingCount)).toBe(false);

    const invalidFilesRequiringChanges = copy();
    invalidFilesRequiringChanges.summary.filesRequiringChanges++;
    expect(isScanReport(invalidFilesRequiringChanges)).toBe(false);

    const invalidScore = copy();
    invalidScore.summary.readiness.score = Math.min(
      100,
      invalidScore.summary.readiness.score + 1,
    );
    if (invalidScore.summary.readiness.score === report.summary.readiness.score) {
      invalidScore.summary.readiness.score--;
    }
    expect(isScanReport(invalidScore)).toBe(false);

    const invalidDeduction = copy();
    const deduction = invalidDeduction.summary.readiness.deductions[0];
    if (!deduction) throw new Error('legacy fixture must produce a score deduction');
    deduction.points++;
    invalidDeduction.summary.readiness.score = Math.max(
      0,
      invalidDeduction.summary.readiness.score - 1,
    );
    expect(isScanReport(invalidDeduction)).toBe(false);

    const missingDeductions = copy();
    missingDeductions.summary.readiness.deductions = [];
    missingDeductions.summary.readiness.score = 100;
    expect(isScanReport(missingDeductions)).toBe(false);

    const duplicateFile = copy();
    const duplicatedRecord = duplicateFile.files[0];
    if (!duplicatedRecord) throw new Error('legacy fixture must produce a file record');
    duplicateFile.files.push({ ...duplicatedRecord });
    duplicateFile.summary.filesDiscovered++;
    if (duplicatedRecord.scanned) duplicateFile.summary.filesScanned++;
    else duplicateFile.summary.filesSkipped++;
    expect(isScanReport(duplicateFile)).toBe(false);

    const invalidEffortTotal = copy();
    invalidEffortTotal.summary.effort.maxHours++;
    expect(isScanReport(invalidEffortTotal)).toBe(false);
  });

  it('allows missing per-file detail only when a report-limit issue declares truncation', () => {
    const undeclared = copy();
    undeclared.files.pop();
    expect(isScanReport(undeclared)).toBe(false);

    const declared = copy();
    declared.files.pop();
    declared.scanStatus = 'partial';
    declared.issues = [
      {
        code: 'report-limit',
        path: '.',
        message: 'Per-file details were truncated at the defensive report limit.',
        count: 1,
      },
    ];
    expect(isScanReport(declared)).toBe(true);
  });

  it('requires a partial report to declare an issue that can make analysis incomplete', () => {
    const scopeOnly = copy();
    scopeOnly.scanStatus = 'partial';
    scopeOnly.issues = [
      {
        code: 'test-path',
        path: 'test/example.ts',
        message: 'The file was intentionally outside the selected scan scope.',
      },
    ];
    expect(isScanReport(scopeOnly)).toBe(false);

    const bounded = copy();
    bounded.scanStatus = 'partial';
    bounded.issues = [
      {
        code: 'analysis-limit',
        path: '.',
        message: 'A defensive analysis budget was reached.',
      },
    ];
    expect(isScanReport(bounded)).toBe(true);
  });

  it('requires each reported partial file to have a matching issue', () => {
    const partial = copy();
    partial.scanStatus = 'partial';
    partial.summary.filesDiscovered++;
    partial.summary.filesSkipped++;
    partial.files.push({
      file: 'src/oversized.ts',
      scanned: false,
      skipped: 'too-large',
      size: 2_000_000,
      findingCount: 0,
    });
    partial.issues.push({
      code: 'too-large',
      path: 'src/oversized.ts',
      message: 'File exceeded the configured source-file size limit.',
      size: 2_000_000,
    });
    expect(isScanReport(partial)).toBe(true);

    const missing = structuredClone(partial);
    missing.issues = [
      {
        code: 'analysis-limit',
        path: 'src/other.ts',
        message: 'An unrelated analysis limit was reached.',
      },
    ];
    expect(isScanReport(missing)).toBe(false);

    missing.issues.push({
      code: 'report-limit',
      path: '.',
      message: 'Per-file or per-issue details were truncated.',
      count: 1,
    });
    expect(isScanReport(missing)).toBe(true);
  });
});
