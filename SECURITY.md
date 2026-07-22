# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |

## Threat model

`mcp-upgrade` treats every scanned repository as **hostile input**. The scanner:

- never executes scanned code, never imports scanned modules, and never runs
  package scripts from the scanned repository;
- never installs dependencies from the scanned repository;
- makes no network calls of any kind while scanning;
- never opens source-file contents outside the explicitly selected scan root
  (symlinks that escape the root are skipped and reported);
- redacts credentials from every evidence excerpt before it reaches any output.

Security-relevant bugs include, but are not limited to:

- an evidence excerpt, verbose trace or error message that leaks an unredacted
  secret from a scanned repository;
- any path by which a scan reads source-file contents outside the selected scan
  root or commits directory names from a replaced outside directory;
- any input (file content, filename, glob pattern) that causes code execution,
  a hang (for example regex catastrophic backtracking) or unbounded resource
  consumption.

Files that cannot be scanned within the filesystem and resource limits are
reported as structured issues. Every partial CLI scan exits `2` so an
incomplete result cannot be mistaken for a clean compatibility result.

Opened-file inode checks prevent source-file reads from escaping the selected
root. Directory entries are staged and committed only when the complete
root-to-directory identity chain is unchanged before, immediately after, and
throughout enumeration. Node does not expose portable `openat`-style directory
traversal, so a filesystem with coarse or nonstandard identity timestamps can
leave a residual directory-replacement race. A scan is not a filesystem
snapshot: an in-root file may change before it is opened. Redaction recognizes
common source-form credentials; encoded, interpolated, split, or
runtime-constructed secrets can evade pattern matching. Review any report
before publishing it.

As release defense in depth, `npm run check:secrets` scans tracked repository
content for common credential formats without printing matching values. This
does not replace GitHub secret scanning or a review of the final package.

## Reporting a vulnerability

Please report vulnerabilities privately via
[GitHub Security Advisories](https://github.com/JacobRyan258/mcp-upgrade/security/advisories/new)
rather than opening a public issue.

Include the scanner version, a minimal reproduction (a small fixture directory
is ideal), and the output channel affected (text, JSON, checklist, verbose or
stderr).

You should receive an acknowledgement within a week. Please allow a reasonable
window for a fix before public disclosure.
