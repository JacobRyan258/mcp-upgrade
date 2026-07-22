import { DEFAULT_TARGET_VERSION, EXTENSION_IDS, SOURCES } from '../../constants.js';
import type { Finding, ScanContext, ScannerRule } from '../../types.js';
import { collectPropertyPaths, getSourceFile } from '../ast.js';
import { isInComment, offsetToPosition } from '../discovery.js';
import {
  buildFinding,
  dedupeByLocation,
  filesFor,
  hasContextNear,
  identifierLiteral,
  matches,
  quotedLiteral,
} from './helpers.js';

/**
 * Group 4 — Tasks extension migration (SEP-2663).
 *
 * The experimental Tasks feature from `2025-11-25` leaves the core protocol and
 * becomes the official `io.modelcontextprotocol/tasks` extension. The surfaces
 * are explicitly not wire-compatible, so nothing here is ever marked safe for
 * automatic rewriting.
 */

const MIGRATION_SUMMARY =
  'Tasks move from an experimental core feature in 2025-11-25 to an official extension identified ' +
  `by "${EXTENSION_IDS.tasks}". Capability negotiation changes shape entirely: the client declares ` +
  'the extension per request inside _meta["io.modelcontextprotocol/clientCapabilities"].extensions, ' +
  'and the server advertises it under capabilities.extensions in its server/discover result. The ' +
  'lifecycle changes too — the server alone decides whether a tools/call becomes a task and may ' +
  'return a task handle unsolicited, rather than the client opting in per request.';

const SEMANTIC_REVIEW_NOTE =
  'The old and new surfaces are not wire-compatible, so this migration needs semantic review; it ' +
  'is not safe to rewrite mechanically.';

/* -------------------------------------------------------------------------- */
/* MCP2026-TASKS-001 — removed task RPCs                                       */
/* -------------------------------------------------------------------------- */

interface RemovedTaskMethod {
  method: string;
  identifiers: string[];
  why: string;
  replacement: string;
}

const REMOVED_TASK_METHODS: RemovedTaskMethod[] = [
  {
    method: 'tasks/list',
    identifiers: ['ListTasksRequestSchema', 'ListTasksResult', 'ListTasksRequest'],
    why:
      'tasks/list is removed. The changelog records that the redesigned extension "removes ' +
      'tasks/list", and SEP-2663 explains why: once protocol sessions were removed there was no ' +
      'safe way to scope which tasks a caller is entitled to enumerate.',
    replacement:
      'There is no replacement enumeration RPC. Track the task IDs your client created and poll ' +
      'them individually with tasks/get, or subscribe to notifications/tasks by passing ' +
      'params.notifications.taskIds to subscriptions/listen. Persist task IDs client-side so ' +
      'polling can resume after a restart.',
  },
  {
    method: 'tasks/result',
    identifiers: ['GetTaskPayloadRequestSchema', 'GetTaskPayloadRequest'],
    why:
      'tasks/result is removed. SEP-2663 replaces the blocking result-retrieval method with ' +
      'polling, and states that a client calling it "MUST receive -32601 (Method Not Found)".',
    replacement:
      'Poll tasks/get instead. A completed task carries its result on the task object, and a failed ' +
      'task carries the JSON-RPC error. Respect the server-supplied pollIntervalMs.',
  },
];

