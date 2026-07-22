## What

<!-- One or two sentences. -->

## Why

<!-- For rule changes: name the authoritative source you read and quote the line
     that justifies the change. Protocol rules trace to an official specification
     page, changelog entry or SEP; SDK-only rules may use official SDK docs. -->

## Checklist

- [ ] `npm run verify` passes (typecheck + lint + test + secret check + build)
- [ ] `npm run verify:package` passes for package or public-API changes
- [ ] `npm run audit:production` reports no production vulnerability
- [ ] Rule changes include a fixture and a **negative** test (something similar
      that must not fire)
- [ ] `docs/rule-matrix.md` and the README rule table updated if rules changed
- [ ] `CHANGELOG.md` entry added
- [ ] No deprecation is described as a breaking change
