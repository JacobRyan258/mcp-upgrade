import { describe, expect, it } from 'vitest';
import { fixture, findingsFor, reportFor, ruleIds } from '../helpers.js';

/**
 * Fixture-level expectations.
 *
 * These are the behavioural contract of the scanner: the clean fixtures must
 * stay clean, and each legacy fixture must produce exactly the findings that
 * justify its existence.
 */

describe('clean-stdio-server', () => {
  it('produces no errors and is classified as stdio', async () => {
    const report = await reportFor(fixture('clean-stdio-server'));

    expect(report.repository.transport).toBe('stdio');
    expect(report.repository.isLikelyMcpServer).toBe(true);
    expect(report.summary.counts.error).toBe(0);
  });

  it('is never asked for Streamable HTTP routing headers', async () => {
    const report = await reportFor(fixture('clean-stdio-server'));

    const headerFindings = report.findings.filter((finding) =>
      finding.ruleId.startsWith('MCP2026-HEADER'),
    );
    expect(headerFindings).toEqual([]);
  });

  it('reports no legacy lifecycle findings', async () => {
    const report = await reportFor(fixture('clean-stdio-server'));

    expect(findingsFor(report, 'MCP2026-LIFECYCLE-001')).toEqual([]);
    expect(findingsFor(report, 'MCP2026-SESSION-001')).toEqual([]);
  });

  it('scores 100', async () => {
    const report = await reportFor(fixture('clean-stdio-server'));
    expect(report.summary.readiness.score).toBe(100);
  });
});

describe('clean-http-server', () => {
  it('produces no errors and is classified as streamable-http', async () => {
    const report = await reportFor(fixture('clean-http-server'));

    expect(report.repository.transport).toBe('streamable-http');
    expect(report.summary.counts.error).toBe(0);
  });

  it('reports where the required headers are already implemented', async () => {
    const report = await reportFor(fixture('clean-http-server'));
    const implemented = findingsFor(report, 'MCP2026-HEADER-003');

    expect(implemented.length).toBeGreaterThan(0);
    expect(implemented.every((finding) => finding.level === 'info')).toBe(true);

    const titles = implemented.map((finding) => finding.title);
    expect(titles.some((title) => title.includes('Mcp-Method'))).toBe(true);
    expect(titles.some((title) => title.includes('Mcp-Name'))).toBe(true);
  });

  it('does not flag `sessionIdGenerator: undefined`, the documented stateless shape', async () => {
    const report = await reportFor(fixture('clean-http-server'));
    expect(findingsFor(report, 'MCP2026-SESSION-002')).toEqual([]);
  });
});

