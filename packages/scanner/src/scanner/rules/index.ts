import type { ScannerRule } from '../../types.js';
import { compareCodeUnits } from '../../order.js';
import { appsRules } from './apps-readiness.js';
import { headerRules } from './headers.js';
import { loggingRules } from './logging.js';
import { modernProtocolRules } from './modern-protocol.js';
import { resourceErrorRules } from './resource-errors.js';
import { rootsRules } from './roots.js';
import { samplingRules } from './sampling.js';
import { statelessLifecycleRules } from './stateless-lifecycle.js';
import { taskRules } from './tasks.js';

function freezeRule(rule: ScannerRule): ScannerRule {
  Object.freeze(rule.source);
  Object.freeze(rule.appliesTo.fileKinds);
  Object.freeze(rule.appliesTo.transports);
  Object.freeze(rule.appliesTo);
  return Object.freeze(rule);
}

/** Every rule, ordered by ID so `--verbose` output is stable and scan-isolated. */
export const ALL_RULES: readonly ScannerRule[] = Object.freeze([
  ...statelessLifecycleRules,
  ...headerRules,
  ...resourceErrorRules,
  ...taskRules,
  ...samplingRules,
  ...rootsRules,
  ...loggingRules,
  ...modernProtocolRules,
  ...appsRules,
]
  .sort((a, b) => compareCodeUnits(a.id, b.id))
  .map(freezeRule));

export function ruleById(id: string): ScannerRule | undefined {
  return ALL_RULES.find((rule) => rule.id === id);
}

export * from './apps-readiness.js';
export * from './headers.js';
export * from './logging.js';
export * from './modern-protocol.js';
export * from './resource-errors.js';
export * from './roots.js';
export * from './sampling.js';
export * from './stateless-lifecycle.js';
export * from './tasks.js';
