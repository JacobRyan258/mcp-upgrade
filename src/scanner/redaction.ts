import { MAX_EVIDENCE_LENGTH } from '../constants.js';

/**
 * Evidence sanitisation.
 *
 * Scanned repositories contain credentials. Every excerpt that reaches a report
 * passes through `redact()` first: nothing here is best-effort prettification,
 * it is the boundary that keeps secrets out of a report a developer is expected
 * to paste into a public GitHub issue.
 */

interface RedactionRule {
  kind: string;
  pattern: RegExp;
  /**
   * Replacement. Group 1, when the pattern defines one, is the non-secret
   * prefix that is preserved so the finding still reads sensibly.
   */
  replace: (match: string, ...groups: string[]) => string;
}

const placeholder = (kind: string): string => `[REDACTED:${kind}]`;

/**
 * Ordered — earlier rules win. Patterns are deliberately narrow: a false
 * redaction costs a developer the evidence line, so each rule requires a
 * credential-shaped key or a recognised token prefix rather than guessing from
 * entropy alone. The trailing high-entropy rule is the only exception and is
 * tuned to sequences no ordinary identifier reaches.
 */
const RULES: RedactionRule[] = [
  {
    // PEM blocks. Matched first: their body would otherwise trip other rules.
    // The complete block is the first alternative so it wins; the second
    // catches a truncated block, which must still never reach a report.
    kind: 'private-key',
    pattern:
      /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----|-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*/g,
    replace: () => placeholder('private-key'),
  },
  {
    kind: 'authorization-header',
    pattern: /((?:authorization|proxy-authorization)["'`\]]*\s*[:=]\s*["'`])[^"'`\n]+/gi,
    replace: (_m, prefix) => `${prefix}${placeholder('authorization')}`,
  },
  {
    kind: 'bearer-token',
    pattern: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g,
    replace: (_m, scheme) => `${scheme} ${placeholder('token')}`,
  },
  {
    // Known vendor token prefixes, which are unambiguous wherever they appear.
    kind: 'vendor-token',
    pattern:
      /\b(?:sk-[A-Za-z0-9_-]{16,}|xox[abposr]-[A-Za-z0-9-]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{22,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{28,}|(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_-]{20,}|ya29\.[0-9A-Za-z_-]{10,})/g,
    replace: () => placeholder('token'),
  },
  {
    kind: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
    replace: () => placeholder('jwt'),
  },
  {
    // Bounded quantifiers throughout: the unbounded form is quadratic on long
    // credential-free runs of the scheme character class, and redact() runs on
    // hostile input.
    kind: 'connection-string',
    pattern: /\b([a-z][a-z0-9+.-]{1,63}:\/\/)[^\s:@/"'`]{1,256}:[^\s@/"'`]{1,256}@/gi,
    replace: (_m, scheme) => `${scheme}${placeholder('credentials')}@`,
  },
  {
    // Credential-shaped assignments: `apiKey: "..."`, `PASSWORD="..."`,
    // `"client_secret": "..."`. Requires a quoted value so type annotations
    // (`apiKey: string`) are left alone.
    kind: 'credential-assignment',
    pattern:
      /((?:api[_-]?key|apikey|secret|client[_-]?secret|password|passwd|pwd|access[_-]?token|refresh[_-]?token|auth[_-]?token|private[_-]?key|credential)["'`\]]*\s*[:=]\s*["'`])[^"'`\n]{4,}/gi,
    replace: (_m, prefix) => `${prefix}${placeholder('secret')}`,
  },
  {
    // The same credential-shaped keys with an *unquoted* value — `.env` lines
    // inside YAML/JSON, shell exports (`PGPASSWORD=hunter2`), YAML scalars
    // (`password: hunter2`). Values that look like code rather than literals
    // (calls, template interpolation, env lookups, type names) are left alone.
    kind: 'credential-assignment-unquoted',
    pattern:
      /((?:api[_-]?key|apikey|secret|client[_-]?secret|password|passwd|pwd|access[_-]?token|refresh[_-]?token|auth[_-]?token|private[_-]?key|credential)["'`\]]*\s*[:=]\s*)(?!["'`])([^\s"'`,;)}\]]{6,})/gi,
    replace: (m, prefix: string, value: string) => {
      if (/[(${]/.test(value)) return m;
      if (/^process\.env/.test(value)) return m;
      if (
        /^(?:string|String|number|boolean|true|false|null|undefined|unknown|any|never|object|symbol|bigint|Buffer|Record)\b/.test(
          value,
        )
      ) {
        return m;
      }
      return `${prefix}${placeholder('secret')}`;
    },
  },
  {
    // Long high-entropy runs. The mixed-class requirement (lower + upper +
    // digit) is verified in code rather than with lookaheads: the lookahead
    // form re-scans the run at every candidate position and is quadratic on
    // adversarial input.
    kind: 'high-entropy',
    pattern: /[A-Za-z0-9+/_-]{32,}={0,2}/g,
    replace: (m) =>
      /[a-z]/.test(m) && /[A-Z]/.test(m) && /\d/.test(m) ? placeholder('high-entropy') : m,
  },
];

/** Applies every redaction rule. Safe to call on arbitrary source text. */
export function redact(input: string): string {
  let output = input;
  for (const rule of RULES) {
    // Patterns are module-level and global; reset before each use.
    rule.pattern.lastIndex = 0;
    output = output.replace(rule.pattern, rule.replace as (...args: string[]) => string);
  }
  return output;
}

/**
 * Produces a report-ready evidence excerpt: redacted, collapsed to a single
 * line, trimmed and bounded to {@link MAX_EVIDENCE_LENGTH}.
 */
export function toEvidence(raw: string, maxLength: number = MAX_EVIDENCE_LENGTH): string {
  const collapsed = redact(raw).replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, maxLength - 1).trimEnd()}…`;
}
