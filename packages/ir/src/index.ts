// @sfysh/ir, the typed intermediate representation at the centre of the compiler.
// Every other package depends on this one. Nothing in this package depends
// on anything else in the workspace.

export * from './types.js';
export {
  validateWorkflow,
  validateStep,
  isWorkflow,
  isStep,
  type ValidationError,
  type ValidationResult,
} from './validate.js';
export {
  applyPatch,
  diffPatch,
  diffStep,
  findStep,
  hashStep,
  hashWorkflow,
  insertStep,
  listStepIds,
  replaceStep,
  validatePatch,
} from './patch.js';
export type { ApplyPatchResult, StepChange, StepDiff, StepLocation, StepPatch } from './patch.js';
export { HEADER_KEYWORD, planExtract } from './extract.js';
export type { ColumnSpec, ColumnType, ExtractPlan } from './extract.js';
export { parseRoleSelector } from './selectors.js';
export type { RoleOptionValue, RoleSelector } from './selectors.js';

/**
 * Semantic version of the IR schema this package publishes.
 * A workflow's `irVersion` field must match this at parse time, unless a
 * migration path is defined.
 */
export const IR_VERSION = '1.0.0';
