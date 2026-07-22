#!/usr/bin/env bash

# Build one npm tarball, inspect that exact artifact, install it into an external
# project, and exercise both the CLI and the public ESM API.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export npm_config_cache="$WORK/npm-cache"
# `npm publish --dry-run` exports npm_config_dry_run to every lifecycle script,
# and the nested `npm pack` below would inherit it and write no tarball — so the
# prepublishOnly gate failed on exactly the command used to rehearse a release.
unset npm_config_dry_run
export npm_config_dry_run=false
EXPECTED_VERSION="$(node -e 'const manifest = require(process.argv[1]); process.stdout.write(manifest.version)' "$ROOT/package.json")"

pass=0
fail=0

ok()   { printf '  ok   %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  FAIL %s\n' "$1"; fail=$((fail + 1)); }
note() { printf '\n%s\n' "$1"; }

note "Packing the package"
cd "$ROOT"
TARBALL_NAME="$(npm pack --silent --pack-destination "$WORK" | tail -n 1)"
TARBALL="$WORK/$TARBALL_NAME"
test -f "$TARBALL" && ok "created $TARBALL_NAME" || bad "npm pack did not create a tarball"

note "Inspecting the actual tarball"
tar -tzf "$TARBALL" > "$WORK/contents.txt"
for required in \
  package/package.json \
  package/README.md \
  package/CHANGELOG.md \
  package/LICENSE \
  package/docs/rule-matrix.md \
  package/dist/index.js \
  package/dist/index.d.ts \
  package/dist/cli/bin.js; do
  grep -qxF "$required" "$WORK/contents.txt" \
    && ok "$required is packaged" \
    || bad "$required is missing"
done

# grep, not awk: a bracket expression containing an unescaped "/" terminates
# the regexp literal early in BSD awk, so the macOS run of this gate silently
# matched nothing instead of checking the tarball.
unexpected="$(
  grep -vE '^package/(\.?[^/]+/)*$' "$WORK/contents.txt" \
    | grep -vE '^package/(package\.json|README\.md|CHANGELOG\.md|LICENSE)$' \
    | grep -vE '^package/docs/rule-matrix\.md$' \
    | grep -vE '^package/dist/([^/]+/)*[^/]+\.(js|d\.ts)$' || true
)"
if [ -z "$unexpected" ]; then
  ok "tarball contains only the allowlisted package surface"
else
  bad "tarball contains unexpected paths: $(printf '%s' "$unexpected" | tr '\n' ' ')"
  exit 1
fi

if tar -tvzf "$TARBALL" | awk '$1 !~ /^[-d]/ { invalid = 1 } END { exit invalid }'; then
  ok "tarball contains only regular files and directories"
else
  bad "tarball contains a link or another unsupported entry type"
  exit 1
fi

if grep -Eq '(^|/)(src|test|node_modules|coverage)/|\.map$|\.tsbuildinfo$' "$WORK/contents.txt"; then
  bad "tarball contains source, tests, dependencies, coverage, or build metadata"
else
  ok "tarball excludes source, tests, dependencies, source maps, and build metadata"
fi

mkdir -p "$WORK/unpacked"
tar -xzf "$TARBALL" -C "$WORK/unpacked"
PACKED_VERSION="$(node -e 'const manifest = require(process.argv[1]); process.stdout.write(manifest.version)' "$WORK/unpacked/package/package.json")"
[ "$PACKED_VERSION" = "$EXPECTED_VERSION" ] \
  && ok "packed manifest version is $EXPECTED_VERSION" \
  || bad "packed manifest version is $PACKED_VERSION (expected $EXPECTED_VERSION)"
if grep -R -a -n -E '/Users/|/home/[^ /]+/|[A-Za-z]:\\Users\\|Desktop/Projects' \
  "$WORK/unpacked/package" >/dev/null; then
  bad "published files contain a machine-local path"
else
  ok "published files contain no machine-local path"
fi
if node "$ROOT/scripts/check-secrets.mjs" "$WORK/unpacked/package"; then
  ok "published files pass the secret scan"
else
  bad "published files contain a potential secret"
fi

note "Installing into a clean external project"
mkdir -p "$WORK/consumer"
cd "$WORK/consumer"
npm init -y >/dev/null 2>&1
npm pkg set type=module >/dev/null
npm install --silent --ignore-scripts --no-audit --no-fund "$TARBALL" >/dev/null
CLI="$WORK/consumer/node_modules/.bin/mcp-upgrade"
test -x "$CLI" && ok "packaged CLI is executable" || bad "packaged CLI is not executable"

