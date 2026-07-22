/**
 * Downloadable report renderings.
 *
 * Every value interpolated here originates in scanned source code and is
 * therefore hostile. The HTML renderer escapes on every insertion; the Markdown
 * renderer neutralises the characters that would let evidence break out of its
 * code span and forge report structure.
 */
import { CLEAN_REPORT_DISCLAIMER, actionPlan, effortRange, groupFindings, summarise } from './present.js';
import type { PublishedReport } from './schema.js';

export interface ReportMeta {
  /** `owner/repo` or the uploaded file name. */
  sourceLabel: string;
  sourceType: 'zip' | 'github';
  repositoryUrl: string | null;
  commitSha: string | null;
  /** ISO timestamp of the scan. */
  scannedAt: string;
  /** Absolute URL of the hosted report, when one should be linked. */
  reportUrl?: string | null;
}

/* -------------------------------------------------------------------------- */
/* Markdown                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Escapes text for inclusion in Markdown body copy.
 *
 * Leading structural characters are the real risk: a finding title beginning
 * `# ` would otherwise forge a heading in a document a developer reads as a
 * checklist.
 */
function md(text: string): string {
  return text
    .replace(/[\r\n]+/g, ' ')
    .replace(/([\\`*_[\]()<>#+\-!|])/g, '\\$1')
    .trim();
}

/** Renders arbitrary text as an inline code span that cannot escape itself. */
function mdCode(text: string): string {
  const flat = text.replace(/[\r\n]+/g, ' ').trim();
  if (flat.length === 0) return '``';
  // Choose a fence longer than the longest backtick run inside the content.
  let longest = 0;
  for (const run of flat.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = '`'.repeat(longest + 1);
  const padded = flat.startsWith('`') || flat.endsWith('`') ? ` ${flat} ` : flat;
  return `${fence}${padded}${fence}`;
}

export function renderMarkdownChecklist(report: PublishedReport, meta: ReportMeta): string {
  const summary = summarise(report);
  const plan = actionPlan(report);
  const out: string[] = [];

  out.push(`# MCP upgrade checklist — ${md(meta.sourceLabel)}`);
  out.push('');
  out.push(`**Readiness score:** ${summary.score}/100 — ${md(summary.verdict.label)}`);
  out.push('');
  out.push(md(summary.verdict.summary));
  out.push('');
  out.push(`- Target protocol version: \`${md(summary.targetVersion)}\`${summary.targetIsReleaseCandidate ? ' (release candidate)' : ''}`);
  out.push(`- Upgrading from: \`${md(summary.baselineVersion)}\``);
  out.push(`- Scanned: ${md(meta.scannedAt)}`);
  if (meta.sourceType === 'github' && meta.repositoryUrl) {
    out.push(`- Repository: ${md(meta.repositoryUrl)}`);
    if (meta.commitSha) out.push(`- Commit: \`${md(meta.commitSha)}\``);
  } else {
    out.push(`- Source: uploaded archive`);
  }
  out.push(`- Files scanned: ${summary.filesScanned}`);
  if (summary.filesSkipped > 0) out.push(`- Files skipped: ${summary.filesSkipped}`);
  out.push('');
  out.push(
    `| Will break | Deprecated | Needs review | Informational |`,
  );
  out.push(`| --- | --- | --- | --- |`);
  out.push(
    `| ${summary.errors} | ${summary.warnings} | ${summary.reviews} | ${summary.infos} |`,
  );
  out.push('');

  if (summary.partial) {
    out.push('> **This scan was partial.** Some files were not read, so findings may be incomplete.');
    for (const reason of summary.partialReasons) out.push(`> - ${md(reason)}`);
    out.push('');
  }

  if (!summary.isLikelyMcpServer) {
    out.push(
      '> **Note:** we did not find clear signs that this project is an MCP server. If it is, the scan may have missed the relevant files.',
    );
    out.push('');
  }

  const effort = effortRange(report);
  if (effort) {
    out.push(`**Estimated effort:** ${md(effort)}`);
    out.push('');
    out.push('This estimate excludes ' + report.summary.effort.excludes.map(md).join(', ') + '.');
    out.push('');
  }

  out.push('## What to do, in order');
  out.push('');
  if (plan.length === 0) {
    out.push('No action items. ' + md(CLEAN_REPORT_DISCLAIMER));
    out.push('');
  } else {
    plan.forEach((item, index) => {
      out.push(`### ${index + 1}. ${md(item.guide.headline)}`);
      out.push('');
      out.push(`- [ ] ${md(item.guide.askYourDeveloper)}`);
      out.push('');
      out.push(`**What we found:** ${md(item.guide.whatWasFound)}`);
      out.push('');
      out.push(`**Why it matters:** ${md(item.guide.whyItMatters)}`);
      out.push('');
      out.push(`**What may stop working:** ${md(item.guide.whatMayStopWorking)}`);
      out.push('');
      out.push(`**Technical fix:** ${md(item.remediation)}`);
      out.push('');
      out.push(
        `**Rule:** ${mdCode(item.ruleId)} · ${item.occurrences} occurrence${item.occurrences === 1 ? '' : 's'} in ${item.files.length} file${item.files.length === 1 ? '' : 's'}`,
      );
      out.push('');
      out.push(`**Official source:** [${md(item.sourceTitle)}](${encodeURI(item.sourceUrl)})`);
      out.push('');
      out.push('<details><summary>Where</summary>');
      out.push('');
      for (const file of item.files) out.push(`- ${mdCode(file)}`);
      out.push('');
      out.push('</details>');
      out.push('');
    });
  }

  out.push('## Every finding');
  out.push('');
  const groups = groupFindings(report.findings);
  if (groups.length === 0) {
    out.push('No findings.');
    out.push('');
  }
  for (const group of groups) {
    out.push(`### ${md(group.title)}`);
    out.push('');
    for (const { finding, levelLabel } of group.findings) {
      out.push(
        `- **${md(levelLabel)}** · ${mdCode(finding.ruleId)} · ${mdCode(`${finding.file}:${finding.line}`)}`,
      );
      out.push(`  - ${md(finding.title)}`);
      out.push(`  - Evidence: ${mdCode(finding.evidence)}`);
      out.push(`  - Confidence: ${md(finding.confidence)}`);
    }
    out.push('');
  }

  out.push('---');
  out.push('');
  out.push(md(CLEAN_REPORT_DISCLAIMER));
  out.push('');
  out.push(md(report.summary.readiness.disclaimer));
  if (meta.reportUrl) {
    out.push('');
    out.push(`Full report: ${md(meta.reportUrl)}`);
  }
  out.push('');
  return out.join('\n');
}

/* -------------------------------------------------------------------------- */
/* Printable HTML                                                              */
/* -------------------------------------------------------------------------- */

/**
 * HTML-escapes a value for insertion into element content or a quoted
 * attribute. Forward slash is escaped too so a value can never begin a closing
 * tag even in a parser operating in a lenient mode.
 */
function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\//g, '&#47;');
}

/** Only `https:` links from the scanner's own rule sources are ever emitted. */
function safeHref(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

const PRINT_STYLES = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: #18181b; background: #fff; margin: 0; padding: 40px 32px; max-width: 900px; }
h1 { font-size: 26px; margin: 0 0 4px; letter-spacing: -0.02em; }
h2 { font-size: 19px; margin: 36px 0 12px; padding-bottom: 6px; border-bottom: 1px solid #e4e4e7; }
h3 { font-size: 16px; margin: 24px 0 8px; }
p { margin: 0 0 10px; }
.sub { color: #52525b; margin-bottom: 24px; }
.score { display: flex; align-items: baseline; gap: 12px; margin: 20px 0 8px; }
.score b { font-size: 44px; line-height: 1; letter-spacing: -0.03em; }
.band { font-weight: 600; padding: 3px 10px; border-radius: 999px; font-size: 13px; }
.band-ready { background: #dcfce7; color: #14532d; }
.band-needs-attention { background: #fef3c7; color: #713f12; }
.band-high-risk { background: #fee2e2; color: #7f1d1d; }
table { border-collapse: collapse; width: 100%; margin: 12px 0 20px; font-size: 14px; }
th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #e4e4e7; }
th { font-weight: 600; color: #52525b; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px;
  background: #f4f4f5; padding: 1px 5px; border-radius: 4px; word-break: break-all; }
.finding { border: 1px solid #e4e4e7; border-radius: 8px; padding: 14px 16px; margin: 0 0 12px; }
.finding-head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
.tag { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;
  padding: 2px 7px; border-radius: 4px; }
.tag-error { background: #fee2e2; color: #7f1d1d; }
.tag-warning { background: #fef3c7; color: #713f12; }
.tag-review { background: #e0e7ff; color: #312e81; }
.tag-info { background: #f4f4f5; color: #3f3f46; }
.label { font-weight: 600; }
.note { background: #f4f4f5; border-left: 3px solid #a1a1aa; padding: 10px 14px; margin: 14px 0; }
.note-warn { background: #fffbeb; border-left-color: #d97706; }
footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #e4e4e7;
  color: #52525b; font-size: 13px; }
ul { margin: 0 0 10px; padding-left: 20px; }
@media print {
  body { padding: 0; max-width: none; }
  .finding { break-inside: avoid; }
  h2 { break-after: avoid; }
}
`.trim();

export function renderPrintableHtml(report: PublishedReport, meta: ReportMeta): string {
  const summary = summarise(report);
  const plan = actionPlan(report);
  const groups = groupFindings(report.findings);
  const out: string[] = [];

  out.push('<!doctype html>');
  out.push('<html lang="en"><head><meta charset="utf-8">');
  out.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  out.push(`<title>MCP upgrade report — ${esc(meta.sourceLabel)}</title>`);
  // No external references of any kind: this file must render identically
  // offline, and must never phone home from a reviewer's machine.
  out.push(`<style>${PRINT_STYLES}</style>`);
  out.push('</head><body>');

  out.push(`<h1>MCP upgrade report</h1>`);
  out.push(`<p class="sub">${esc(meta.sourceLabel)} · scanned ${esc(meta.scannedAt)}</p>`);

  out.push('<div class="score">');
  out.push(`<b>${esc(summary.score)}</b><span>/100</span>`);
  out.push(`<span class="band band-${esc(summary.verdict.band)}">${esc(summary.verdict.label)}</span>`);
  out.push('</div>');
  out.push(`<p>${esc(summary.verdict.summary)}</p>`);

  out.push('<table><thead><tr>');
  out.push('<th>Will break</th><th>Deprecated</th><th>Needs review</th><th>Informational</th>');
  out.push('<th>Files scanned</th><th>Files skipped</th>');
  out.push('</tr></thead><tbody><tr>');
  out.push(
    `<td>${esc(summary.errors)}</td><td>${esc(summary.warnings)}</td><td>${esc(summary.reviews)}</td><td>${esc(summary.infos)}</td>`,
  );
  out.push(`<td>${esc(summary.filesScanned)}</td><td>${esc(summary.filesSkipped)}</td>`);
  out.push('</tr></tbody></table>');

  out.push('<table><tbody>');
  out.push(`<tr><th>Target protocol version</th><td><code>${esc(summary.targetVersion)}</code>${summary.targetIsReleaseCandidate ? ' (release candidate)' : ''}</td></tr>`);
  out.push(`<tr><th>Upgrading from</th><td><code>${esc(summary.baselineVersion)}</code></td></tr>`);
  out.push(`<tr><th>Transport</th><td>${esc(summary.transport)}</td></tr>`);
  if (meta.sourceType === 'github' && meta.repositoryUrl) {
    const href = safeHref(meta.repositoryUrl);
    out.push(
      `<tr><th>Repository</th><td>${href ? `<a href="${esc(href)}">${esc(meta.repositoryUrl)}</a>` : esc(meta.repositoryUrl)}</td></tr>`,
    );
    if (meta.commitSha) {
      out.push(`<tr><th>Commit</th><td><code>${esc(meta.commitSha)}</code></td></tr>`);
    }
  } else {
    out.push('<tr><th>Source</th><td>Uploaded archive</td></tr>');
  }
  const effort = effortRange(report);
  if (effort) out.push(`<tr><th>Estimated effort</th><td>${esc(effort)}</td></tr>`);
  out.push('</tbody></table>');

  if (summary.partial) {
    out.push('<div class="note note-warn"><p><span class="label">This scan was partial.</span> Some files were not read, so findings may be incomplete.</p><ul>');
    for (const reason of summary.partialReasons) out.push(`<li>${esc(reason)}</li>`);
    out.push('</ul></div>');
  }
  if (!summary.isLikelyMcpServer) {
    out.push(
      '<div class="note"><p>We did not find clear signs that this project is an MCP server. If it is, the scan may have missed the relevant files.</p></div>',
    );
  }

  out.push('<h2>What to do, in order</h2>');
  if (plan.length === 0) {
    out.push(`<p>No action items. ${esc(CLEAN_REPORT_DISCLAIMER)}</p>`);
  }
  plan.forEach((item, index) => {
    out.push('<div class="finding">');
    out.push(`<h3>${esc(index + 1)}. ${esc(item.guide.headline)}</h3>`);
    out.push(`<p><span class="label">Ask your developer:</span> ${esc(item.guide.askYourDeveloper)}</p>`);
    out.push(`<p><span class="label">What we found:</span> ${esc(item.guide.whatWasFound)}</p>`);
    out.push(`<p><span class="label">Why it matters:</span> ${esc(item.guide.whyItMatters)}</p>`);
    out.push(`<p><span class="label">What may stop working:</span> ${esc(item.guide.whatMayStopWorking)}</p>`);
    out.push(`<p><span class="label">Technical fix:</span> ${esc(item.remediation)}</p>`);
    out.push(
      `<p><code>${esc(item.ruleId)}</code> · ${esc(item.occurrences)} occurrence${item.occurrences === 1 ? '' : 's'} in ${esc(item.files.length)} file${item.files.length === 1 ? '' : 's'}</p>`,
    );
    const href = safeHref(item.sourceUrl);
    if (href) out.push(`<p><a href="${esc(href)}">${esc(item.sourceTitle)}</a></p>`);
    out.push('<ul>');
    for (const file of item.files) out.push(`<li><code>${esc(file)}</code></li>`);
    out.push('</ul>');
    out.push('</div>');
  });

  out.push('<h2>Every finding</h2>');
  if (groups.length === 0) out.push('<p>No findings.</p>');
  for (const group of groups) {
    out.push(`<h3>${esc(group.title)}</h3>`);
    for (const { finding, levelLabel } of group.findings) {
      out.push('<div class="finding">');
      out.push('<div class="finding-head">');
      out.push(`<span class="tag tag-${esc(finding.level)}">${esc(levelLabel)}</span>`);
      out.push(`<code>${esc(finding.ruleId)}</code>`);
      out.push(`<code>${esc(finding.file)}:${esc(finding.line)}</code>`);
      out.push('</div>');
      out.push(`<p>${esc(finding.title)}</p>`);
      out.push(`<p><code>${esc(finding.evidence)}</code></p>`);
      out.push(`<p>Confidence: ${esc(finding.confidence)}</p>`);
      out.push('</div>');
    }
  }

  out.push('<footer>');
  out.push(`<p>${esc(CLEAN_REPORT_DISCLAIMER)}</p>`);
  out.push(`<p>${esc(report.summary.readiness.disclaimer)}</p>`);
  out.push(
    `<p>Generated by mcp-upgrade ${esc(report.scannerVersion)} · schema ${esc(report.schemaVersion)}</p>`,
  );
  out.push('</footer>');
  out.push('</body></html>');
  return out.join('\n');
}

/** A safe download file name derived from the source label. */
export function downloadFileName(sourceLabel: string, extension: string): string {
  const base =
    sourceLabel
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'report';
  return `mcp-upgrade-${base}.${extension}`;
}
