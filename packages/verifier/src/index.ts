// @sfysh/verifier public entry point.
// The verifier replays a workflow N times against a Page backend, evaluates
// terminal postconditions, compares outputs across runs, and reports the
// result in either human-readable or JSON form.

export { replay } from './replay.js';
export { replay as verify } from './replay.js';

export { evaluateCondition, evaluateConditions } from './postconditions.js';
export { compareOutputs } from './stability.js';

export { humanReport } from './reporters/human.js';
export { jsonReport } from './reporters/json.js';

export type {
  RunnerFn,
  PageFactory,
  PageDisposer,
  ToleranceMap,
  ToleranceRule,
  VerifyOptions,
  TimingEnvelope,
  PostconditionResult,
  ReplayOutcome,
  DriftField,
  StabilityReport,
  VerifyReport,
} from './types.js';
