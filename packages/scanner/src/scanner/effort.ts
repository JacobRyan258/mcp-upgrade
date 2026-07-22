import { EFFORT_EXCLUSIONS } from '../constants.js';
import { compareCodeUnits } from '../order.js';
import type { EffortEstimate, EffortItem, Finding } from '../types.js';

/**
 * Deterministic, rule-based effort estimation.
 *
 * Estimates are ranges, never a single number. Findings are deduplicated into
 * effort categories before totalling, because "session/lifecycle redesign" is
 * one piece of work no matter how many files it touches.
 */

interface EffortCategory {
  key: string;
  label: string;
  minHours: number;
  maxHours: number;
  /**
   * `once` — the category contributes its range one time, however many findings
   * map to it (a redesign).
   * `per-file` — it contributes once per distinct file, capped, because each
   * file is a distinct implementation pattern to work through.
   */
  mode: 'once' | 'per-file';
  ruleIds: string[];
}

/** Caps per-file scaling so a large repository cannot produce an absurd total. */
const PER_FILE_CAP = 5;

const CATEGORIES: EffortCategory[] = [
  {
    key: 'session-lifecycle',
    label: 'Session and lifecycle redesign',
    minHours: 2,
    maxHours: 8,
    mode: 'once',
    ruleIds: [
      'MCP2026-SESSION-001',
      'MCP2026-SESSION-002',
      'MCP2026-SESSION-003',
      'MCP2026-LIFECYCLE-001',
      'MCP2026-LIFECYCLE-002',
      'MCP2026-LIFECYCLE-003',
    ],
  },
  {
    key: 'header-migration',
    label: 'Header and request-handler migration',
    minHours: 0.5,
    maxHours: 2,
    mode: 'per-file',
    ruleIds: ['MCP2026-HEADER-001', 'MCP2026-HEADER-002'],
  },
  {
    key: 'literal-config',
    label: 'Literal and configuration correction',
    minHours: 0.25,
    maxHours: 0.5,
    mode: 'per-file',
    ruleIds: [
      'MCP2026-ERROR-001',
      'MCP2026-ERROR-002',
      'MCP2026-ERROR-003',
      'MCP2026-SAMPLING-002',
    ],
  },
  {
    key: 'tasks-migration',
    label: 'Tasks extension migration',
    minHours: 2,
    maxHours: 6,
    mode: 'once',
    ruleIds: [
      'MCP2026-TASKS-001',
      'MCP2026-TASKS-002',
      'MCP2026-TASKS-003',
      'MCP2026-TASKS-004',
    ],
  },
  {
    key: 'sampling-replacement',
    label: 'Sampling replacement',
    minHours: 2,
    maxHours: 8,
    mode: 'once',
    ruleIds: ['MCP2026-SAMPLING-001'],
  },
  {
    key: 'roots-migration',
    label: 'Roots migration',
    minHours: 0.5,
    maxHours: 3,
    mode: 'once',
    ruleIds: ['MCP2026-ROOTS-001', 'MCP2026-ROOTS-002'],
  },
  {
    key: 'logging-migration',
    label: 'Logging migration',
    minHours: 0.5,
    maxHours: 2,
    mode: 'once',
    ruleIds: ['MCP2026-LOGGING-001', 'MCP2026-LOGGING-002'],
  },
  {
    key: 'sdk-v2-migration',
    label: 'TypeScript SDK v2 migration',
    minHours: 2,
    maxHours: 8,
    mode: 'once',
    ruleIds: ['MCP2026-SDK-001'],
  },
  {
    key: 'mrtr-migration',
    label: 'Multi round-trip request migration',
    minHours: 2,
    maxHours: 8,
    mode: 'once',
    ruleIds: ['MCP2026-MRTR-001', 'MCP2026-MRTR-002', 'MCP2026-MRTR-003'],
  },
  {
    key: 'elicitation-removal',
    label: 'Elicitation removal',
    minHours: 1,
    maxHours: 4,
    mode: 'once',
    ruleIds: ['MCP2026-ELICITATION-001'],
  },
  {
    key: 'protocol-shapes',
    label: 'Protocol request and result shape migration',
    minHours: 0.5,
    maxHours: 2,
    mode: 'per-file',
    ruleIds: [
      'MCP2026-RESULT-001',
      'MCP2026-META-001',
      'MCP2026-DISCOVERY-001',
      'MCP2026-CACHE-001',
    ],
  },
];

/** Anything left over that still needs a human decision. */
const MANUAL_REVIEW: EffortCategory = {
  key: 'manual-review',
  label: 'Manual review items',
  minHours: 0.25,
  maxHours: 1,
  mode: 'per-file',
  ruleIds: ['MCP2026-SESSION-004'],
};

/** Neutral fallback for a future actionable rule that has not been estimated yet. */
const ADDITIONAL_MIGRATION: EffortCategory = {
  key: 'additional-migration',
  label: 'Additional migration work',
  minHours: 0.5,
  maxHours: 2,
  mode: 'per-file',
  ruleIds: [],
};

export function estimateEffort(findings: Finding[]): EffortEstimate {
  // INFO findings never carry effort — they describe opportunities, not work.
  const actionable = findings.filter((finding) => finding.level !== 'info');

  const categoryFor = new Map<string, EffortCategory>();
  for (const category of [...CATEGORIES, MANUAL_REVIEW]) {
    for (const ruleId of category.ruleIds) categoryFor.set(ruleId, category);
  }

  const buckets = new Map<string, { category: EffortCategory; files: Set<string>; rules: Set<string> }>();

  for (const finding of actionable) {
    const category = categoryFor.get(finding.ruleId) ?? ADDITIONAL_MIGRATION;
    const bucket = buckets.get(category.key) ?? {
      category,
      files: new Set<string>(),
      rules: new Set<string>(),
    };
    bucket.files.add(finding.file);
    bucket.rules.add(finding.ruleId);
    buckets.set(category.key, bucket);
  }

  const items: EffortItem[] = [];
  for (const bucket of buckets.values()) {
    const { category } = bucket;
    const multiplier =
      category.mode === 'once' ? 1 : Math.min(bucket.files.size, PER_FILE_CAP);

    items.push({
      key: category.key,
      label:
        category.mode === 'per-file' && multiplier > 1
          ? `${category.label} (${multiplier} implementation ${multiplier === 1 ? 'site' : 'sites'})`
          : category.label,
      minHours: round(category.minHours * multiplier),
      maxHours: round(category.maxHours * multiplier),
      ruleIds: [...bucket.rules].sort(compareCodeUnits),
      files: [...bucket.files].sort(compareCodeUnits),
    });
  }

  items.sort((a, b) => compareCodeUnits(a.key, b.key));

  return {
    items,
    minHours: round(items.reduce((sum, item) => sum + item.minHours, 0)),
    maxHours: round(items.reduce((sum, item) => sum + item.maxHours, 0)),
    excludes: [...EFFORT_EXCLUSIONS],
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
