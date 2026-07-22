# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | ✅ |

## Threat model

`mcp-upgrade` treats every scanned repository as **hostile input**. The scanner:

- never executes scanned code, never imports scanned modules, and never runs
  package scripts from the scanned repository;
- never installs dependencies from the scanned repository;
- makes no network calls of any kind while scanning;
- never reads outside the explicitly selected scan root (symlinks that escape
  the root are skipped and reported);
- redacts credentials from every evidence excerpt before it reaches any output.

Security-relevant bugs include, but are not limited to:

- an evidence excerpt, verbose trace or error message that leaks an unredacted
  secret from a scanned repository;
- any path by which a scan reads files outside the selected scan root;
- any input (file content, filename, glob pattern) that causes code execution,
  a hang (for example regex catastrophic backtracking) or unbounded resource
  consumption.

## Reporting a vulnerability

Please report vulnerabilities privately via
[GitHub Security Advisories](https://github.com/JacobRyan258/mcp-upgrade/security/advisories/new)
rather than opening a public issue.

Include the scanner version, a minimal reproduction (a small fixture directory
is ideal), and the output channel affected (text, JSON, checklist, verbose or
stderr).

You should receive an acknowledgement within a week. Please allow a reasonable
window for a fix before public disclosure.