export const removedTaskMethodsRule: ScannerRule = {
  id: 'MCP2026-TASKS-001',
  title: 'Task RPC removed in the target specification',
  category: 'tasks',
  targetVersion: DEFAULT_TARGET_VERSION,
  level: 'error',
  defaultConfidence: 'high',
  source: SOURCES.sep2663,
  appliesTo: {
    fileKinds: ['ts', 'js'],
    transports: ['stdio', 'streamable-http', 'mixed', 'custom-http', 'unknown'],
  },
  autofix: 'manual',
  description: 'Detects the removed tasks/list and tasks/result RPCs and their SDK schema constants.',

  async scan(context: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];

    for (const file of filesFor(this, context)) {
      for (const removed of REMOVED_TASK_METHODS) {
        for (const { hit } of matches(context, this, file, quotedLiteral([removed.method]))) {
          findings.push(
            buildFinding(this, hit, {
              title: `Removed task RPC "${removed.method}"`,
              explanation: `${removed.why} ${MIGRATION_SUMMARY}`,
              remediation: `${removed.replacement} ${SEMANTIC_REVIEW_NOTE}`,
            }),
          );
        }
        for (const { hit } of matches(context, this, file, identifierLiteral(removed.identifiers))) {
          findings.push(
            buildFinding(this, hit, {
              title: `SDK type for the removed task RPC "${removed.method}" (${hit.text})`,
              explanation: `${removed.why} ${MIGRATION_SUMMARY}`,
              remediation: `${removed.replacement} ${SEMANTIC_REVIEW_NOTE}`,
            }),
          );
        }
      }
    }

    return dedupeByLocation(findings);
  },
};

/* -------------------------------------------------------------------------- */
/* MCP2026-TASKS-002 — legacy capability negotiation                           */
/* -------------------------------------------------------------------------- */

/** Object-literal paths that declare the 2025-11-25 tasks capability. */
const LEGACY_CAPABILITY_PATHS = [
  /(^|\.)capabilities\.tasks(\.|$)/,
  /(^|\.)tasks\.requests(\.|$)/,
  /(^|\.)tasks\.(?:list|cancel)$/,
  /(^|\.)experimental\.tasks(\.|$)/,
];

const LEGACY_CAPABILITY_LITERALS = ['execution.taskSupport', 'taskSupport'];

export const legacyTaskCapabilityRule: ScannerRule = {
  id: 'MCP2026-TASKS-002',
  title: 'Experimental Tasks capability negotiation from 2025-11-25',
  category: 'tasks',
  targetVersion: DEFAULT_TARGET_VERSION,
  level: 'error',
  defaultConfidence: 'high',
  source: SOURCES.sep2663,
  appliesTo: {
    fileKinds: ['ts', 'js', 'json'],
    transports: ['stdio', 'streamable-http', 'mixed', 'custom-http', 'unknown'],
  },
  autofix: 'manual',
  description:
    'Detects the 2025-11-25 tasks capability declarations (capabilities.tasks, tasks.requests.*, ' +
    'tasks.list, tasks.cancel, experimental.tasks) and the tool-level execution.taskSupport field.',

  async scan(context: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];

    const explanation =
      `${MIGRATION_SUMMARY} The legacy capability keys are not part of the extension. SEP-2663 ` +
      'states that servers which advertised them "MUST migrate to declaring ' +
      `"${EXTENSION_IDS.tasks}"" and must not keep advertising the legacy keys. The tool-level ` +
      'execution.taskSupport field is gone with them: it was part of the fragile handshake that ' +
      'forced clients to prime state from tools/list before they could call a tool as a task.';

    const remediation =
      `Declare the extension instead. Server side, advertise "${EXTENSION_IDS.tasks}" under ` +
      'capabilities.extensions in the server/discover result. Client side, declare it per request ' +
      'inside _meta["io.modelcontextprotocol/clientCapabilities"].extensions. Remove ' +
      'capabilities.tasks, tasks.requests.*, tasks.list, tasks.cancel and execution.taskSupport. ' +
      'Then decide server-side, per call, whether to return a CreateTaskResult — and never return ' +
      'one to a client that did not declare the extension on that request, which must instead get ' +
      `-32021 (Missing Required Client Capability). ${SEMANTIC_REVIEW_NOTE}`;

    for (const file of filesFor(this, context)) {
      const sourceFile = getSourceFile(file);

      if (sourceFile) {
        for (const property of collectPropertyPaths(sourceFile)) {
          if (!LEGACY_CAPABILITY_PATHS.some((pattern) => pattern.test(property.path))) continue;
          if (isInComment(file, property.start)) {
            const { line } = offsetToPosition(file, property.start);
            context.noteCommentOnlyMatch(this.id, file.relPath, line, property.path);
            continue;
          }
          findings.push(
            buildFinding(
              this,
              { file, offset: property.start, endOffset: property.end, text: property.path },
              {
                title: `Legacy Tasks capability declaration (${property.path})`,
                explanation,
                remediation,
              },
            ),
          );
        }
      }

      for (const { hit } of matches(
        context,
        this,
        file,
        quotedLiteral(LEGACY_CAPABILITY_LITERALS),
      )) {
        findings.push(
          buildFinding(this, hit, {
            title: 'Legacy per-tool task support declaration (execution.taskSupport)',
            explanation,
            remediation,
          }),
        );
      }
    }

    return dedupeByLocation(findings);
  },
};

