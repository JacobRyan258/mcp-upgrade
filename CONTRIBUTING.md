# Contributing

Thanks for helping make MCP migrations less painful.

## Setup

```bash
npm install
npm run verify   # typecheck + lint + test + build
```

Useful individually:

```bash
npm run typecheck
npm run lint
npm test
npm run test:watch
npm run build
npm run dev -- scan ./test/fixtures/legacy-session-server
```

## The rules that govern rules

These are not style preferences. A migration scanner that gets these wrong is
worse than no scanner, because it sends people to change working code.

### 1. Every rule must trace to an official MCP source

A rule's `source` must point at one of:

- an official specification page (`modelcontextprotocol.io/specification/...`),
- the official changelog,
- an official extension page, or
- a **Final** SEP.

Blog posts, third-party summaries and SDK source are supporting evidence, not
justification. If you cannot quote the official text, the rule does not ship.

Add the rule to `docs/rule-matrix.md` in the same pull request, with the
verbatim quote that supports it.

### 2. When sources conflict, the changelog and draft spec win

SEP pages are historical records; several were written before later renumbering
or removal landed. The authority order is:

> draft changelog and draft specification pages > SEP pages > blog posts and
> extension overviews

`docs/implementation-plan.md` records the conflicts already resolved this way —
`logging/setLevel`, `notifications/roots/list_changed`, the `HeaderMismatch`
code, the MCP Apps MIME type. Add to that table if you resolve a new one.

### 3. Never call a deprecation a breaking change

`WARNING` means the feature still works. The explanation must say so, and must
not use removal language. There is a test that enforces this
(`deprecated-features-server > never describes a deprecation as removed or
breaking`); if you are fighting it, check whether the thing you are describing
is actually removed — in which case it belongs in its own `ERROR` rule, kept
separate from the deprecation, as `MCP2026-ROOTS-002` and `MCP2026-LOGGING-002`
are.

### 4. Prefer REVIEW over a wrong ERROR

`ERROR` asserts a confirmed incompatibility. If a wrapper, middleware, or an
abstraction the scanner cannot see could legitimately explain the pattern,
downgrade to `REVIEW` and say why in the explanation. Do not drop the finding —
a downgrade keeps the location visible without making a claim you cannot back.

### 5. Do not invent protocol requirements

If the specification does not say it, the tool does not say it. Uncertainty
belongs in the explanation, not in a confident-sounding assertion.

## Adding a rule

1. Read the official source. Quote it.
2. Add the rule to the right file under `src/scanner/rules/`, exported from that
   file's rule array. `src/scanner/rules/index.ts` picks it up automatically.
3. Give it a stable ID: `MCP2026-<GROUP>-<NNN>`. IDs are permanent — they end up
   in people's CI configs and suppression lists. Never renumber one.
4. Set `appliesTo.transports` honestly. A rule about HTTP headers must not list
   `stdio`.
5. Add a fixture under `test/fixtures/` (or extend an existing one) and a test
   under `test/rules/`.
6. Add a **negative** test: something that looks similar but must *not* fire.
   This matters more than the positive test.
7. Update `docs/rule-matrix.md` and the rule table in `README.md`.
8. Add a `CHANGELOG.md` entry.

## Constraints the scanner must keep

Non-negotiable, and each is covered by a test:

- **No network calls** during a scan.
- **Never execute** scanned code, and never install its dependencies.
- **No telemetry, analytics or authentication.**
- **Deterministic output** — the same repository must produce the same findings,
  in the same order, with the same score, on every run. `generatedAt` is the
  only field permitted to vary.
- **Redact secrets** from every evidence excerpt. If you add a new way for
  source text to reach a report, route it through `toEvidence()`.
- **Comment-only matches are never findings.** They are counted and surfaced
  under `--verbose`.

## Dependencies

Production dependencies are limited to `commander`, `chalk`, `fast-glob` and
`typescript`. Development adds `vitest`, `tsx`, `eslint` and type packages.

Adding a production dependency needs a discussion first. Explicitly out of
scope: databases, web frameworks, LLM APIs, telemetry SDKs, authentication, and
anything that executes code.

## Pull requests

- Keep the diff focused; one rule or one fix per PR where practical.
- `npm run verify` must pass.
- Say which official source you read, and quote the line that justifies the
  change.
