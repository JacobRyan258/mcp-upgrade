/**
 * Public type model for MCP Upgrade Scanner.
 *
 * The JSON report shape (`ScanReport`) is a stable public interface — see
 * `schemaVersion`. Additive changes bump the minor scanner version; breaking
 * changes bump `schemaVersion`.
 */

/* -------------------------------------------------------------------------- */
/* Core enums                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * ERROR   — confirmed incompatibility with the selected target specification.
 * WARNING — deprecated or strongly discouraged feature that still functions
 *           during the compatibility window. Never described as "breaking".
 * REVIEW  — suspicious pattern that may require migration but cannot be
 *           conclusively interpreted through static analysis.
 * INFO    — non-breaking modernization or product opportunity.
 */
export type FindingLevel = 'error' | 'warning' | 'review' | 'info';

export type Confidence = 'high' | 'medium' | 'low';

/** How safe an automated fix would be. No autofix is implemented in this release. */
export type AutofixSafety = 'safe' | 'suggested' | 'manual' | 'none';

/**
 * Transport classification for the scanned repository. Drives whether HTTP-only
 * rules (such as the required Streamable HTTP routing headers) apply at all.
 */
export type TransportType = 'stdio' | 'streamable-http' | 'mixed' | 'custom-http' | 'unknown';

export type RuleCategory =
  | 'stateless-lifecycle'
  | 'http-headers'
  | 'resource-errors'
  | 'tasks'
  | 'sampling'
  | 'roots'
  | 'logging'
  | 'apps-readiness';

/** File dialects the scanner understands. */
export type FileKind = 'ts' | 'js' | 'json' | 'yaml';

export type TargetStatus = 'release-candidate' | 'final' | 'draft';

/** MCP Apps readiness verdict. Informational only. */
export type AppsReadiness = 'LIKELY_READY' | 'POSSIBLE_CANDIDATE' | 'NO_SIGNAL' | 'NOT_APPLICABLE';

/* -------------------------------------------------------------------------- */
/* Sources                                                                     */
/* -------------------------------------------------------------------------- */

/** A citation to an official MCP specification page, changelog entry or SEP. */
export interface RuleSource {
  title: string;
  url: string;
  /** SEP identifier, e.g. "SEP-2567". Present when the rule traces to a SEP. */
  sep?: string;
}

/* -------------------------------------------------------------------------- */
/* Findings                                                                    */
/* -------------------------------------------------------------------------- */

export interface Finding {
  ruleId: string;
  level: FindingLevel;
  confidence: Confidence;
  category: string;
  title: string;
  /** Repository-relative POSIX path. Deterministic across platforms. */
  file: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column?: number;
  endLine?: number;
  /** Short, redacted, bounded excerpt of the matched source. */
  evidence: string;
  explanation: string;
  remediation: string;
  source: RuleSource;
  transportApplicability?: string;
  autofix: AutofixSafety;
}

/* -------------------------------------------------------------------------- */
/* Repository classification                                                   */
/* -------------------------------------------------------------------------- */

export interface DetectedDependency {
  name: string;
  /** Raw version range as declared in package.json, e.g. "^1.20.0". */
  range: string;
}

export interface RepositoryClassification {
  /** Absolute-free display path of the scan root. */
  root: string;
  /** True when the target was a single file rather than a directory. */
  singleFile: boolean;
  /** Whether the scanner believes this is an MCP server at all. */
  isLikelyMcpServer: boolean;
  /** Evidence strings behind `isLikelyMcpServer`, sorted and deduplicated. */
  mcpEvidence: string[];
  languages: { typescript: number; javascript: number; json: number; yaml: number };
  transport: TransportType;
  transportEvidence: string[];
  sdk: DetectedDependency | null;
  /** Other MCP-adjacent packages found in package.json. */
  relatedDependencies: DetectedDependency[];
  frameworks: string[];
  /** True when MCP HTTP handling appears to go through a wrapper/abstraction. */
  httpRoutingIsAbstracted: boolean;
  packageName: string | null;
}

/* -------------------------------------------------------------------------- */
/* Scanning                                                                    */
/* -------------------------------------------------------------------------- */

export interface Range {
  /** Inclusive start offset. */
  start: number;
  /** Exclusive end offset. */
  end: number;
}

/** A file that was read and prepared for rule execution. */
export interface PreparedFile {
  absPath: string;
  /** POSIX, repository-relative. Used in all output. */
  relPath: string;
  ext: string;
  kind: FileKind;
  content: string;
  /** Byte size on disk. */
  size: number;
  /** Offsets at which each 1-based line begins; `lineStarts[0]` is line 1. */
  lineStarts: number[];
  /** Offsets covered by comments. Matches here are not reported as findings. */
  commentRanges: Range[];
  /** True when the file lives under a test/fixture path. */
  isTestPath: boolean;
}

export type SkipReason =
  | 'ignored'
  | 'unsupported-extension'
  | 'too-large'
  | 'binary'
  | 'unreadable'
  | 'test-path'
  | 'symlink-outside-root';

