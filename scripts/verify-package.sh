#!/usr/bin/env bash
#
# Final validation protocol: build a tarball, install it into a throwaway
# project, and run the *packaged* CLI against every fixture — checking exit
# codes, JSON parseability, absence of ANSI in machine formats, and absence of
# unredacted fixture secrets.
#
# This exercises what a user actually gets from `npx mcp-upgrade`, not the
# source tree.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0

ok()   { printf '  \033[32mok\033[0m   %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail + 1)); }
note() { printf '\n\033[1m%s\033[0m\n' "$1"; }

note "Building and packing"
cd "$ROOT"
npm run --silent clean
npm run --silent build
TARBALL="$(npm pack --silent --pack-destination "$WORK" | tail -1)"
echo "  tarball: $TARBALL"

note "Installing the tarball into a clean project"
mkdir -p "$WORK/consumer"
cd "$WORK/consumer"
npm init -y >/dev/null 2>&1
npm install --silent --no-audit --no-fund "$WORK/$TARBALL" >/dev/null
CLI="$WORK/consumer/node_modules/.bin/mcp-upgrade"

if [ -x "$CLI" ]; then ok "packaged CLI is executable"; else bad "packaged CLI is not executable"; fi

note "CLI basics"
"$CLI" --help    >/dev/null && ok "--help"    || bad "--help"
"$CLI" --version >/dev/null && ok "--version" || bad "--version"

FIXTURES="$ROOT/test/fixtures"

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

note "Scanning every fixture with the packaged CLI"
for entry in "${CASES[@]}"; do
  name="${entry%%:*}"
  expected="${entry##*:}"

  set +e
  "$CLI" scan "$FIXTURES/$name" --no-color >/dev/null 2>&1
  plain=$?
  "$CLI" scan "$FIXTURES/$name" --ci >/dev/null 2>&1
  ci=$?
  set -e

  [ "$plain" -eq 0 ]         && ok "$name exits 0 without --ci" || bad "$name exited $plain without --ci"
  [ "$ci" -eq "$expected" ]  && ok "$name exits $expected with --ci" || bad "$name exited $ci with --ci, expected $expected"

  json="$("$CLI" scan "$FIXTURES/$name" --format json)"
  if printf '%s' "$json" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{JSON.parse(d)})' 2>/dev/null; then
    ok "$name JSON parses"
  else
    bad "$name JSON does not parse"
  fi

  if printf '%s' "$json" | grep -q $'\033'; then bad "$name JSON contains ANSI"; else ok "$name JSON is ANSI-free"; fi

  checklist="$("$CLI" scan "$FIXTURES/$name" --format checklist)"
  if printf '%s' "$checklist" | grep -q $'\033'; then
    bad "$name checklist contains ANSI"
  else
    ok "$name checklist is ANSI-free"
  fi

  plain_text="$("$CLI" scan "$FIXTURES/$name" --no-color)"
  if printf '%s' "$plain_text" | grep -q $'\033'; then
    bad "$name --no-color output contains ANSI"
  else
    ok "$name --no-color output is ANSI-free"
  fi
done

note "Exit code 2 — invalid arguments and unreadable targets"
set +e
"$CLI" scan /nonexistent/path-xyz >/dev/null 2>&1;              [ $? -eq 2 ] && ok "missing path exits 2"        || bad "missing path did not exit 2"
"$CLI" scan "$FIXTURES" --format bogus >/dev/null 2>&1;         [ $? -eq 2 ] && ok "bad --format exits 2"        || bad "bad --format did not exit 2"
"$CLI" scan "$FIXTURES" --target 1999-01-01 >/dev/null 2>&1;    [ $? -eq 2 ] && ok "bad --target exits 2"        || bad "bad --target did not exit 2"
"$CLI" scan "$FIXTURES" --min-confidence sure >/dev/null 2>&1;  [ $? -eq 2 ] && ok "bad --min-confidence exits 2" || bad "bad --min-confidence did not exit 2"
"$CLI" scan >/dev/null 2>&1;                                    [ $? -eq 2 ] && ok "missing argument exits 2"     || bad "missing argument did not exit 2"
set -e

note "Secret redaction on the packaged CLI"
secrets_output="$("$CLI" scan "$FIXTURES/legacy-session-server" --format json)"
leaked=0
for secret in 'sk-live-6f3aB9xQ2mZ7pL0wN4tR8vK1cD5eH2jS' 'sk-live-9tG4hW2xQ8mZ7pL0wN4tR8vK1cD5eH2j' 'hunter2correcthorse'; do
  if printf '%s' "$secrets_output" | grep -qF "$secret"; then
    bad "fixture secret leaked: $secret"
    leaked=1
  fi
done
[ "$leaked" -eq 0 ] && ok "no fixture secrets appear unredacted"
printf '%s' "$secrets_output" | grep -qF '[REDACTED:' && ok "redaction markers present" || bad "no redaction markers found"

note "Determinism"
a="$("$CLI" scan "$FIXTURES/legacy-session-server" --format json | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const r=JSON.parse(d);delete r.generatedAt;console.log(JSON.stringify(r))})')"
b="$("$CLI" scan "$FIXTURES/legacy-session-server" --format json | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const r=JSON.parse(d);delete r.generatedAt;console.log(JSON.stringify(r))})')"
[ "$a" = "$b" ] && ok "repeated scans are byte-identical" || bad "repeated scans differ"

note "Package contents"
cd "$ROOT"
contents="$(npm pack --dry-run 2>&1)"
printf '%s' "$contents" | grep -q 'dist/cli/bin.js' && ok "dist/cli/bin.js is packaged" || bad "dist/cli/bin.js is missing"
printf '%s' "$contents" | grep -q 'README.md'       && ok "README.md is packaged"       || bad "README.md is missing"
printf '%s' "$contents" | grep -q 'LICENSE'         && ok "LICENSE is packaged"         || bad "LICENSE is missing"
if printf '%s' "$contents" | grep -qE '(^|[ /])(src|test|node_modules)/'; then
  bad "package contains source, tests or dependencies"
else
  ok "package contains no source, tests or dependencies"
fi

note "Result"
printf '  %d passed, %d failed\n\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