note "External CLI and npx"
"$CLI" --help >/dev/null && ok "direct --help" || bad "direct --help"
version="$($CLI --version)"
[ "$version" = "$EXPECTED_VERSION" ] \
  && ok "direct --version is $EXPECTED_VERSION" \
  || bad "unexpected version: $version"
npx_version="$(npx --no-install mcp-upgrade --version)"
[ "$npx_version" = "$EXPECTED_VERSION" ] \
  && ok "npx --no-install resolves version $EXPECTED_VERSION" \
  || bad "npx --no-install returned unexpected version: $npx_version"
npx_json="$(npx --no-install mcp-upgrade scan "$ROOT/test/fixtures/clean-stdio-server" --format json)"
if printf '%s' "$npx_json" | node -e '
  let data = "";
  process.stdin.on("data", chunk => data += chunk).on("end", () => JSON.parse(data));
'; then
  ok "npx --no-install executes a scan with valid JSON"
else
  bad "npx --no-install scan output is invalid"
fi

set +e
repository_json="$("$CLI" scan "$ROOT" --format json)"
repository_code=$?
set -e
if [ "$repository_code" -eq 0 ] && printf '%s' "$repository_json" | node -e '
  let data = "";
  process.stdin.on("data", chunk => data += chunk).on("end", () => {
    const report = JSON.parse(data);
    const counts = report.summary.counts;
    if (
      report.scanStatus !== "complete" ||
      report.summary.filesScanned < 1 ||
      report.repository.isLikelyMcpServer ||
      report.repository.transport !== "unknown" ||
      report.findings.length !== 0 ||
      Object.values(counts).some(count => count !== 0)
    ) process.exit(1);
  });
'; then
  ok "installed CLI self-scan is complete, clean, and classifies no MCP server"
else
  bad "installed CLI repository self-scan is invalid or partial (exit $repository_code)"
fi

set +e
"$CLI" >/dev/null 2>&1
bare=$?
set -e
[ "$bare" -eq 2 ] && ok "bare invocation exits 2" || bad "bare invocation exited $bare"

FIXTURES="$ROOT/test/fixtures"

note "External programmatic API"
cat > "$WORK/consumer/api-check.mjs" <<'JS'
import { createRequire } from 'node:module';
import {
  BASELINE_PROTOCOL_VERSION,
  DEFAULT_TARGET_VERSION,
  SCANNER_VERSION,
  assertScanReport,
  isScanReport,
  scanPath,
} from 'mcp-upgrade';

const require = createRequire(import.meta.url);
const packageManifest = require('mcp-upgrade/package.json');

const report = await scanPath({ path: process.env.FIXTURE });
if (!isScanReport(report)) throw new Error('isScanReport rejected a generated report');
assertScanReport(report);
if (report.schemaVersion !== '1.0') throw new Error('unexpected schemaVersion');
if (report.scannerVersion !== SCANNER_VERSION) throw new Error('scanner version mismatch');
if (packageManifest.version !== SCANNER_VERSION) throw new Error('package version mismatch');
if (report.target.protocolVersion !== DEFAULT_TARGET_VERSION) throw new Error('target mismatch');
if (report.target.baselineVersion !== BASELINE_PROTOCOL_VERSION) throw new Error('baseline mismatch');
if (report.scanStatus !== 'complete' || report.issues.length !== 0) {
  throw new Error('fixture scan was unexpectedly partial');
}
if (report.summary.counts.error < 1) throw new Error('expected fixture findings');
JS
FIXTURE="$FIXTURES/legacy-session-server" node "$WORK/consumer/api-check.mjs" \
  && ok "ESM import, scanPath, and report validation work" \
  || bad "external ESM API check failed"

node - <<'JS' && ok "CommonJS rejection matches the ESM-only policy" || bad "CommonJS policy check failed"
try {
  require('mcp-upgrade');
  process.exit(1);
} catch (error) {
  if (!['ERR_PACKAGE_PATH_NOT_EXPORTED', 'ERR_REQUIRE_ESM'].includes(error.code)) throw error;
}
JS

cat > "$WORK/consumer/types-check.ts" <<'TS'
import {
  UsageError,
  assertScanReport,
  isScanReport,
  scanPath,
} from 'mcp-upgrade';
import type {
  Finding,
  ScanIssue,
  ScanPathOptions,
  ScanReport,
  ScanStatus,
} from 'mcp-upgrade';

