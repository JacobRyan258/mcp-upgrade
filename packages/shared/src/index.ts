/**
 * Contracts shared by the hosted web app and the scanning worker.
 *
 * Everything exported here is isomorphic: it runs unchanged in a browser
 * bundle, a Next.js server component and the worker process. It has exactly one
 * runtime dependency (Zod) and imports no Node built-ins, which is what keeps
 * server-only code — database access, filesystem work, secrets — from being
 * reachable through this module by accident.
 */
export {
  PLANS,
  DEFAULT_PLAN_ID,
  isPlanId,
  planLimits,
  resolvePlan,
  billingPeriodKey,
  billingPeriodResetsAt,
} from './plans.js';
export type {
  PlanId,
  PlanLimits,
  PlanResolutionInput,
  ResolvedPlan,
  SubscriptionSnapshot,
} from './plans.js';

export {
  SCAN_ERROR_CATEGORIES,
  isScanErrorCategory,
  describeScanError,
  shouldRefundUsage,
} from './errors.js';
export type { ScanErrorCategory } from './errors.js';

export {
  parseGitHubRepoUrl,
  isCommitSha,
  shortSha,
  commitUrl,
} from './github.js';
export type { GitHubRepoRef, GitHubUrlRejection, GitHubUrlResult } from './github.js';

export {
  SCAN_STATUSES,
  isScanJobStatus,
  isTerminalStatus,
  toSourceLabel,
  MAX_SOURCE_LABEL_LENGTH,
} from './scan.js';
export type { ScanJobStatus, ScanJobSummary, ScanSourceType } from './scan.js';

export { ABSOLUTE_LIMITS, ingestionLimitsFor, formatBytes } from './limits.js';
export type { IngestionLimits } from './limits.js';

export {
  MAX_REPORT_BYTES,
  publishedReportSchema,
  findingSchema,
  validatePublishedReport,
} from './report/schema.js';
export type {
  PublishedReport,
  PublishedFinding,
  PublishedFindingLevel,
  PublishedConfidence,
  ReportValidation,
} from './report/schema.js';

export {
  guideForRule,
  hasGuide,
  coveredRuleIds,
  themeLabel,
  themeRank,
} from './report/explain.js';
export type { PlainExplanation, PlainTheme, RuleGuide } from './report/explain.js';

export {
  CLEAN_REPORT_DISCLAIMER,
  LEVEL_LABELS,
  LEVEL_DESCRIPTIONS,
  CONFIDENCE_DESCRIPTIONS,
  readinessVerdict,
  summarise,
  transportLabel,
  orderFindings,
  presentFinding,
  groupFindings,
  actionPlan,
  effortRange,
} from './report/present.js';
export type {
  ActionItem,
  PresentedFinding,
  PresentedGroup,
  ReadinessBand,
  ReadinessVerdict,
  TopSummary,
} from './report/present.js';

export {
  renderMarkdownChecklist,
  renderPrintableHtml,
  downloadFileName,
} from './report/download.js';
export type { ReportMeta } from './report/download.js';
