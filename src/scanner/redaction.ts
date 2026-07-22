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

// Terminal controls, C1 controls and bidi overrides have no legitimate place
// in a machine-consumable report. Replace rather than remove them so an escape
// inserted inside a credential cannot be stripped into a newly exposed token.
const UNSAFE_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const ANSI_CSI = /(?:\u001b\[|\u009b)[0-?]{0,64}[ -/]{0,16}[@-~]/g;
const ANSI_OSC = /\u001b\][^\u0007\u001b]{0,4096}(?:\u0007|\u001b\\)/g;

function neutralizeUnsafeControls(input: string): string {
  return input.replace(ANSI_OSC, ' ').replace(ANSI_CSI, ' ').replace(UNSAFE_CONTROLS, ' ');
}

/**
 * Ordered — earlier rules win. Patterns are deliberately narrow: a false
 * redaction costs a developer the evidence line, so each rule requires a
 * credential-shaped key or a recognised token prefix rather than guessing from
 * entropy alone. The trailing high-entropy rule is the only exception and is
 * tuned to sequences no ordinary identifier reaches.
 */
/**
 * Credential-shaped key names, shared by the quoted and unquoted assignment
 * rules. Compound forms (`secretAccessKey`, `SECRET_KEY`, `signingKey`) are
 * listed before the bare `secret` alternative: the concatenated camelCase
 * spellings are how SDK credential objects actually name the sensitive half of
 * a key pair, and matching only the bare word leaves those values in the clear.
 */
const CREDENTIAL_KEY_SOURCE =
  '(?:' +
  [
    'aws[_-]?secret[_-]?access[_-]?key',
    'aws[_-]?session[_-]?token',
    'secret[_-]?access[_-]?key',
    'client[_-]?secret',
    'session[_-]?secret',
    'webhook[_-]?secret',
    'signing[_-]?secret',
    'secret[_-]?key',
    'signing[_-]?key',
    'encryption[_-]?key',
    'private[_-]?key',
    'account[_-]?key',
    'api[_-]?key',
    'apikey',
    'access[_-]?token',
    'refresh[_-]?token',
    'auth[_-]?token',
    // Bare `token`, minus benign compounds. `progressToken` is a core MCP
    // protocol field, so redacting it would destroy the very evidence a
    // finding exists to show. Credential compounds such as `myApiKey` or
    // `stripeSecretKey` still match through their own alternatives above.
    '(?<!progress|csrf|xsrf|continuation|cursor|page|next)token',
    'secret',
    'password',
    'passwd',
    'pwd',
    'passphrase',
    'credential',
  ].join('|') +
  ')';

/**
 * True when a run mixes character classes the way encoded credentials do.
 * Ordinary identifiers and path fragments rarely combine all three.
 */
function isHighEntropyRun(run: string): boolean {
  return /[a-z]/.test(run) && /[A-Z]/.test(run) && /\d/.test(run);
}