const options: ScanPathOptions = { path: '.', minimumConfidence: 'high' };
export async function run(): Promise<ScanReport> {
  const report = await scanPath(options);
  const status: ScanStatus = report.scanStatus;
  const issues: ScanIssue[] = report.issues;
  const findings: Finding[] = report.findings;
  const unknownReport: unknown = report;
  if (!isScanReport(unknownReport)) throw new UsageError('invalid report');
  assertScanReport(unknownReport);
  return { ...unknownReport, scanStatus: status, issues, findings };
}
TS
cat > "$WORK/consumer/tsconfig.json" <<'JSON'
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022",
    "strict": true,
    "noEmit": true
  },
  "include": ["types-check.ts"]
}
JSON
"$WORK/consumer/node_modules/.bin/tsc" -p "$WORK/consumer/tsconfig.json" \
  && ok "published types compile externally" \
  || bad "published types failed external compilation"

# fixture:expected-exit-code-with---ci
CASES=(
  "clean-stdio-server:0"
  "clean-http-server:0"
  "legacy-session-server:1"
  "experimental-tasks-server:1"
  "deprecated-features-server:1"
  "ambiguous-wrapper-server:0"
  "docs-only-matches:0"
)

fixture_names="$(
  find "$FIXTURES" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | LC_ALL=C sort
)"
listed_names="$(
  for entry in "${CASES[@]}"; do
    printf '%s\n' "${entry%%:*}"
  done | LC_ALL=C sort
)"
if [ "$fixture_names" = "$listed_names" ]; then
  ok "package verifier covers every fixture directory"
else
  bad "package verifier fixture list does not match test/fixtures"
fi

note "Scanning every fixture from the installed package"
for entry in "${CASES[@]}"; do
  name="${entry%%:*}"
  expected="${entry##*:}"
  target="$FIXTURES/$name"

  set +e
  "$CLI" scan "$target" --no-color >/dev/null 2>&1
  plain=$?
  "$CLI" scan "$target" --ci >/dev/null 2>&1
  ci=$?
  set -e

  [ "$plain" -eq 0 ] && ok "$name exits 0 without --ci" || bad "$name exited $plain"
  [ "$ci" -eq "$expected" ] \
    && ok "$name exits $expected with --ci" \
    || bad "$name exited $ci with --ci (expected $expected)"

  json="$("$CLI" scan "$target" --format json)"
  if printf '%s' "$json" | node -e '
    let data = "";
    process.stdin.on("data", chunk => data += chunk).on("end", () => {
      const report = JSON.parse(data);
      if (!report.scanStatus || !Array.isArray(report.issues)) process.exit(1);
    });
  '; then
    ok "$name JSON parses and carries scan status"
  else
    bad "$name JSON is invalid"
  fi
  if printf '%s' "$json" | grep -q $'\033'; then
    bad "$name JSON contains ANSI"
  else
    ok "$name JSON is ANSI-free"
  fi

  checklist="$("$CLI" scan "$target" --format checklist)"
  if printf '%s' "$checklist" | grep -q $'\033'; then
    bad "$name checklist contains ANSI"
  elif ! printf '%s\n' "$checklist" | grep -q '^## MCP .* Migration Checklist$'; then
    bad "$name checklist has no Markdown title"
  elif ! printf '%s\n' "$checklist" | grep -q '^### Effort breakdown$'; then
    bad "$name checklist has no effort section"
  else
    ok "$name checklist is plain structured Markdown"
  fi

  plain_text="$("$CLI" scan "$target" --no-color)"
  if printf '%s' "$plain_text" | grep -q $'\033'; then
    bad "$name --no-color output contains ANSI"
  else
    ok "$name --no-color output is ANSI-free"
  fi

  piped_text="$("$CLI" scan "$target")"
  if printf '%s' "$piped_text" | grep -q $'\033'; then
    bad "$name non-TTY output contains ANSI"
  else
    ok "$name non-TTY output is ANSI-free by default"
  fi
done

note "Finding exit code preserves machine output"
set +e
finding_json="$("$CLI" scan "$FIXTURES/legacy-session-server" --format json --ci 2>"$WORK/finding.stderr")"
finding_code=$?
set -e
if [ "$finding_code" -eq 1 ] && [ ! -s "$WORK/finding.stderr" ] && printf '%s' "$finding_json" | node -e '
  let data = "";
  process.stdin.on("data", chunk => data += chunk).on("end", () => {
    const report = JSON.parse(data);
    if (report.scanStatus !== "complete" || report.summary.counts.error < 1) process.exit(1);
  });
