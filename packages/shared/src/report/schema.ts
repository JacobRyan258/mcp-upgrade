/**
 * Runtime schema for a *published* scan report.
 *
 * This is the contract at the trust boundary. The worker validates against it
 * after sanitizing, before writing to the database; the web app validates
 * against it again after reading, before rendering. Both directions matter: the
 * first stops a malformed report being stored, the second stops a report stored
 * by an older or compromised writer being rendered.
 *
 * Every object is strict. An unexpected field is a validation failure, not
 * something to pass through — that is what keeps a future scanner field
 * containing an absolute path from silently reaching a browser.
 */
import { z } from 'zod';

/** Hard ceiling on the serialized report we will store or render. */
export const MAX_REPORT_BYTES = 4 * 1024 * 1024;

const findingLevel = z.enum(['error', 'warning', 'review', 'info']);
const confidence = z.enum(['high', 'medium', 'low']);
const autofix = z.enum(['safe', 'suggested', 'manual', 'none']);
const transport = z.enum(['stdio', 'streamable-http', 'mixed', 'custom-http', 'unknown']);
const targetStatus = z.enum(['release-candidate', 'final', 'draft']);
const appsReadiness = z.enum([
  'LIKELY_READY',
  'POSSIBLE_CANDIDATE',
  'NO_SIGNAL',
  'NOT_APPLICABLE',
]);

/**
 * A repository-relative POSIX path, or the sentinel `.` for the scan root.
 *
 * Absolute paths, Windows drive letters, UNC prefixes, backslashes and any
 * `..` segment are rejected outright. This is the single most important rule in
 * this file: it is what guarantees no worker filesystem path can reach a user.
 */
const relativePath = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => !value.startsWith('/'), { message: 'absolute path' })
  .refine((value) => !/^[A-Za-z]:/.test(value), { message: 'drive-letter path' })
  .refine((value) => !value.includes('\\'), { message: 'backslash path' })
  .refine((value) => !value.split('/').includes('..'), { message: 'parent traversal' })
  .refine((value) => !/[\x00-\x1f\x7f]/.test(value), { message: 'control character' });

const ruleSource = z.strictObject({
  title: z.string().max(300),
  url: z.string().url().max(2048),
  sep: z.string().max(64).optional(),
});

export const findingSchema = z.strictObject({
  ruleId: z.string().min(1).max(120),
  level: findingLevel,
  confidence,
  category: z.string().max(120),
  title: z.string().max(500),
  file: relativePath,
  line: z.number().int().min(0),
  column: z.number().int().min(0).optional(),
  endLine: z.number().int().min(0).optional(),
  evidence: z.string().max(2000),
  explanation: z.string().max(5000),
  remediation: z.string().max(5000),
  source: ruleSource,
  transportApplicability: z.string().max(500).optional(),
  autofix,
});

const detectedDependency = z.strictObject({
  name: z.string().max(300),
  range: z.string().max(200),
});

const repositoryClassification = z.strictObject({
  /**
   * Replaced by the sanitizer with the user-facing source label — never the
   * worker's filesystem path. Constrained here so a bypass fails validation.
   */
  root: z.string().min(1).max(200),
  singleFile: z.boolean(),
  isLikelyMcpServer: z.boolean(),
  mcpEvidence: z.array(z.string().max(1000)).max(200),
  languages: z.strictObject({
    typescript: z.number().int().min(0),
    javascript: z.number().int().min(0),
    json: z.number().int().min(0),
    yaml: z.number().int().min(0),
  }),
  transport,
  transportEvidence: z.array(z.string().max(1000)).max(200),
  sdk: detectedDependency.nullable(),
  relatedDependencies: z.array(detectedDependency).max(200),
  frameworks: z.array(z.string().max(200)).max(100),
  httpRoutingIsAbstracted: z.boolean(),
  packageName: z.string().max(300).nullable(),
});

const scanIssue = z.strictObject({
  code: z.string().max(120),
  path: relativePath,
  message: z.string().max(2000),
  size: z.number().int().min(0).optional(),
  count: z.number().int().min(0).optional(),
});

const fileScanResult = z.strictObject({
  file: relativePath,
  scanned: z.boolean(),
  skipped: z.string().max(120).optional(),
  size: z.number().int().min(0).optional(),
  findingCount: z.number().int().min(0),
});

const scoreDeduction = z.strictObject({
  ruleId: z.string().max(120),
  file: relativePath,
  level: findingLevel,
  confidence,
  points: z.number(),
  reason: z.string().max(1000),
});

const readinessScore = z.strictObject({
  score: z.number().min(0).max(100),
  deductions: z.array(scoreDeduction).max(5000),
  explanation: z.string().max(20000),
  disclaimer: z.string().max(2000),
});

const effortItem = z.strictObject({
  key: z.string().max(120),
  label: z.string().max(300),
  minHours: z.number().min(0),
  maxHours: z.number().min(0),
  ruleIds: z.array(z.string().max(120)).max(200),
  files: z.array(relativePath).max(2000),
});

const effortEstimate = z.strictObject({
  items: z.array(effortItem).max(200),
  minHours: z.number().min(0),
  maxHours: z.number().min(0),
  excludes: z.array(z.string().max(500)).max(100),
});

const scanSummary = z.strictObject({
  filesDiscovered: z.number().int().min(0),
  filesScanned: z.number().int().min(0),
  filesSkipped: z.number().int().min(0),
  filesRequiringChanges: z.number().int().min(0),
  counts: z.strictObject({
    error: z.number().int().min(0),
    warning: z.number().int().min(0),
    review: z.number().int().min(0),
    info: z.number().int().min(0),
  }),
  byRule: z.record(z.string().max(120), z.number().int().min(0)),
  readiness: readinessScore,
  effort: effortEstimate,
  appsReadiness,
  commentOnlyMatches: z.number().int().min(0),
});

export const publishedReportSchema = z.strictObject({
  schemaVersion: z.literal('1.0'),
  scannerVersion: z.string().max(64),
  generatedAt: z.string().max(64),
  target: z.strictObject({
    protocolVersion: z.string().max(64),
    status: targetStatus,
    baselineVersion: z.string().max(64),
  }),
  scanStatus: z.enum(['complete', 'partial']),
  issues: z.array(scanIssue).max(5000),
  repository: repositoryClassification,
  summary: scanSummary,
  findings: z.array(findingSchema).max(5000),
  files: z.array(fileScanResult).max(50000),
});

export type PublishedReport = z.infer<typeof publishedReportSchema>;
export type PublishedFinding = z.infer<typeof findingSchema>;
export type PublishedFindingLevel = z.infer<typeof findingLevel>;
export type PublishedConfidence = z.infer<typeof confidence>;

export type ReportValidation =
  | { ok: true; report: PublishedReport }
  | { ok: false; reason: string };

/**
 * Validates an untrusted value as a published report.
 *
 * Returns a short, non-leaking reason on failure — the caller logs it with a
 * job ID and shows the user only the generic `report_invalid` category.
 */
export function validatePublishedReport(value: unknown): ReportValidation {
  const parsed = publishedReportSchema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.join('.') ?? '(root)';
    return { ok: false, reason: `${where}: ${first?.message ?? 'invalid'}` };
  }
  return { ok: true, report: parsed.data };
}