const RULES: RedactionRule[] = [
  {
    // PEM blocks. Matched first: their body would otherwise trip other rules.
    // The complete block is the first alternative so it wins; the second
    // catches a truncated block, which must still never reach a report.
    kind: 'private-key',
    pattern:
      /-----BEGIN[A-Z0-9 ]{0,64}PRIVATE KEY-----[\s\S]*?-----END[A-Z0-9 ]{0,64}PRIVATE KEY-----|-----BEGIN[A-Z0-9 ]{0,64}PRIVATE KEY-----[\s\S]*/g,
    replace: () => placeholder('private-key'),
  },
  {
    // A token assembled from adjacent string fragments is still recoverable
    // from an evidence line. Match the whole bounded concatenation before an
    // assignment rule can redact only its first fragment.
    kind: 'split-vendor-token',
    pattern:
      /["'`](?:sk(?:-proj)?-|xox[abposr]-|gh[pousr]_|github_pat_|glpat-|npm_|(?:sk|pk|rk)_(?:live|test)_|whsec_|(?:AKIA|ASIA)|AIza|ya29\.)[A-Za-z0-9_-]{0,64}["'`](?:\s*\+\s*["'`][A-Za-z0-9._~+/=-]{1,256}["'`]){1,5}/g,
    replace: () => placeholder('token'),
  },
  {
    kind: 'split-bearer-token',
    pattern:
      /["'`](?:Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{0,64}["'`](?:\s*\+\s*["'`][A-Za-z0-9._~+/=-]{1,256}["'`]){1,5}/gi,
    replace: () => placeholder('token'),
  },
  {
    // Literal interpolation is another common way generated code splits a
    // credential while leaving every byte visible in the source excerpt.
    kind: 'interpolated-token',
    pattern:
      /`(?:(?:Bearer|Basic|Token)\s+|(?:sk(?:-proj)?-|xox[abposr]-|gh[pousr]_|github_pat_|glpat-|npm_|(?:sk|pk|rk)_(?:live|test)_|whsec_|(?:AKIA|ASIA)|AIza|ya29\.))[A-Za-z0-9._~+/=-]{0,64}\$\{\s*["'][A-Za-z0-9._~+/=-]{1,256}["']\s*\}[A-Za-z0-9._~+/=-]{0,256}`/gi,
    replace: () => placeholder('token'),
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
      /(?:sk-[A-Za-z0-9_-]{16,}|xox[abposr]-[A-Za-z0-9-]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{22,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{28,}|(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9]{16,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|ya29\.[0-9A-Za-z_-]{10,})/g,
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
    pattern: /\b([a-z][a-z0-9+.-]{1,63}:\/\/)[^\s:@/"'`]{0,256}:[^\s@/"'`]{1,256}@/gi,
    replace: (_m, scheme) => `${scheme}${placeholder('credentials')}@`,
  },
  {
    // Credential-shaped assignments: `apiKey: "..."`, `PASSWORD="..."`,
    // `"client_secret": "..."`. Requires a quoted value so type annotations
    // (`apiKey: string`) are left alone.
    kind: 'credential-assignment',
    pattern: new RegExp(`(${CREDENTIAL_KEY_SOURCE}["'\`\\]]*\\s*[:=]\\s*["'\`])[^"'\`\\n]{4,}`, 'gi'),
    replace: (_m, prefix) => `${prefix}${placeholder('secret')}`,
  },
  {
    // The same credential-shaped keys with an *unquoted* value — `.env` lines
    // inside YAML/JSON, shell exports (`PGPASSWORD=hunter2`), YAML scalars
    // (`password: hunter2`). Values that look like code rather than literals
    // (calls, template interpolation, env lookups, type names) are left alone.
    kind: 'credential-assignment-unquoted',
    pattern: new RegExp(
      `(${CREDENTIAL_KEY_SOURCE}["'\`\\]]*\\s*[:=]\\s*)(?!["'\`])([^\\s"'\`,;)}\\]]{6,})`,
      'gi',
    ),
    replace: (m, prefix: string, value: string) => {
      // Only bail on syntax that genuinely reads as code. Bailing on a bare
      // `$`, `(` or `{` anywhere in the value would leave real passwords —
      // which routinely contain those characters — completely unredacted.
      if (value.includes('${')) return m;
      if (/^[A-Za-z_$][\w$.]*\(/.test(value)) return m;
      if (value.startsWith('{')) return m;
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
    // Lowercase hex digests: session identifiers, HMAC signatures and
    // hex-encoded keys. These never satisfy the mixed-class high-entropy rule
    // below, so without their own rule they reach a report in full.
    kind: 'hex-digest',
    // Slash-delimited runs are excluded: report file paths pass through
    // redaction, and eating a hash-shaped directory name would leave a finding
    // pointing at `src/[REDACTED:high-entropy]/server.ts`.
    pattern: /(?<![0-9A-Za-z/])[0-9a-f]{32,}(?![0-9A-Za-z/])/g,
    replace: () => placeholder('high-entropy'),
  },
  {
    // Encoded credentials inside a string literal. Standard base64 (`/`, `+`)
    // and base64url (`-`, `_`) runs are excluded from the bare high-entropy
    // class below because those characters also occur in file paths. Requiring
    // the literal's entire content to be one unbroken run keeps ordinary
    // quoted paths — which contain a `.` extension or spaces — unaffected.
    kind: 'high-entropy-literal',
    pattern: /(["'`])([A-Za-z0-9+/_-]{40,}={0,2})\1/g,
    replace: (match, quote: string, run: string) =>
      isHighEntropyRun(run) ? `${quote}${placeholder('high-entropy')}${quote}` : match,
  },
  {
    // Long high-entropy runs. The mixed-class requirement (lower + upper +
    // digit) is verified in code rather than with lookaheads: the lookahead
    // form re-scans the run at every candidate position and is quadratic on
    // adversarial input.
    kind: 'high-entropy',
    // Keep this to a single token segment. Including `/` or `-` lets the match
    // consume ordinary absolute paths and falsely redact portable file names.
    pattern: /[A-Za-z0-9+_]{40,}={0,2}/g,
    replace: (m) => (isHighEntropyRun(m) ? placeholder('high-entropy') : m),
  },
];

/** Applies every redaction rule. Safe to call on arbitrary source text. */
export function redact(input: string): string {
  let output = neutralizeUnsafeControls(input);
  for (const rule of RULES) {
    // Never mutate a shared RegExp's lastIndex: scans may run concurrently.
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    output = output.replace(pattern, rule.replace as (...args: string[]) => string);
  }
  return output;
}

/** True when an offset is inside a complete or truncated PEM private-key block. */
export function isPrivateKeyPosition(input: string, offset: number): boolean {
  const boundedOffset = Math.max(0, Math.min(offset, input.length));
  const begin = input.lastIndexOf('-----BEGIN', boundedOffset);
  if (begin < 0) return false;
  const end = input.lastIndexOf('-----END', boundedOffset);
  if (end > begin) return false;
  return /^-----BEGIN[A-Z0-9 ]{0,64}PRIVATE KEY-----/.test(input.slice(begin, begin + 96));
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

/**
 * Sanitises an arbitrary report-origin string for JSON, terminal and Markdown
 * consumers. Newlines and tabs are flattened so attacker-controlled metadata
 * cannot inject additional output records or terminal control sequences.
 */
export function sanitizeReportText(raw: string, maxLength?: number): string {
  const sanitized = redact(raw.replace(/[\t\r\n\u2028\u2029]+/g, ' '));
  if (maxLength === undefined || sanitized.length <= maxLength) return sanitized;
  if (maxLength <= 1) return sanitized.slice(0, maxLength);
  return `${sanitized.slice(0, maxLength - 1)}…`;
}
