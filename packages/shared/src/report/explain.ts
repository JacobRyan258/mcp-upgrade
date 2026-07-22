/**
 * Plain-English explanations, keyed by rule ID.
 *
 * These are static, deterministic templates. No language model is involved at
 * request time: the same finding always produces the same words, which is what
 * makes the report reviewable, diffable and safe to show to someone who will
 * forward it to a developer as an instruction.
 *
 * The scanner's own `explanation` and `remediation` remain the technical
 * record. These fields sit alongside them for a reader who does not know what
 * the Model Context Protocol is.
 */

export interface PlainExplanation {
  /** A heading a non-technical reader understands. */
  headline: string;
  /** What the scanner actually saw, without jargon. */
  whatWasFound: string;
  /** Why this matters commercially or operationally. */
  whyItMatters: string;
  /** The concrete user-visible consequence, if any. */
  whatMayStopWorking: string;
  /** A sentence the reader can paste into a message to their developer. */
  askYourDeveloper: string;
}

/** Groups used to organise the report for a non-technical reader. */
export type PlainTheme =
  | 'sessions'
  | 'startup'
  | 'requests'
  | 'tasks'
  | 'assistant-features'
  | 'errors'
  | 'results'
  | 'sdk'
  | 'opportunity';

export interface RuleGuide extends PlainExplanation {
  theme: PlainTheme;
}

const THEME_LABELS: Readonly<Record<PlainTheme, string>> = Object.freeze({
  sessions: 'How your server remembers connections',
  startup: 'How your server starts a conversation',
  requests: 'How requests are labelled and checked',
  tasks: 'Long-running work',
  'assistant-features': 'Features that ask the assistant for help',
  errors: 'Error reporting',
  results: 'The shape of the data you return',
  sdk: 'The library your server is built on',
  opportunity: 'Optional improvements',
});

const THEME_ORDER: readonly PlainTheme[] = [
  'sdk',
  'startup',
  'sessions',
  'requests',
  'results',
  'tasks',
  'assistant-features',
  'errors',
  'opportunity',
];

export function themeLabel(theme: PlainTheme): string {
  return THEME_LABELS[theme];
}

export function themeRank(theme: PlainTheme): number {
  const index = THEME_ORDER.indexOf(theme);
  return index < 0 ? THEME_ORDER.length : index;
}

const SESSION_ASK =
  'Ask your developer to remove per-connection session tracking so the server can handle each request independently.';