describe('legacy-session-server', () => {
  it('detects the Mcp-Session-Id header for both reads and writes', async () => {
    const report = await reportFor(fixture('legacy-session-server'));
    const findings = findingsFor(report, 'MCP2026-SESSION-001');

    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((finding) => finding.level !== 'error')).toBe(true);
    expect(findings.some((finding) => finding.level === 'warning')).toBe(true);
    expect(findings.some((finding) => finding.level === 'review')).toBe(true);
    expect(findings.some((finding) => finding.title.includes('reads'))).toBe(true);
    expect(findings.some((finding) => finding.title.includes('writes'))).toBe(true);
  });

  it('detects the initialization lifecycle dependency', async () => {
    const report = await reportFor(fixture('legacy-session-server'));
    const findings = findingsFor(report, 'MCP2026-LIFECYCLE-001');

    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((finding) => finding.level === 'error')).toBe(true);
  });

  it('detects session-keyed state storage as review, not error', async () => {
    const report = await reportFor(fixture('legacy-session-server'));
    const findings = findingsFor(report, 'MCP2026-SESSION-003');

    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((finding) => finding.level === 'review')).toBe(true);
    expect(findings.some((finding) => finding.file === 'src/sessions.ts')).toBe(true);
  });

  it('detects sticky-session configuration in both YAML and JSON', async () => {
    const report = await reportFor(fixture('legacy-session-server'));
    const findings = findingsFor(report, 'MCP2026-SESSION-004');

    expect(findings.some((finding) => finding.file.endsWith('.yaml'))).toBe(true);
    expect(findings.some((finding) => finding.file.endsWith('.json'))).toBe(true);
  });

  it('detects transport session options', async () => {
    const report = await reportFor(fixture('legacy-session-server'));
    const evidence = findingsFor(report, 'MCP2026-SESSION-002').map((finding) => finding.evidence);

    expect(evidence.join('\n')).toContain('sessionIdGenerator');
    expect(evidence.join('\n')).toContain('onsessioninitialized');
  });

  it('detects the -32002 resource-not-found code at high confidence', async () => {
    const report = await reportFor(fixture('legacy-session-server'));
    const findings = findingsFor(report, 'MCP2026-ERROR-001');

    expect(findings).toHaveLength(1);
    expect(findings[0]?.level).toBe('error');
    expect(findings[0]?.confidence).toBe('high');
    expect(findings[0]?.file).toBe('src/resources.ts');
  });

  it('never leaks fixture secrets into the report', async () => {
    const report = await reportFor(fixture('legacy-session-server'));
    const serialized = JSON.stringify(report);

    for (const secret of [
      'sk-live-6f3aB9xQ2mZ7pL0wN4tR8vK1cD5eH2jS',
      'sk-live-9tG4hW2xQ8mZ7pL0wN4tR8vK1cD5eH2j',
      'hunter2correcthorse',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain('[REDACTED:');
  });
});

describe('experimental-tasks-server', () => {
  it('detects the removed tasks/list and tasks/result RPCs', async () => {
    const report = await reportFor(fixture('experimental-tasks-server'));
    const findings = findingsFor(report, 'MCP2026-TASKS-001');

    expect(findings.every((finding) => finding.level === 'error')).toBe(true);
    const titles = findings.map((finding) => finding.title).join('\n');
    expect(titles).toContain('tasks/list');
    expect(titles).toContain('tasks/result');
  });

  it('detects the legacy Tasks capability declarations', async () => {
    const report = await reportFor(fixture('experimental-tasks-server'));
    const titles = findingsFor(report, 'MCP2026-TASKS-002')
      .map((finding) => finding.title)
      .join('\n');

    expect(titles).toContain('capabilities.tasks');
    expect(titles).toContain('capabilities.tasks.list');
    expect(titles).toContain('capabilities.tasks.requests');
  });

  it('detects task-augmented Sampling', async () => {
    const report = await reportFor(fixture('experimental-tasks-server'));
    const findings = findingsFor(report, 'MCP2026-TASKS-004');

    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((finding) => finding.level === 'error')).toBe(true);
  });

  it('does not report the nested tasks.requests.sampling key as a Sampling capability', async () => {
    const report = await reportFor(fixture('experimental-tasks-server'));
    const samplingCapability = findingsFor(report, 'MCP2026-SAMPLING-001').filter((finding) =>
      finding.title.includes('capability'),
    );
    expect(samplingCapability).toEqual([]);
  });

  it('marks the Tasks migration as never safe to autofix', async () => {
    const report = await reportFor(fixture('experimental-tasks-server'));
    const taskFindings = report.findings.filter((finding) => finding.category === 'tasks');

    expect(taskFindings.length).toBeGreaterThan(0);
    expect(taskFindings.every((finding) => finding.autofix === 'manual')).toBe(true);
  });
});

