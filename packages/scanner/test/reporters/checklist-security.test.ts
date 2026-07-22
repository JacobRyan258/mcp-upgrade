import { describe, expect, it } from 'vitest';
import { renderChecklistReport } from '../../src/reporters/checklist.js';
import { renderTextReport } from '../../src/reporters/text.js';
import { fixture, reportFor } from '../helpers.js';

describe('checklist output safety', () => {
  it('contains hostile report strings without allowing Markdown or terminal injection', async () => {
    const report = structuredClone(await reportFor(fixture('legacy-session-server')));
    report.repository.root = 'repo`\n## injected\u001b]8;;https://evil.example\u0007';

    const finding = report.findings[0];
    expect(finding).toBeDefined();
    if (!finding) return;

    finding.file = 'src/`file\n- [x] injected.ts';
    finding.title = 'Review this\n### injected heading';
    finding.source = {
      title: 'Official ](https://evil.example)[ source',
      url: 'https://modelcontextprotocol.io/specification/draft/basic/index)\n## injected',
    };

    const markdown = renderChecklistReport(report);

    expect(markdown).not.toContain('\u001b');
    expect(markdown).not.toContain('\u0007');
    expect(markdown).not.toContain('\n## injected');
    expect(markdown).not.toContain('\n### injected heading');
    expect(markdown).not.toContain('\n- [x] injected.ts');
    expect(markdown).toContain('repo` ## injected');
    expect(markdown).toContain('src/`file - [x] injected.ts');
  });

  it('never presents a partial scan as an unqualified clean result', async () => {
    const report = structuredClone(await reportFor(fixture('clean-stdio-server')));
    report.scanStatus = 'partial';
    report.issues = [
      {
        code: 'unreadable',
        path: 'src/hidden.ts',
        message: 'File could not be opened and read safely.',
      },
    ];
    report.findings = [];
    report.summary.counts = { error: 0, warning: 0, review: 0, info: 0 };

    const checklist = renderChecklistReport(report);
    const text = renderTextReport(report, { color: false, verbose: false });

    expect(checklist).toContain('**Partial scan:**');
    expect(checklist).toContain('The scan is incomplete.');
    expect(checklist).toContain('### Scan issues');
    expect(text).toContain('PARTIAL:');
    expect(text).toContain('No findings in scanned files; the scan is incomplete.');
    expect(text).not.toContain('\nNo findings.\n');
  });
});
