import {
  DEFAULT_TARGET_VERSION,
  EXTENSION_IDS,
  MCP_APP_MIME_TYPE,
  SOURCES,
} from '../../constants.js';
import type { AppsReadiness, Finding, ScanContext, ScannerRule } from '../../types.js';
import { buildFinding, dedupeByLocation, fileHasMcpSignal, filesFor, matches } from './helpers.js';

/**
 * Group 8 — MCP Apps readiness. Informational only.
 *
 * MCP Apps is an optional extension: SEP-1865 states "Existing implementations
 * continue working without changes." Nothing here is ever a compatibility
 * problem, and generic HTML is never treated as a valid MCP App — the
 * `LIKELY_READY` verdict requires an explicit MCP Apps literal.
 */

interface AppSignal {
  pattern: RegExp;
  /** `explicit` signals are MCP Apps proper; `generic` signals are UI-shaped code. */
  strength: 'explicit' | 'generic' | 'foreign';
  title: string;
  note: string;
}

const APP_SIGNALS: AppSignal[] = [
  {
    pattern: new RegExp(`['"\`]${EXTENSION_IDS.ui.replace(/\//g, '\\/')}['"\`]`, 'g'),
    strength: 'explicit',
    title: 'MCP Apps extension identifier',
    note:
      `The MCP Apps extension is identified on the wire as "${EXTENSION_IDS.ui}" — note "/ui", not ` +
      '"/apps". Its presence means this repository is already MCP Apps aware.',
  },
  {
    pattern: /['"`]ui:\/\/[^'"`]*['"`]/g,
    strength: 'explicit',
    title: 'MCP Apps UI resource URI',
    note:
      'MCP Apps UI resources are predeclared under the reserved ui:// URI scheme, and a tool links ' +
      'to one through _meta.ui.resourceUri.',
  },
  {
    pattern: new RegExp(`['"\`]${MCP_APP_MIME_TYPE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`, 'g'),
    strength: 'explicit',
    title: 'MCP Apps MIME type',
    note: `UI resource contents must declare mimeType "${MCP_APP_MIME_TYPE}".`,
  },
  {
    pattern: /['"`]@modelcontextprotocol\/ext-apps[^'"`]*['"`]/g,
    strength: 'explicit',
    title: 'MCP Apps SDK import',
    note:
      'The ext-apps package provides the server-side helpers for MCP Apps, such as getUiCapability ' +
      'and RESOURCE_MIME_TYPE.',
  },
  {
    // Only the _meta-anchored forms are explicit MCP Apps metadata.
    pattern: /_meta\s*(?:\.|\[\s*['"`])ui\b|['"`]ui\/resourceUri['"`]/g,
    strength: 'explicit',
    title: 'MCP Apps tool metadata',
    note:
      'A tool links to its UI resource through _meta.ui.resourceUri. Note that the flat ' +
      '_meta["ui/resourceUri"] form is deprecated in favour of the nested one and is documented as ' +
      'being removed before GA.',
  },
  {
    // A bare `resourceUri:` property is common in generic REST clients and is
    // never, on its own, evidence of MCP Apps — so it can suggest candidacy
    // but must not flip the verdict to LIKELY_READY.
    pattern: /\bresourceUri\s*:/g,
    strength: 'generic',
    title: 'resourceUri property',
    note:
      'A property named resourceUri appears here. MCP Apps links tools to UI resources through ' +
      '_meta.ui.resourceUri; a bare resourceUri property may or may not be related.',
  },
  {
    pattern: /['"`]text\/html\+skybridge['"`]/g,
    strength: 'foreign',
    title: 'Non-MCP UI MIME type (text/html+skybridge)',
    note:
      'text/html+skybridge is the OpenAI Apps SDK convention and appears nowhere in the MCP ' +
      'specification. MCP Apps uses ' +
      `"${MCP_APP_MIME_TYPE}". This repository produces UI, but against a different contract.`,
  },
  {
    pattern: /\bcontentType\s*:\s*['"`]text\/html['"`]|\bmimeType\s*:\s*['"`]text\/html['"`]/g,
    strength: 'generic',
    title: 'HTML content in a tool or resource result',
    note: 'A result declares HTML content, which is the raw material an MCP App renders.',
  },
  {
    pattern: /<iframe\b|\bsandbox\s*=\s*['"`][^'"`]*allow-scripts/g,
    strength: 'generic',
    title: 'Existing iframe or sandbox implementation',
    note:
      'MCP Apps renders views inside a sandboxed iframe on a different origin from the host, with ' +
      'allow-scripts and allow-same-origin. Existing iframe work transfers.',
  },
  {
    pattern: /\brenderToString\b|\brenderToStaticMarkup\b|\bhandlebars\b|\bejs\.render\b|\bnunjucks\b/g,
    strength: 'generic',
    title: 'HTML templating',
    note: 'HTML templating suggests the server can already produce a rendered view.',
  },
];

/** Extensions that suggest UI modules live in this repository. */
const UI_MODULE_EXTENSIONS = ['.tsx', '.jsx'];

export const appsReadinessRule: ScannerRule = {
  id: 'MCP2026-APPS-001',
  title: 'MCP Apps readiness signal',
  category: 'apps-readiness',
  targetVersion: DEFAULT_TARGET_VERSION,
  level: 'info',
  defaultConfidence: 'medium',
  source: SOURCES.sep1865,
  appliesTo: {
    fileKinds: ['ts', 'js', 'json'],
    transports: ['stdio', 'streamable-http', 'mixed', 'custom-http', 'unknown'],
  },
  autofix: 'none',
  description:
    'Reports signals that this server could adopt the MCP Apps extension. Informational only — ' +
    'MCP Apps is optional and a repository without it remains fully specification-compliant.',

  async scan(context: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];

    // Apps readiness only has meaning for an MCP implementation. Exact Apps
    // tokens also occur in documentation generators, migration scanners, and
    // protocol constant registries, where treating them as adoption signals is
    // misleading. Repository classification requires executable MCP behavior,
    // an official MCP import, or an MCP dependency.
    if (!context.repository.isLikelyMcpServer) return findings;

    const remediation =
      'MCP Apps is optional; nothing here is required for the 2026-07-28 migration. If you do want ' +
      'to adopt it: declare the ' +
      `"${EXTENSION_IDS.ui}" extension with its required mimeTypes array, predeclare each UI as a ` +
      `resource under a ui:// URI with mimeType "${MCP_APP_MIME_TYPE}", link tools to it through ` +
      '_meta.ui.resourceUri (the nested form, not the deprecated flat ui/resourceUri key), and ' +
      'declare the origins your view needs under _meta.ui.csp. Check the client advertised the ' +
      'extension before registering UI-enabled tools so hosts without it degrade gracefully.';

    for (const file of filesFor(this, context)) {
      for (const signal of APP_SIGNALS) {
        if (
          signal.strength !== 'explicit' &&
          !fileHasMcpSignal(file)
        ) {
          continue;
        }
        for (const { hit } of matches(context, this, file, signal.pattern)) {
          findings.push(
            buildFinding(this, hit, {
              title: signal.title,
              confidence: signal.strength === 'explicit' ? 'high' : 'low',
              explanation:
                `${signal.note} MCP Apps is an optional extension added alongside the 2026-07-28 ` +
                'specification — "Existing implementations continue working without changes" — so ' +
                'this is an opportunity, not a compatibility problem.',
              remediation,
            }),
          );
        }
      }
    }

    return dedupeByLocation(findings);
  },
};

/**
 * Derives the repository-level readiness verdict from the rule's findings.
 *
 * `LIKELY_READY` deliberately requires an explicit MCP Apps literal: generic
 * HTML does not make a valid MCP App, and claiming otherwise would be exactly
 * the kind of unfounded protocol assertion this scanner must avoid.
 */
export function deriveAppsReadiness(context: ScanContext, findings: Finding[]): AppsReadiness {
  if (!context.repository.isLikelyMcpServer) return 'NOT_APPLICABLE';

  const appFindings = findings.filter((finding) => finding.ruleId === appsReadinessRule.id);
  const hasExplicit = appFindings.some((finding) => finding.confidence === 'high');
  if (hasExplicit) return 'LIKELY_READY';

  const hasUiModule = context.files.some((file) => UI_MODULE_EXTENSIONS.includes(file.ext));
  if (appFindings.length > 0 || hasUiModule) return 'POSSIBLE_CANDIDATE';

  return 'NO_SIGNAL';
}

export const appsRules: ScannerRule[] = [appsReadinessRule];
