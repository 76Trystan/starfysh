export {
  buildHealPrompt,
  HealInputError,
  HEALED_STEP_ID_PREFIX,
  INSERT_STEP_SYSTEM_PROMPT,
  SELECTOR_SYSTEM_PROMPT,
  systemPromptFor,
  DEFAULT_PROMPT_SNAPSHOT_MAX_CHARS,
  PROMPT_ERROR_MAX_CHARS,
  PROMPT_OUTLINE_MAX_STEPS,
} from './prompt.js';
export type {
  HealFailure,
  HealInputErrorCode,
  HealPrompt,
  HealPromptInput,
  HealTriage,
} from './prompt.js';

export { parseHealResponse, RATIONALE_MAX_CHARS, RESPONSE_MAX_CHARS } from './response.js';
export type { HealPatchContext, HealResponse, HealResponseErrorCode } from './response.js';

export {
  classifyOutcome,
  pageRequiresField,
  PAGE_REQUIRES_FIELD,
  routeFor,
  triageFailure,
} from './triage.js';
export type { HealerTriage, HealRoute, TriageDecision, TriageOptions } from './triage.js';

export { checkPatchScope, STEP_FIELDS } from './scope.js';
export type { ScopeResult, ScopeViolation, ScopeViolationCode } from './scope.js';

export { checkPatchClass, INSERTABLE_ACTIONS, INSERTED_STEP_MAX_TIMEOUT_MS } from './allowlist.js';
export type {
  AllowlistResult,
  AllowlistViolation,
  AllowlistViolationCode,
  PatchClass,
} from './allowlist.js';

export { checkPatchReach } from './reach.js';
export type {
  ReachApproval,
  ReachApprovalCode,
  ReachResult,
  ReachViolation,
  ReachViolationCode,
} from './reach.js';

export {
  checkPatchPatterns,
  checkUrlPattern,
  URL_PATTERN_MAX_CHARS,
  URL_PATTERN_MAX_UNBOUNDED,
} from './pattern.js';
export type {
  PatternResult,
  PatternViolation,
  PatternViolationCode,
  UrlPatternProblem,
} from './pattern.js';

export { checkPatch } from './check.js';
export type { PatchCheckName, PatchVerdict, PatchViolation } from './check.js';

export {
  CANDIDATE_ORDER,
  DEFAULT_HEAL_MAX_TOKENS,
  DEFAULT_HEAL_TIMEOUT_MS,
  generateInsertStepPatch,
  generateSelectorPatch,
  MAX_SELECTOR_CANDIDATES,
} from './generate.js';
export type {
  GeneratePatchInput,
  GeneratePatchRejection,
  GeneratePatchResult,
  HealCall,
  InsertStepPatchInput,
  InsertStepPatchResult,
  SelectorPatchInput,
  SelectorPatchRejection,
  SelectorPatchResult,
} from './generate.js';

export { CONFIDENCE_HIGH, CONFIDENCE_MEDIUM, INSERT_STEP_MAX_SCORE, scorePatch } from './score.js';
export type {
  ConfidenceLevel,
  PatchScore,
  ScorePatchInput,
  ScoreSignal,
  ScoreSignalCode,
} from './score.js';

export {
  approvePatch,
  decidePatch,
  DEFAULT_ACCEPTANCE_POLICY,
  MIN_ACCEPT_RUNS,
  verifyPatch,
} from './accept.js';
export type {
  AcceptancePolicy,
  ApprovalReason,
  ApprovalReasonCode,
  ApprovePatchInput,
  ApprovePatchResult,
  DecidePatchInput,
  KnownGood,
  PatchDecision,
  PatchVerification,
  VerificationFailure,
  VerificationFailureCode,
  VerifyPatchInput,
} from './accept.js';

/**
 * Thrown by `heal()` until the healer is implemented. The package is a
 * scaffold: it exists so the workspace wiring, the dependency graph and the
 * test runner are in place before any healing logic lands.
 */
export class HealerNotImplementedError extends Error {
  constructor() {
    super('@sfysh/healer is a scaffold. heal() is not implemented yet.');
    this.name = 'HealerNotImplementedError';
  }
}

/**
 * Placeholder entry point. The real signature is settled when the model
 * input builder and the patch parser land, so this takes no arguments
 * instead of committing to a shape early.
 */
export async function heal(): Promise<never> {
  throw new HealerNotImplementedError();
}
