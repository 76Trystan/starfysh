// @sfysh/runtime, helpers that generated workflow code imports.
// Keep this surface small and stable: every change here propagates to
// every generated script.

export type { Page, Locator } from './types.js';

export { workflow, getWorkflow, listWorkflows, resetWorkflows } from './workflow.js';
export type { WorkflowFn } from './workflow.js';
export { WorkflowIdCollisionError } from './workflow.js';

export { createWorkflowContext, MIN_REDACTABLE_SECRET_LENGTH } from './context.js';
export type { WorkflowContext, WorkflowContextInit, EmitSink } from './context.js';

export { asSecret } from './secret.js';
export type { Secret } from './secret.js';

export { assert, poll, AssertionError } from './assert.js';

export { evaluateCondition, assertCondition, PostconditionViolation } from './conditions.js';
export type { ConditionEvaluation } from './conditions.js';

export {
  DEFAULT_SECRET_ENV_PREFIX,
  EnvVaultResolver,
  VaultSecretMissingError,
  VaultSecretNotAllowedError,
} from './vault.js';
export type { EnvVaultResolverOptions, VaultResolver } from './vault.js';

export {
  ExtractionError,
  extractTable,
  extractValue,
  extractList,
  normaliseHeader,
} from './emit.js';
export type { ColumnSchema, ColumnSpec, ColumnType, TableRow } from './emit.js';

export { guard } from './guard.js';

export { step, StepFailure, describeFailure } from './step.js';

export { tryCandidates } from './candidates.js';
export type { CandidateLookup, DegradedStep } from './candidates.js';
export type { StepOptions } from './step.js';

export {
  conditionHolds,
  DEFAULT_MAX_ITERATIONS,
  forEachItem,
  LoopLimitError,
  StepTimeoutError,
  UnsupportedConditionError,
  whileHolds,
  withTimeout,
} from './control.js';
export type { StepInfo, FailureAttribution, DescribedFailure } from './step.js';

export {
  capturePageSnapshot,
  DEFAULT_SNAPSHOT_MAX_CHARS,
  DEFAULT_SNAPSHOT_TIMEOUT_MS,
} from './snapshot.js';
export type { PageSnapshot, SnapshotOptions } from './snapshot.js';

export { run } from './runner.js';
export type { RunResult, RunOptions } from './runner.js';
