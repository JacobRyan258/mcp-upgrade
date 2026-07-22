import { Chalk } from 'chalk';
import { RC_DISCLAIMER } from '../constants.js';
import type { CommentOnlyMatch } from '../scanner/engine.js';
import type { Finding, FindingLevel, ScanReport } from '../types.js';

/** An instance of chalk's writer, as returned by `new Chalk(...)`. */
type ChalkInstance = InstanceType<typeof Chalk>;

/**
 * Default terminal report.
 *
 * Colour is opt-out via `--no-color`; the writer is constructed with
 * `level: 0` in that case, so no ANSI ever reaches the stream rather than being
 * stripped afterwards.
 */

export interface TextReportOptions {
  color: boolean;
  verbose: boolean;
  trace?: string[];
  commentOnlyMatches?: CommentOnlyMatch[];
}

const LEVEL_ORDER: FindingLevel[] = ['error', 'warning', 'review', 'info'];

const LEVEL_LABEL: Record<FindingLevel, string> = {
  error: 'ERROR',
  warning: 'WARNING',
  review: 'REVIEW',
  info: 'INFO',
};

export function renderTextReport(report: ScanReport, options: TextReportOptions): string {
  const c = new Chalk({ level: options.color ? 3 : 0 });
  const out: string[] = [];

  const line = (text = ''): void => {
    out.push(text);
  };

  /* ---- Header ---------------------------------------------------------- */

  line(c.bold('MCP Upgrade Scanner'));
  line(
    `Target: MCP ${report.target.protocolVersion} ${
      report.target.status === 'release-candidate' ? 'RC' : report.target.status
    }  (migrating from ${report.target.baselineVersion})`,
  );
  line(c.dim(RC_DISCLAIMER));
  line();

  /* ---- Repository classification --------------------------------------- */

  const repo = report.repository;
  line(c.bold('Repository'));
  line(`  Path:      ${repo.root}${repo.singleFile ? ' (single file)' : ''}`);
  if (repo.packageName) line(`  Package:   ${repo.packageName}`);
  line(`  MCP server: ${repo.isLikelyMcpServer ? 'yes' : 'no detectable MCP signal'}`);
  line(
    `  Transport: ${repo.transport}${
      repo.transportEvidence.length > 0 ? ` (${repo.transportEvidence.join(', ')})` : ''
    }`,
  );
  line(
    `  SDK:       ${repo.sdk ? `${repo.sdk.name}, declared ${repo.sdk.range}` : 'not declared in package.json'}`,
  );
  if (repo.relatedDependencies.length > 0) {
    line(
      `  Related:   ${repo.relatedDependencies.map((dep) => `${dep.name}@${dep.range}`).join(', ')}`,
    );
  }
  if (repo.frameworks.length > 0) line(`  Framework: ${repo.frameworks.join(', ')}`);
  if (repo.httpRoutingIsAbstracted) {
    line(c.dim('  HTTP routing appears abstracted; header findings are reported as review.'));
  }
  line(
    `  Languages: ${repo.languages.typescript} TS, ${repo.languages.javascript} JS, ` +
      `${repo.languages.json} JSON, ${repo.languages.yaml} YAML`,
  );
  line();

  /* ---- Files ------------------------------------------------------------ */

  line(c.bold('Files'));
  line(
    `  Scanned:   ${report.summary.filesScanned}` +
      `   Skipped: ${report.summary.filesSkipped}` +
      `   Discovered: ${report.summary.filesDiscovered}`,
  );
  if (report.summary.commentOnlyMatches > 0) {
    line(
      c.dim(
        `  ${report.summary.commentOnlyMatches} match(es) ignored because they appear only in comments.`,
      ),
    );
  }
  line();

  /* ---- Findings --------------------------------------------------------- */

  if (report.findings.length === 0) {
    line(c.green('No findings.'));
    line();
  } else {
    for (const level of LEVEL_ORDER) {
      const forLevel = report.findings.filter((finding) => finding.level === level);
      if (forLevel.length === 0) continue;

      const heading = `${LEVEL_LABEL[level]} — ${forLevel.length} finding${forLevel.length === 1 ? '' : 's'}`;
      line(colorForLevel(c, level)(c.bold(heading)));
      line(c.dim(describeLevel(level)));
      line();

      let currentCategory = '';
      for (const finding of forLevel) {
        if (finding.category !== currentCategory) {
          currentCategory = finding.category;
          line(c.dim(`  ── ${currentCategory} ──`));
          line();
        }
        renderFinding(line, c, finding);
      }
    }
  }

  /* ---- Summary ---------------------------------------------------------- */

  const counts = report.summary.counts;
  line(c.bold('Summary'));
  line(
    `  ${counts.error} error, ${counts.warning} warning, ` +
      `${counts.review} review, ${counts.info} info`,
  );
  line(`  Unique files requiring changes: ${report.summary.filesRequiringChanges}`);
  line();

  const readiness = report.summary.readiness;
  line(c.bold('Estimated migration readiness'));
  line(`  ${scoreColor(c, readiness.score)(`${readiness.score} / 100`)}`);
  line(c.dim(`  ${readiness.explanation}`));
  line(c.dim(`  ${readiness.disclaimer}`));
  line();

  const effort = report.summary.effort;
  line(c.bold('Estimated migration effort'));
  if (effort.items.length === 0) {
    line('  No migration work identified.');
  } else {
    line(`  ${formatHours(effort.minHours)}–${formatHours(effort.maxHours)} hours total`);
    for (const item of effort.items) {
      line(
        `    ${item.label}: ${formatHours(item.minHours)}–${formatHours(item.maxHours)} h ` +
          c.dim(`(${item.ruleIds.join(', ')})`),
      );
    }
  }
  line(c.dim(`  Excludes: ${effort.excludes.join('; ')}.`));
  line();

  line(c.bold('MCP Apps readiness'));
  line(`  ${report.summary.appsReadiness}`);
  line(c.dim('  Informational only. MCP Apps is an optional extension.'));

  /* ---- Verbose ---------------------------------------------------------- */

  if (options.verbose) {
    line();
    line(c.bold('Verbose: rule execution'));
    for (const entry of options.trace ?? []) line(c.dim(`  ${entry}`));

    const commentMatches = options.commentOnlyMatches ?? [];
    if (commentMatches.length > 0) {
      line();
      line(c.bold('Verbose: ignored evidence (comment-only matches)'));
      for (const match of commentMatches) {
        line(c.dim(`  ${match.file}:${match.line} · ${match.ruleId} · ${match.text}`));
      }
    }
  }

  return `${out.join('\n')}\n`;
}