const RULE_GUIDES: Readonly<Record<string, RuleGuide>> = Object.freeze({
  /* ---------------------------------------------------------------------- */
  /* Sessions                                                                */
  /* ---------------------------------------------------------------------- */
  'MCP2026-SESSION-001': {
    theme: 'sessions',
    headline: 'Your server uses connection IDs that the new version ignores',
    whatWasFound:
      'Your code sets or reads a session identifier header on MCP requests.',
    whyItMatters:
      'The new protocol version is designed so any server instance can answer any request. Servers are told not to create or echo session identifiers.',
    whatMayStopWorking:
      'Anything that depends on the client sending the same session identifier back — for example remembering a selection between two requests — will stop being reliable.',
    askYourDeveloper: SESSION_ASK,
  },
  'MCP2026-SESSION-002': {
    theme: 'sessions',
    headline: 'Your server is configured to create sessions',
    whatWasFound:
      'Your MCP transport is set up with session creation or session lifecycle callbacks.',
    whyItMatters:
      'Session creation was removed from the protocol. A transport configured this way is building behaviour the new version no longer defines.',
    whatMayStopWorking:
      'Clients on the new protocol version may fail to connect, or connect and then behave inconsistently.',
    askYourDeveloper: SESSION_ASK,
  },
  'MCP2026-SESSION-003': {
    theme: 'sessions',
    headline: 'Your server keeps state in memory, keyed by connection',
    whatWasFound:
      'Your code stores per-connection state in a lookup keyed by a session identifier.',
    whyItMatters:
      'If a request can be answered by any instance of your server, in-memory state keyed by connection will be missing about as often as it is found.',
    whatMayStopWorking:
      'Features that rely on remembering something from an earlier request will work on one machine and fail on another.',
    askYourDeveloper:
      'Ask your developer to move any state that must survive between requests into a shared store, or to include it in each request.',
  },
  'MCP2026-SESSION-004': {
    theme: 'sessions',
    headline: 'Your hosting is configured to pin users to one machine',
    whatWasFound:
      'A configuration file enables sticky sessions or session affinity.',
    whyItMatters:
      'Sticky routing exists to make session state work. Once the protocol no longer has sessions, it mostly limits how well your service scales.',
    whatMayStopWorking:
      'Nothing immediately. This is a configuration cleanup rather than a break.',
    askYourDeveloper:
      'Ask your developer to review whether session affinity is still needed once session handling is removed.',
  },

  /* ---------------------------------------------------------------------- */
  /* Startup and core lifecycle                                              */
  /* ---------------------------------------------------------------------- */
  'MCP2026-LIFECYCLE-001': {
    theme: 'startup',
    headline: 'Your server still uses the old start-up handshake',
    whatWasFound:
      'Your code handles the old connection start-up messages that the new version removed.',
    whyItMatters:
      'The start-up handshake was removed entirely. A client on the new version will never send it, and your handler will never run.',
    whatMayStopWorking:
      'Anything your server sets up during start-up — capability negotiation, per-client configuration, warm-up work — will not happen.',
    askYourDeveloper:
      'Ask your developer to move any start-up work into the individual request handlers, and to remove the old handshake handlers.',
  },
  'MCP2026-LIFECYCLE-002': {
    theme: 'startup',
    headline: 'Your server implements calls that were removed',
    whatWasFound:
      'Your code handles protocol calls that no longer exist in the new version, such as the keep-alive check or resource change subscriptions.',
    whyItMatters:
      'These calls were removed. Code that handles them is dead, and code that sends them will fail.',
    whatMayStopWorking:
      'If you rely on subscriptions to push resource updates to clients, that mechanism is gone and needs replacing.',
    askYourDeveloper:
      'Ask your developer to remove the handlers for the removed calls and to replace any subscription-based updates.',
  },
  'MCP2026-LIFECYCLE-003': {
    theme: 'startup',
    headline: 'Your server uses older connection mechanics',
    whatWasFound:
      'Your code uses the older streaming endpoint or the connection-termination request.',
    whyItMatters:
      'The new version simplified how connections are opened and closed. These mechanics are no longer part of the required behaviour.',
    whatMayStopWorking:
      'Long-lived streaming connections may not behave the way clients on the new version expect.',
    askYourDeveloper:
      'Ask your developer to review the transport setup against the current specification.',
  },

  /* ---------------------------------------------------------------------- */
  /* Request labelling                                                       */
  /* ---------------------------------------------------------------------- */
  'MCP2026-HEADER-001': {
    theme: 'requests',
    headline: 'Requests are missing labels the new version requires',
    whatWasFound:
      'Your code builds an MCP request over HTTP without the required protocol version, method or name labels.',
    whyItMatters:
      'The new version requires these labels on every request so that gateways and servers can route and authorise a call without reading its body.',
    whatMayStopWorking:
      'Servers on the new version can reject these requests outright.',
    askYourDeveloper:
      'Ask your developer to add the required MCP request headers wherever the code builds an MCP request.',
  },
  'MCP2026-HEADER-002': {
    theme: 'requests',
    headline: 'Incoming requests are not being checked against their labels',
    whatWasFound:
      'Your request handler does not appear to verify that the request labels match what is inside the request.',
    whyItMatters:
      'The labels exist so infrastructure can make decisions without opening the request. If the server never checks that they agree with the body, a caller could be routed or authorised as one thing and executed as another.',
    whatMayStopWorking:
      'Nothing visibly. This is a security hardening gap rather than a functional break.',
    askYourDeveloper:
      'Ask your developer to reject any request whose headers disagree with its body.',
  },
  'MCP2026-HEADER-003': {
    theme: 'requests',
    headline: 'Some request labelling is already in place',
    whatWasFound: 'Your code already references the new request headers somewhere.',
    whyItMatters:
      'This is a good sign, but it is not proof that every path through your code sets them.',
    whatMayStopWorking: 'Nothing. This entry is informational.',
    askYourDeveloper:
      'Ask your developer to confirm the headers are set on every request path, not just the one found here.',
  },

  /* ---------------------------------------------------------------------- */
  /* Errors                                                                  */
  /* ---------------------------------------------------------------------- */
  'MCP2026-ERROR-001': {
    theme: 'errors',
    headline: 'Your "not found" error uses a code that changed meaning',
    whatWasFound:
      'Your code returns a specific numeric error code when a requested resource does not exist.',
    whyItMatters:
      'That code was reassigned in the new version. Clients will interpret your "not found" response as something else.',
    whatMayStopWorking:
      'A client asking for a missing item may show the wrong message, or retry when it should stop.',
    askYourDeveloper:
      'Ask your developer to update the resource-not-found error to the code the new specification defines.',
  },
  'MCP2026-ERROR-002': {
    theme: 'errors',
    headline: 'An error code appears that may need updating',
    whatWasFound:
      'Your code uses a numeric error code whose purpose could not be determined automatically.',
    whyItMatters:
      'If this code is being used for a resource-not-found error, its meaning changed. If it is used for something else, it is fine.',
    whatMayStopWorking:
      'Possibly nothing. This needs a human to look at it.',
    askYourDeveloper:
      'Ask your developer to check what this error code is used for and whether its meaning changed.',
  },
  'MCP2026-ERROR-003': {
    theme: 'errors',
    headline: 'Your server sends error codes that were retired',
    whatWasFound:
      'Your code returns numeric error codes that the new version replaced with named errors.',
    whyItMatters:
      'Clients on the new version will not recognise these codes and will treat the failure as generic.',
    whatMayStopWorking:
      'Users will see unhelpful error messages instead of the specific reason a call failed.',
    askYourDeveloper:
      'Ask your developer to map the retired error codes onto the named errors in the new specification.',
  },

  /* ---------------------------------------------------------------------- */
  /* Tasks                                                                   */
  /* ---------------------------------------------------------------------- */
  'MCP2026-TASKS-001': {
    theme: 'tasks',
    headline: 'Your long-running work uses calls that were removed',
    whatWasFound:
      'Your code implements task listing or task result retrieval, which the new version removed.',
    whyItMatters:
      'The way long-running work is tracked was redesigned. These specific calls no longer exist.',
    whatMayStopWorking:
      'Any feature where a user starts something slow and comes back for the result later.',
    askYourDeveloper:
      'Ask your developer to migrate long-running work onto the new task model.',
  },
  'MCP2026-TASKS-002': {
    theme: 'tasks',
    headline: 'Your server advertises the old long-running-work feature',
    whatWasFound:
      'Your code declares support for tasks using the previous configuration format.',
    whyItMatters:
      'The format changed. Clients on the new version will not understand the old declaration.',
    whatMayStopWorking:
      'Clients may not offer your long-running features at all, because they will not see them advertised.',
    askYourDeveloper:
      'Ask your developer to update how the server advertises long-running work support.',
  },
  'MCP2026-TASKS-003': {
    theme: 'tasks',
    headline: 'Your task data uses fields that were renamed or removed',
    whatWasFound:
      'Your code uses task fields, notifications or helpers from the previous design.',
    whyItMatters:
      'These specific fields were renamed or dropped. Some of what was found comes from an even older draft.',
    whatMayStopWorking:
      'Progress updates and status polling for long-running work.',
    askYourDeveloper:
      'Ask your developer to review the task fields against the current specification.',
  },
  'MCP2026-TASKS-004': {
    theme: 'tasks',
    headline: 'Long-running work that asks the user or the model has changed',
    whatWasFound:
      'Your code combines long-running work with asking the assistant or the user for input.',
    whyItMatters:
      'The new version handles asking for input through one unified mechanism instead of task-specific variants.',
    whatMayStopWorking:
      'Flows where a slow operation pauses to ask the user a question.',
    askYourDeveloper:
      'Ask your developer to move these flows onto the new unified input-request mechanism.',
  },

  /* ---------------------------------------------------------------------- */
  /* Assistant-facing features                                               */
  /* ---------------------------------------------------------------------- */
  'MCP2026-SAMPLING-001': {
    theme: 'assistant-features',
    headline: 'Your server asks the assistant to generate text',
    whatWasFound:
      'Your code uses the feature that lets a server ask the connected assistant to run a model request on its behalf.',
    whyItMatters:
      'This feature is deprecated in the new version. It still works during the deprecation window, but it is being replaced.',
    whatMayStopWorking:
      'Nothing immediately. This will need migrating before the feature is removed.',
    askYourDeveloper:
      'Ask your developer to plan a migration away from server-initiated model requests.',
  },
  'MCP2026-SAMPLING-002': {
    theme: 'assistant-features',
    headline: 'Your model requests use context options that were deprecated',
    whatWasFound:
      'Your code asks the assistant to include context from this server or from all connected servers.',
    whyItMatters:
      'Those context options were deprecated because they made it unclear what data was being shared.',
    whatMayStopWorking:
      'The assistant may include less context than you expect.',
    askYourDeveloper:
      'Ask your developer to pass the context your request needs explicitly instead of relying on the deprecated options.',
  },
  'MCP2026-ROOTS-001': {
    theme: 'assistant-features',
    headline: 'Your server asks the client which folders it can access',
    whatWasFound:
      'Your code uses the feature that lists the folders the client has granted access to.',
    whyItMatters:
      'This feature is deprecated in the new version. It still works during the deprecation window.',
    whatMayStopWorking:
      'Nothing immediately. This will need migrating before the feature is removed.',
    askYourDeveloper:
      'Ask your developer to plan a migration away from the folder-listing feature.',
  },
  'MCP2026-ROOTS-002': {
    theme: 'assistant-features',
    headline: 'Your server listens for folder-list changes, which were removed',
    whatWasFound:
      'Your code handles or sends the notification that the accessible folder list changed.',
    whyItMatters:
      'Unlike the folder listing itself, this notification was removed rather than deprecated.',
    whatMayStopWorking:
      'Your server will not be told when the user grants or revokes access to a folder.',
    askYourDeveloper:
      'Ask your developer to remove the folder-change notification handling and re-check access when it is actually needed.',
  },
  'MCP2026-LOGGING-001': {
    theme: 'assistant-features',
    headline: 'Your server sends log messages to the client',
    whatWasFound:
      'Your code advertises or uses the protocol log-message feature.',
    whyItMatters:
      'This feature is deprecated in the new version. It still works during the deprecation window.',
    whatMayStopWorking:
      'Nothing immediately. Diagnostic messages you send to clients will need another route eventually.',
    askYourDeveloper:
      'Ask your developer to plan how diagnostics will be delivered once this feature is removed.',
  },
  'MCP2026-LOGGING-002': {
    theme: 'assistant-features',
    headline: 'Your server implements a log-level call that was removed',
    whatWasFound:
      'Your code handles the request that lets a client change the server log level.',
    whyItMatters:
      'That call was removed. The log level is now carried on individual requests instead.',
    whatMayStopWorking:
      'Clients will no longer be able to turn your diagnostic output up or down.',
    askYourDeveloper:
      'Ask your developer to read the log level from the per-request field instead of the removed call.',
  },
  'MCP2026-ELICITATION-001': {
    theme: 'assistant-features',
    headline: 'Your user-prompting flow uses removed mechanics',
    whatWasFound:
      'Your code uses completion notifications or identifiers from the older way of asking a user a question.',
    whyItMatters:
      'The new version replaced these with a single request-and-response shape.',
    whatMayStopWorking:
      'Anywhere your server pauses to ask a user for confirmation or extra information.',
    askYourDeveloper:
      'Ask your developer to migrate user prompts onto the new input-request mechanism.',
  },

  /* ---------------------------------------------------------------------- */
  /* Multi-round trip                                                        */
  /* ---------------------------------------------------------------------- */
  'MCP2026-MRTR-001': {
    theme: 'assistant-features',
    headline: 'Your server interrupts a call to ask for something',
    whatWasFound:
      'Your code sends a direct request back to the client in the middle of handling a call.',
    whyItMatters:
      'In the new version a server that needs more input returns a result saying so, rather than sending its own request mid-call.',
    whatMayStopWorking:
      'Any flow where handling a request requires asking the user or the assistant for something first.',
    askYourDeveloper:
      'Ask your developer to return an input-required result instead of sending a request back to the client.',
  },
  'MCP2026-MRTR-002': {
    theme: 'results',
    headline: 'An input-required response is incomplete',
    whatWasFound:
      'Your code returns a result saying it needs more input, but without the details the client needs to act on it.',
    whyItMatters:
      'The client cannot ask the user anything if the response does not say what is needed.',
    whatMayStopWorking:
      'The interaction will stall: the client will be told more input is required but not what to ask for.',
    askYourDeveloper:
      'Ask your developer to include the required input requests and continuation state in these responses.',
  },
  'MCP2026-MRTR-003': {
    theme: 'results',
    headline: 'Continuation data is trusted without being verified',
    whatWasFound:
      'Your code reads state that came back from the client and uses it to decide who the user is or what they may do.',
    whyItMatters:
      'That state travelled through the client, so it can be modified. Using it for authorisation without verifying it first would let a caller change their own permissions.',
    whatMayStopWorking:
      'Nothing visibly. This is a security finding.',
    askYourDeveloper:
      'Ask your developer to sign or otherwise verify continuation state before using it for identity or permission decisions.',
  },

  /* ---------------------------------------------------------------------- */
  /* Result shape                                                            */
  /* ---------------------------------------------------------------------- */
  'MCP2026-RESULT-001': {
    theme: 'results',
    headline: 'Your responses are missing a required type field',
    whatWasFound:
      'Your code returns a result without the field that tells the client what kind of result it is.',
    whyItMatters:
      'The new version requires every result to declare its type so the client knows how to read it.',
    whatMayStopWorking:
      'Clients on the new version may reject the response, so the feature simply will not work.',
    askYourDeveloper:
      'Ask your developer to add the result-type field to every response the server returns.',
  },
  'MCP2026-META-001': {
    theme: 'requests',
    headline: 'Requests are missing required metadata',
    whatWasFound:
      'Your code builds requests without the protocol version or client capability metadata the new version requires.',
    whyItMatters:
      'Servers use this metadata to decide what the caller supports before answering.',
    whatMayStopWorking:
      'Servers on the new version may reject these requests.',
    askYourDeveloper:
      'Ask your developer to include the required request metadata wherever requests are constructed.',
  },
  'MCP2026-DISCOVERY-001': {
    theme: 'results',
    headline: 'Your server describes itself using an older format',
    whatWasFound:
      'Your discovery response puts the server details in the old top-level position, or omits the recommended new one.',
    whyItMatters:
      'Clients look for your server name and version in a new place.',
    whatMayStopWorking:
      'Clients may display your server without a name or version.',
    askYourDeveloper:
      'Ask your developer to move the server details into the location the new specification uses.',
  },
  'MCP2026-CACHE-001': {
    theme: 'results',
    headline: 'Your responses do not say how long they can be cached',
    whatWasFound:
      'Your listing or read responses are missing the caching fields the new version requires.',
    whyItMatters:
      'Without these fields, clients cannot cache your responses, so they will ask again every time.',
    whatMayStopWorking:
      'Nothing breaks, but your server will be called more often than it needs to be, which costs latency and money.',
    askYourDeveloper:
      'Ask your developer to add the cache lifetime and scope fields to list and read responses.',
  },

  /* ---------------------------------------------------------------------- */
  /* SDK                                                                     */
  /* ---------------------------------------------------------------------- */
  'MCP2026-SDK-001': {
    theme: 'sdk',
    headline: 'Your server is built on the previous protocol library',
    whatWasFound:
      'Your project depends on the older MCP library and serves traffic through it.',
    whyItMatters:
      'This is the single biggest item on the list. The library is what implements the protocol, so most other findings follow from it.',
    whatMayStopWorking:
      'Until the library is updated, your server speaks the previous protocol version.',
    askYourDeveloper:
      'Ask your developer to upgrade the MCP library first — several other findings may resolve themselves once that is done.',
  },

  /* ---------------------------------------------------------------------- */
  /* Opportunity                                                             */
  /* ---------------------------------------------------------------------- */
  'MCP2026-APPS-001': {
    theme: 'opportunity',
    headline: 'Your server could show a user interface',
    whatWasFound:
      'Your code produces HTML or has other signals suggesting it could present a visual interface inside the assistant.',
    whyItMatters:
      'The new version defines a way for a server to render an interactive interface rather than returning plain text.',
    whatMayStopWorking:
      'Nothing. This is an opportunity, not a problem.',
    askYourDeveloper:
      'Ask your developer whether presenting an interface would improve how users work with this server.',
  },
});

/**
 * A generic guide used when a rule fires that this catalog does not know about.
 *
 * This exists so a scanner upgrade that adds a rule degrades to honest,
 * non-specific copy rather than rendering an empty section or crashing.
 */
const FALLBACK_GUIDE: RuleGuide = Object.freeze({
  theme: 'results',
  headline: 'A migration issue was found',
  whatWasFound:
    'The scanner matched a pattern that changes between the two protocol versions.',
  whyItMatters:
    'This check is newer than the plain-English notes in this report, so only the technical description below is available.',
  whatMayStopWorking:
    'See the technical detail for this finding.',
  askYourDeveloper:
    'Ask your developer to review this finding against the linked official source.',
});

export function guideForRule(ruleId: string): RuleGuide {
  return RULE_GUIDES[ruleId] ?? FALLBACK_GUIDE;
}

/** True when the catalog has specific copy for this rule. */
export function hasGuide(ruleId: string): boolean {
  return Object.prototype.hasOwnProperty.call(RULE_GUIDES, ruleId);
}

/** Every rule ID this catalog covers. Sorted, for tests and documentation. */
export function coveredRuleIds(): string[] {
  return Object.keys(RULE_GUIDES).sort();
}