/* -------------------------------------------------------------------------- */
/* MCP2026-TASKS-003 — legacy augmentation and lifecycle structures            */
/* -------------------------------------------------------------------------- */

const LEGACY_TASK_LITERALS = [
  'io.modelcontextprotocol/related-task',
  'modelcontextprotocol.io/related-task',
  'modelcontextprotocol.io/task',
  'io.modelcontextprotocol/model-immediate-response',
  'notifications/tasks/status',
  'notifications/tasks/created',
  'tasks/delete',
];

const LEGACY_TASK_IDENTIFIERS = [
  'TaskStatusNotificationSchema',
  'TaskAugmentedRequestParams',
  'isTaskAugmentedRequestParams',
  'RELATED_TASK_META_KEY',
  'InMemoryTaskStore',
  'TaskStore',
  'InMemoryTaskMessageQueue',
  'TaskMessageQueue',
  'registerToolTask',
  'ToolTaskHandler',
  'TaskRequestHandler',
  'CreateTaskRequestHandler',
  'CreateTaskServerContext',
  'TaskServerContext',
  'TaskToolExecution',
  'callToolStream',
  'requestStream',
  'ExperimentalServerTasks',
  'ExperimentalClientTasks',
  'ExperimentalMcpServerTasks',
];

/** Legacy Task object fields that were renamed in the extension. */
const LEGACY_TASK_FIELDS = ['pollInterval', 'statusMessage', 'lastUpdatedAt'];

const TASK_CONTEXT_NEEDLES = ['task', 'taskid'];

export const legacyTaskStructuresRule: ScannerRule = {
  id: 'MCP2026-TASKS-003',
  title: 'Legacy task augmentation or lifecycle structure from 2025-11-25',
  category: 'tasks',
  targetVersion: DEFAULT_TARGET_VERSION,
  level: 'review',
  defaultConfidence: 'medium',
  source: SOURCES.sep2663,
  appliesTo: {
    fileKinds: ['ts', 'js'],
    transports: ['stdio', 'streamable-http', 'mixed', 'custom-http', 'unknown'],
  },
  autofix: 'manual',
  description:
    'Detects 2025-11-25 task augmentation structures, lifecycle fields and SDK helper types that ' +
    'the Tasks extension replaces.',

  async scan(context: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];

    const explanation =
      `${MIGRATION_SUMMARY} Alongside the capability change, the request and task shapes changed: ` +
      'the per-request "task" opt-in parameter on CallToolRequest is removed and servers must now ' +
      'ignore it, related-task correlation moved, and Task fields were renamed (pollInterval became ' +
      'pollIntervalMs, ttl became ttlMs). A new tasks/update method carries client input back as ' +
      'inputResponses.';

    const remediation =
      'Rework this against the extension: poll tasks/get, answer outstanding inputRequests with ' +
      'tasks/update, cancel with tasks/cancel, and read pollIntervalMs and ttlMs from the task ' +
      'object. Drop the per-request task parameter — the server now decides. Over Streamable HTTP, ' +
      `tasks/get, tasks/update and tasks/cancel must set Mcp-Name to params.taskId. ${SEMANTIC_REVIEW_NOTE}`;

    for (const file of filesFor(this, context)) {
      for (const { hit } of matches(context, this, file, quotedLiteral(LEGACY_TASK_LITERALS))) {
        findings.push(
          buildFinding(this, hit, {
            title: `Legacy Tasks protocol literal (${hit.text.slice(1, -1)})`,
            explanation,
            remediation,
          }),
        );
      }

      for (const { hit } of matches(
        context,
        this,
        file,
        identifierLiteral(LEGACY_TASK_IDENTIFIERS),
      )) {
        findings.push(
          buildFinding(this, hit, {
            title: `Legacy Tasks SDK surface (${hit.text})`,
            explanation,
            remediation,
          }),
        );
      }

      // Renamed fields are ordinary words; require task context nearby.
      for (const { hit } of matches(
        context,
        this,
        file,
        new RegExp(`\\b(${LEGACY_TASK_FIELDS.join('|')})\\s*:`, 'g'),
      )) {
        if (!hasContextNear(file, hit.offset, TASK_CONTEXT_NEEDLES, 300)) continue;
        findings.push(
          buildFinding(this, hit, {
            title: `Legacy Task field (${hit.text.replace(/\s*:$/, '')})`,
            explanation,
            remediation,
          }),
        );
      }
    }

    return dedupeByLocation(findings);
  },
};