function renderFinding(
  line: (text?: string) => void,
  c: ChalkInstance,
  finding: Finding,
): void {
  const location = `${finding.file}:${finding.line}${finding.column ? `:${finding.column}` : ''}`;

  line(`  ${colorForLevel(c, finding.level)(LEVEL_LABEL[finding.level])} ${c.bold(finding.ruleId)}`);
  line(`  ${c.dim(`${location} · confidence: ${finding.confidence}`)}`);
  line(`  ${finding.title}`);
  line();
  line('  Found:');
  line(`    ${finding.evidence}`);
  line();
  line('  Why this matters:');
  for (const wrapped of wrap(finding.explanation, 74)) line(`    ${wrapped}`);
  line();
  line('  Migration:');
  for (const wrapped of wrap(finding.remediation, 74)) line(`    ${wrapped}`);
  line();
  line('  Source:');
  line(`    ${sourceLabel(finding)}`);
  line(`    ${c.dim(finding.source.url)}`);
  if (finding.transportApplicability) {
    line(`  ${c.dim(`Applies to transport: ${finding.transportApplicability}`)}`);
  }
  line();
}

/**
 * Source titles for SEPs already begin with their identifier, so prefixing the
 * `sep` field again would render "SEP-2243 — SEP-2243 — …".
 */
export function sourceLabel(finding: Finding): string {
  const { sep, title } = finding.source;
  if (!sep || title.startsWith(sep)) return title;
  return `${sep} — ${title}`;
}

function describeLevel(level: FindingLevel): string {
  switch (level) {
    case 'error':
      return '  Confirmed incompatibility with the target specification.';
    case 'warning':
      return '  Deprecated feature. Still fully functional during the deprecation window.';
    case 'review':
      return '  May require migration; static analysis cannot decide. Needs a human.';
    case 'info':
      return '  Non-breaking modernisation or opportunity. No action required.';
  }
}

function colorForLevel(c: ChalkInstance, level: FindingLevel): (text: string) => string {
  switch (level) {
    case 'error':
      return (text) => c.red(text);
    case 'warning':
      return (text) => c.yellow(text);
    case 'review':
      return (text) => c.cyan(text);
    case 'info':
      return (text) => c.blue(text);
  }
}

function scoreColor(c: ChalkInstance, score: number): (text: string) => string {
  if (score >= 85) return (text) => c.green(text);
  if (score >= 60) return (text) => c.yellow(text);
  return (text) => c.red(text);
}

export function formatHours(hours: number): string {
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

/** Wraps prose to a width so long explanations stay readable in a terminal. */
export function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if (current === '') {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== '') lines.push(current);
  return lines.length > 0 ? lines : [''];
}