describe('deprecated-features-server', () => {
  it('reports Sampling, Roots and protocol Logging as warnings, not errors', async () => {
    const report = await reportFor(fixture('deprecated-features-server'));

    for (const ruleId of ['MCP2026-SAMPLING-001', 'MCP2026-ROOTS-001', 'MCP2026-LOGGING-001']) {
      const findings = findingsFor(report, ruleId);
      expect(findings.length, `${ruleId} produced no findings`).toBeGreaterThan(0);
      expect(
        findings.every((finding) => finding.level === 'warning'),
        `${ruleId} produced a non-warning`,
      ).toBe(true);
    }
  });

  it('never describes a deprecation as removed or breaking', async () => {
    const report = await reportFor(fixture('deprecated-features-server'));
    const deprecations = report.findings.filter((finding) => finding.level === 'warning');

    for (const finding of deprecations) {
      expect(finding.explanation).toContain('deprecated');
      expect(finding.explanation).toMatch(/not removed|remain fully functional|still work/i);
      expect(finding.explanation).not.toMatch(/\bis removed\b(?!:)/);
    }
  });

  it('reports the two genuine removals as errors, separately from the deprecations', async () => {
    const report = await reportFor(fixture('deprecated-features-server'));

    // logging/setLevel and notifications/roots/list_changed are removed by the
    // changelog, even though the Logging and Roots *features* are deprecated.
    const setLevel = findingsFor(report, 'MCP2026-LOGGING-002');
    const rootsChanged = findingsFor(report, 'MCP2026-ROOTS-002');

    expect(setLevel.length).toBeGreaterThan(0);
    expect(setLevel.every((finding) => finding.level === 'error')).toBe(true);
    expect(rootsChanged.length).toBeGreaterThan(0);
    expect(rootsChanged.every((finding) => finding.level === 'error')).toBe(true);
  });

  it('detects the deprecated includeContext value', async () => {
    const report = await reportFor(fixture('deprecated-features-server'));
    const findings = findingsFor(report, 'MCP2026-SAMPLING-002');

    expect(findings).toHaveLength(1);
    expect(findings[0]?.level).toBe('warning');
  });

  it('warns about credential exposure when recommending a direct provider API', async () => {
    const report = await reportFor(fixture('deprecated-features-server'));
    const sampling = findingsFor(report, 'MCP2026-SAMPLING-001')[0];

    expect(sampling?.remediation).toMatch(/API\s*key|credential/i);
  });

  it('does not tell the user to remove filesystem safeguards with Roots', async () => {
    const report = await reportFor(fixture('deprecated-features-server'));
    const roots = findingsFor(report, 'MCP2026-ROOTS-001')[0];

    expect(roots?.remediation).toMatch(/not an access-control mechanism/i);
    expect(roots?.remediation).toMatch(/do not remove filesystem safeguards/i);
  });
});

describe('ambiguous-wrapper-server', () => {
  it('returns review rather than a false error when middleware may add headers', async () => {
    const report = await reportFor(fixture('ambiguous-wrapper-server'));

    expect(report.summary.counts.error).toBe(0);
    const headerFindings = findingsFor(report, 'MCP2026-HEADER-001');
    expect(headerFindings.length).toBeGreaterThan(0);
    expect(headerFindings.every((finding) => finding.level === 'review')).toBe(true);
  });

  it('records that HTTP routing is abstracted', async () => {
    const report = await reportFor(fixture('ambiguous-wrapper-server'));
    expect(report.repository.httpRoutingIsAbstracted).toBe(true);
  });
});

describe('docs-only-matches', () => {
  it('produces no findings from protocol strings that only appear in comments', async () => {
    const report = await reportFor(fixture('docs-only-matches'));

    expect(report.findings).toEqual([]);
    expect(report.summary.counts.error).toBe(0);
    expect(report.summary.readiness.score).toBe(100);
  });

  it('counts the suppressed comment matches so they are not silently lost', async () => {
    const { report, commentOnlyMatches } = await (
      await import('../helpers.js')
    ).scanFixture(fixture('docs-only-matches'), { verbose: true });

    expect(report.summary.commentOnlyMatches).toBeGreaterThan(0);
    expect(commentOnlyMatches.length).toBe(report.summary.commentOnlyMatches);
  });

  it('does not mistake a regex containing a double slash for a comment', async () => {
    // `const HTTPS_PREFIX = /^https:\/\/[^/]+/;` sits between two real comments.
    // A raw-scanner comment lexer would swallow the rest of that line.
    const report = await reportFor(fixture('docs-only-matches'), { verbose: true });
    expect(ruleIds(report)).toEqual([]);
  });
});