/* -------------------------------------------------------------------------- */
/* MCP2026-TASKS-004 — task-augmented sampling and elicitation                 */
/* -------------------------------------------------------------------------- */

const TASK_AUGMENTED_PATHS = [
  /(^|\.)tasks\.requests\.sampling(\.|$)/,
  /(^|\.)tasks\.requests\.elicitation(\.|$)/,
];

const TASK_AUGMENTED_IDENTIFIERS = ['createMessageStream', 'elicitInputStream'];

export const taskAugmentedSamplingRule: ScannerRule = {
  id: 'MCP2026-TASKS-004',
  title: 'Task-augmented Sampling or Elicitation is removed in the target specification',
  category: 'tasks',
  targetVersion: DEFAULT_TARGET_VERSION,
  level: 'error',
  defaultConfidence: 'high',
  source: SOURCES.sep2663,
  appliesTo: {
    fileKinds: ['ts', 'js', 'json'],
    transports: ['stdio', 'streamable-http', 'mixed', 'custom-http', 'unknown'],
  },
  autofix: 'manual',
  description:
    'Detects the 2025-11-25 task-augmented Sampling and Elicitation capabilities, which the Tasks ' +
    'extension does not carry forward.',

  async scan(context: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];

    const explanation =
      'In 2025-11-25 a client could advertise task augmentation for client-hosted requests via ' +
      'tasks.requests.sampling.createMessage and tasks.requests.elicitation.create. The Tasks ' +
      'extension removes those: tools/call is the only method that supports task augmentation, and ' +
      'client-hosted task requests were dropped to comply with SEP-2260, which requires every ' +
      'server request to be associated with a client request.';

    const remediation =
      'Remove task-augmented Sampling and Elicitation. Server-to-client input during a task now ' +
      'flows through the task itself: a task in the input_required state exposes inputRequests on ' +
      'tasks/get, and the client answers with inputResponses on tasks/update. Sampling is also ' +
      `deprecated independently of this change — see MCP2026-SAMPLING-001. ${SEMANTIC_REVIEW_NOTE}`;

    for (const file of filesFor(this, context)) {
      const sourceFile = getSourceFile(file);

      if (sourceFile) {
        for (const property of collectPropertyPaths(sourceFile)) {
          if (!TASK_AUGMENTED_PATHS.some((pattern) => pattern.test(property.path))) continue;
          if (isInComment(file, property.start)) continue;
          findings.push(
            buildFinding(
              this,
              { file, offset: property.start, endOffset: property.end, text: property.path },
              {
                title: `Task-augmented capability removed in the extension (${property.path})`,
                explanation,
                remediation,
              },
            ),
          );
        }
      }

      for (const { hit } of matches(
        context,
        this,
        file,
        identifierLiteral(TASK_AUGMENTED_IDENTIFIERS),
      )) {
        findings.push(
          buildFinding(this, hit, {
            title: `Task-augmented SDK surface removed in the extension (${hit.text})`,
            explanation,
            remediation,
          }),
        );
      }
    }

    return dedupeByLocation(findings);
  },
};

export const taskRules: ScannerRule[] = [
  removedTaskMethodsRule,
  legacyTaskCapabilityRule,
  legacyTaskStructuresRule,
  taskAugmentedSamplingRule,
];
