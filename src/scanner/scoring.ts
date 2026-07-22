import { SCORE_DISCLAIMER } from '../constants.js';
import type { Finding, ReadinessScore, ScoreDeduction } from '../types.js';

/**
 * Deterministic readiness scoring.
 *
 * The deduction unit is the pair (ruleId, file), not the raw match count: a
 * server that reads `Mcp-Session-Id` on twenty lines of one file has one problem
 * to fix, not twenty. All locations are still reported.
 */

const STARTING_SCORE = 100;

function deductionFor(finding: Finding): number {
  switch (finding.level) {
    case 'error':
      return finding.confidence === 'high' ? 15 : 10;
    case 'warning':
      return 5;
    case 'review':
      return 3;
    case 'info':
      return 0;
  }
}

export function computeReadiness(findings: Finding[]): ReadinessScore {
  const byKey = new Map<string, ScoreDeduction>();

  for (const finding of findings) {
    const points = deductionFor(finding);
    if (points === 0) continue;

    const key = `${finding.ruleId} ${finding.file}`;
    const existing = byKey.get(key);
    // Keep the most severe occurrence of a rule within a file.
    if (existing && existing.points >= points) continue;

    byKey.set(key, {
      ruleId: finding.ruleId,
      file: finding.file,
      level: finding.level,
      confidence: finding.confidence,
      points,
      reason:
        finding.level === 'error'
          ? `${finding.confidence}-confidence incompatibility (${finding.ruleId})`
          : finding.level === 'warning'
            ? `deprecated feature in use (${finding.ruleId})`
            : `pattern requiring manual review (${finding.ruleId})`,
    });
  }

  const deductions = [...byKey.values()].sort(
    (a, b) =>
      a.ruleId.localeCompare(b.ruleId, 'en') ||
      a.file.localeCompare(b.file, 'en'),
  );

  const total = deductions.reduce((sum, deduction) => sum + deduction.points, 0);
  const score = Math.max(0, Math.min(100, STARTING_SCORE - total));

  const explanation = buildExplanation(deductions, total, score);

  return { score, deductions, explanation, disclaimer: SCORE_DISCLAIMER };
}

function buildExplanation(
  deductions: ScoreDeduction[],
  total: number,
  score: number,
): string {
  if (deductions.length === 0) {
    return `Started at ${STARTING_SCORE} with no deductions applied. Score: ${score}.`;
  }

  // Group for a readable derivation rather than listing every single deduction.
  const groups = new Map<string, { count: number; points: number }>();
  for (const deduction of deductions) {
    const label = `${deduction.level}/${deduction.confidence}`;
    const group = groups.get(label) ?? { count: 0, points: 0 };
    group.count += 1;
    group.points += deduction.points;
    groups.set(label, group);
  }

  const parts = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'en'))
    .map(([label, group]) => `${group.count} × ${label} = −${group.points}`);

  const arithmetic =
    total > STARTING_SCORE
      ? `${STARTING_SCORE} − ${total} → ${score} (floored at 0).`
      : `${STARTING_SCORE} − ${total} = ${score}.`;

  return (
    `Started at ${STARTING_SCORE}. Deductions are applied once per rule per file ` +
    `(${deductions.length} unique rule/file pairs): ${parts.join(', ')}. ` +
    arithmetic
  );
}
