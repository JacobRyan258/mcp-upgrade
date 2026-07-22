import type { ScannerRule } from '../../types.js';
import { appsRules } from './apps-readiness.js';
import { headerRules } from './headers.js';
import { loggingRules } from './logging.js';
import { resourceErrorRules } from './resource-errors.js';
import { rootsRules } from './roots.js';
import { samplingRules } from './sampling.js';
import { statelessLifecycleRules } from './stateless-lifecycle.js';
import { taskRules } from './tasks.js';

/** Every rule, ordered by ID so `--verbose` output is stable. */
export const ALL_RULES: ScannerRule[] = [
  ...statelessLifecycleRules,
  ...headerRules,
  ...resourceErrorRules,
  ...taskRules,
  ...samplingRules,
  ...rootsRules,
  ...loggingRules,
  ...appsRules,
].sort((a, b) => a.id.localeCompare(b.id, 'en'));

export function ruleById(id: string): ScannerRule | undefined {
  return ALL_RULES.find((rule) => rule.id === id);
}

export * from './apps-readiness.js';
export * from './headers.js';
export * from './logging.js';
export * from './resource-errors.js';
export * from './roots.js';
export * from './sampling.js';
export * from './stateless-lifecycle.js';
export * from './tasks.js';