export interface FileScanResult {
  file: string;
  scanned: boolean;
  skipped?: SkipReason;
  /** Bytes. Present when the file was stat-ed successfully. */
  size?: number;
  findingCount: number;
}

/** Everything a rule needs. Rules must not perform I/O of their own. */
export interface ScanContext {
  target: TargetSpec;
  repository: RepositoryClassification;
  files: PreparedFile[];
  options: ResolvedScanOptions;
  /** Structured trace sink, populated only in verbose mode. */
  trace: (message: string) => void;
  /** Records a match that was suppressed because it lived inside a comment. */
  noteCommentOnlyMatch: (ruleId: string, file: string, line: number, text: string) => void;
}

export interface TargetSpec {
  protocolVersion: string;
  status: TargetStatus;
  /** Protocol version the migration is assumed to start from. */
  baselineVersion: string;
}

/* -------------------------------------------------------------------------- */
/* Rules                                                                       */
/* -------------------------------------------------------------------------- */

export interface RuleApplicability {
  /** File dialects this rule inspects. */
  fileKinds: FileKind[];
  /**
   * Transports for which this rule produces findings. A rule listing only
   * `streamable-http`/`mixed`/`custom-http` will never fire on a stdio-only
   * repository.
   */
  transports: TransportType[];
}

export interface ScannerRule {
  id: string;
  title: string;
  category: RuleCategory;
  targetVersion: string;
  level: FindingLevel;
  defaultConfidence: Confidence;
  source: RuleSource;
  appliesTo: RuleApplicability;
  /** Whether an automated fix could ever be safe for this rule. */
  autofix: AutofixSafety;
  /** One-paragraph description used in `--verbose` output and the rule table. */
  description: string;
  scan(context: ScanContext): Promise<Finding[]>;
}

/* -------------------------------------------------------------------------- */
/* Options                                                                     */
/* -------------------------------------------------------------------------- */

export type OutputFormat = 'text' | 'json' | 'checklist';

export type FailOnLevel = 'error' | 'warning' | 'review';

export interface ResolvedScanOptions {
  /** Absolute, realpath-resolved scan root (the directory, even for single files). */
  rootDir: string;
  /** Absolute path of a single target file, when scanning one file. */
  singleFilePath: string | null;
  format: OutputFormat;
  target: string;
  ignore: string[];
  includeTests: boolean;
  minConfidence: Confidence;
  ci: boolean;
  failOn: FailOnLevel;
  color: boolean;
  verbose: boolean;
  /** Maximum file size in bytes that will be read. */
  maxFileBytes: number;
}

/* -------------------------------------------------------------------------- */
/* Scoring and effort                                                          */
/* -------------------------------------------------------------------------- */

export interface ScoreDeduction {
  ruleId: string;
  file: string;
  level: FindingLevel;
  confidence: Confidence;
  points: number;
  reason: string;
}

export interface ReadinessScore {
  /** 0-100, clamped. */
  score: number;
  /** Deterministic, sorted list of every deduction applied. */
  deductions: ScoreDeduction[];
  /** Human-readable derivation, e.g. "100 - 15 (…) - 5 (…) = 80". */
  explanation: string;
  /** Explicit non-certification notice. */
  disclaimer: string;
}

export interface EffortItem {
  key: string;
  label: string;
  minHours: number;
  maxHours: number;
  /** Rule IDs that contributed to this item. */
  ruleIds: string[];
  /** Files that contributed to this item. */
  files: string[];
}

export interface EffortEstimate {
  items: EffortItem[];
  minHours: number;
  maxHours: number;
  /** What the estimate deliberately excludes. */
  excludes: string[];
}

/* -------------------------------------------------------------------------- */
/* Report                                                                      */
/* -------------------------------------------------------------------------- */

export interface ScanSummary {
  filesDiscovered: number;
  filesScanned: number;
  filesSkipped: number;
  /** Distinct files carrying at least one finding at or above `review`. */
  filesRequiringChanges: number;
  counts: Record<FindingLevel, number>;
  /** Finding counts keyed by rule ID, sorted by key in JSON output. */
  byRule: Record<string, number>;
  readiness: ReadinessScore;
  effort: EffortEstimate;
  appsReadiness: AppsReadiness;
  /** Matches suppressed because they appeared only inside comments. */
  commentOnlyMatches: number;
}

export interface ScanReport {
  schemaVersion: '1.0';
  scannerVersion: string;
  /** ISO-8601. The only non-deterministic field in the report. */
  generatedAt: string;
  target: {
    protocolVersion: string;
    status: TargetStatus;
    baselineVersion: string;
  };
  repository: RepositoryClassification;
  summary: ScanSummary;
  findings: Finding[];
  files: FileScanResult[];
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/** Thrown for invalid CLI arguments or an unreadable target (exit code 2). */
export class UsageError extends Error {
  override readonly name = 'UsageError';
}

/** Thrown for an unexpected internal scanner failure (exit code 3). */
export class InternalScannerError extends Error {
  override readonly name = 'InternalScannerError';
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}
