import { Prose, GITHUB_URL } from '../../components/site';

export const metadata = { title: 'Coverage' };

const groups: Array<{ title: string; body: string; rules: string[] }> = [
  {
    title: 'Sessions and statelessness',
    body: 'The next revision is designed so any server instance can answer any request. Session identifiers, session-creating transport options, in-memory state keyed by connection, and sticky-routing configuration are all reported.',
    rules: ['MCP2026-SESSION-001', 'MCP2026-SESSION-002', 'MCP2026-SESSION-003', 'MCP2026-SESSION-004'],
  },
  {
    title: 'Start-up and removed calls',
    body: 'The initialisation handshake is gone, as are the keep-alive check and resource subscriptions. Older streaming and connection-termination mechanics are flagged too.',
    rules: ['MCP2026-LIFECYCLE-001', 'MCP2026-LIFECYCLE-002', 'MCP2026-LIFECYCLE-003'],
  },
  {
    title: 'Request labelling and metadata',
    body: 'New required headers identify the protocol version, the method and — for some calls — the target name, so gateways can route without reading the body. Missing headers, missing validation and missing request metadata are all reported.',
    rules: ['MCP2026-HEADER-001', 'MCP2026-HEADER-002', 'MCP2026-HEADER-003', 'MCP2026-META-001'],
  },
  {
    title: 'Long-running work',
    body: 'The tasks design changed: listing and result retrieval were removed, capability negotiation changed shape, and several fields were renamed.',
    rules: ['MCP2026-TASKS-001', 'MCP2026-TASKS-002', 'MCP2026-TASKS-003', 'MCP2026-TASKS-004'],
  },
  {
    title: 'Asking the client for something',
    body: 'Sampling, roots and protocol logging are deprecated; the folder-change notification and the log-level call were removed outright. Servers that interrupt a call to ask for input must now return a result saying so.',
    rules: [
      'MCP2026-SAMPLING-001', 'MCP2026-SAMPLING-002', 'MCP2026-ROOTS-001', 'MCP2026-ROOTS-002',
      'MCP2026-LOGGING-001', 'MCP2026-LOGGING-002', 'MCP2026-ELICITATION-001',
      'MCP2026-MRTR-001', 'MCP2026-MRTR-002', 'MCP2026-MRTR-003',
    ],
  },
  {
    title: 'Results and errors',
    body: 'Results must declare their type and carry caching hints; several numeric error codes were reassigned or replaced by named errors; server discovery moved where it reports its own name and version.',
    rules: [
      'MCP2026-RESULT-001', 'MCP2026-CACHE-001', 'MCP2026-DISCOVERY-001',
      'MCP2026-ERROR-001', 'MCP2026-ERROR-002', 'MCP2026-ERROR-003',
    ],
  },
  {
    title: 'Library and opportunities',
    body: 'The protocol library your server is built on is usually the single largest item. We also flag where a server could present an interactive interface rather than plain text.',
    rules: ['MCP2026-SDK-001', 'MCP2026-APPS-001'],
  },
];

export default function CoveragePage() {
  return (
    <Prose title="What is checked">
      <p>
        The scanner implements {groups.reduce((n, g) => n + g.rules.length, 0)} rules, each
        traced to a published specification page, changelog entry or protocol enhancement
        proposal. Every rule and its source is listed in the{' '}
        <a href={`${GITHUB_URL}/blob/main/packages/scanner/docs/rule-matrix.md`} className="text-accent underline" rel="noreferrer noopener">
          rule matrix
        </a>{' '}
        in the open-source repository.
      </p>
      <p>
        Files are scanned in TypeScript, JavaScript, JSON and YAML. Dependency folders, build
        output and version-control directories are always ignored.
      </p>

      {groups.map((group) => (
        <section key={group.title}>
          <h2>{group.title}</h2>
          <p>{group.body}</p>
          <p className="font-mono text-xs leading-relaxed text-muted">{group.rules.join(' · ')}</p>
        </section>
      ))}

      <h2>Limits worth knowing</h2>
      <ul>
        <li>
          The target revision is a release candidate. The final specification is not yet
          published, and rules will be revalidated once it is.
        </li>
        <li>
          Static analysis reads code, not behaviour. A pattern assembled at runtime, or
          hidden behind an abstraction we have not been taught, will not be seen.
        </li>
        <li>
          Findings marked <em>needs review</em> are exactly that: we found something that may
          matter and could not decide on our own.
        </li>
        <li>
          A clean report means that no implemented rule fired. It does not guarantee complete
          compatibility with the target MCP specification.
        </li>
      </ul>
    </Prose>
  );
}