' && ! printf '%s' "$finding_json" | grep -q $'\033'; then
  ok "exit-1 JSON is valid, ANSI-free, and stderr-clean"
else
  bad "exit-1 JSON machine-output contract failed (exit $finding_code)"
fi

note "Usage exit codes"
set +e
"$CLI" scan /nonexistent/path-xyz >/dev/null 2>&1; missing=$?
"$CLI" scan "$FIXTURES" --format bogus >/dev/null 2>&1; format=$?
"$CLI" scan "$FIXTURES" --target 1999-01-01 >/dev/null 2>&1; target_code=$?
"$CLI" scan "$FIXTURES" --min-confidence sure >/dev/null 2>&1; confidence=$?
"$CLI" scan "$FIXTURES" --ignore '!src/**' >/dev/null 2>&1; negated=$?
"$CLI" scan >/dev/null 2>&1; missing_argument=$?
set -e
for result in \
  "missing path:$missing" \
  "bad format:$format" \
  "bad target:$target_code" \
  "bad confidence:$confidence" \
  "negated ignore:$negated" \
  "missing argument:$missing_argument"; do
  label="${result%%:*}"
  code="${result##*:}"
  [ "$code" -eq 2 ] && ok "$label exits 2" || bad "$label exited $code"
done

note "Partial-scan failure and machine output"
mkdir -p "$WORK/partial/src"
printf '%s\n' '{"dependencies":{"@modelcontextprotocol/sdk":"^1.0.0"}}' \
  > "$WORK/partial/package.json"
node -e '
  const fs = require("node:fs");
  fs.writeFileSync(process.argv[1], "x".repeat(1024 * 1024 + 1));
' "$WORK/partial/src/too-large.ts"
set +e
partial_json="$("$CLI" scan "$WORK/partial" --format json)"
partial_plain=$?
partial_ci_json="$("$CLI" scan "$WORK/partial" --format json --ci)"
partial_ci=$?
set -e
[ "$partial_plain" -eq 2 ] \
  && ok "partial scan exits 2 without --ci" \
  || bad "partial scan exited $partial_plain without --ci"
[ "$partial_ci" -eq 2 ] \
  && ok "partial scan exits 2 with --ci" \
  || bad "partial scan exited $partial_ci with --ci"
for output in "$partial_json" "$partial_ci_json"; do
  if printf '%s' "$output" | node -e '
    let data = "";
    process.stdin.on("data", chunk => data += chunk).on("end", () => {
      const report = JSON.parse(data);
      if (report.scanStatus !== "partial" || !report.issues.length) process.exit(1);
    });
  '; then
    ok "partial-scan JSON remains valid and explicit"
  else
    bad "partial-scan JSON is invalid or incomplete"
  fi
  if printf '%s' "$output" | grep -q $'\033'; then
    bad "partial-scan JSON contains ANSI"
  else
    ok "partial-scan JSON is ANSI-free"
  fi
done

note "Redaction and determinism"
secrets_output="$("$CLI" scan "$FIXTURES/legacy-session-server" --format json)"
leaked=0
for secret in \
  'sk-live-6f3aB9xQ2mZ7pL0wN4tR8vK1cD5eH2jS' \
  'sk-live-9tG4hW2xQ8mZ7pL0wN4tR8vK1cD5eH2j' \
  'hunter2correcthorse'; do
  if printf '%s' "$secrets_output" | grep -qF "$secret"; then
    bad "fixture secret leaked: $secret"
    leaked=1
  fi
done
[ "$leaked" -eq 0 ] && ok "fixture secrets are redacted"
printf '%s' "$secrets_output" | grep -qF '[REDACTED:' \
  && ok "redaction markers are present" \
  || bad "redaction markers are missing"

canonicalize='let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const r=JSON.parse(d);delete r.generatedAt;console.log(JSON.stringify(r))})'
a="$("$CLI" scan "$FIXTURES/legacy-session-server" --format json | node -e "$canonicalize")"
b="$("$CLI" scan "$FIXTURES/legacy-session-server" --format json | node -e "$canonicalize")"
[ "$a" = "$b" ] && ok "repeated reports are deterministic" || bad "repeated reports differ"

note "Result"
printf '  %d passed, %d failed\n\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
