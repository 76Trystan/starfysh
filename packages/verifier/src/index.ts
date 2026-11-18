// @sfysh/verifier public entry point.
// The verifier replays a workflow N times against a Page backend, evaluates
// terminal postconditions, compares outputs across runs, and reports the
// result in either human-readable or JSON form. For deterministic CI runs
// and healer dev loops, workflows can also be replayed against a cassette
// recorded from an earlier live run.

export { replay, replayFromCassette, runRegisteredWorkflow, RunTimeoutError } from './replay.js';
export { replay as verify } from './replay.js';
export type { ReplayFromCassetteOptions } from './replay.js';

export {
  createInterpreter,
  interpretWorkflow,
  InterpreterError,
  LoopLimitError,
  StepTimeoutError,
  DEFAULT_MAX_ITERATIONS,
} from './interpreter.js';
export type { InterpreterOptions, StepTrace } from './interpreter.js';

export { evaluateCondition, evaluateConditions } from './postconditions.js';
export { compareOutputs } from './stability.js';

export { humanReport } from './reporters/human.js';
export { jsonReport } from './reporters/json.js';

export {
  CASSETTE_VERSION,
  CassetteError,
  CassetteMissError,
  callKey,
  canonicalJson,
  parseCassette,
  segment,
  serialiseCassette,
} from './cassette.js';
export type { Cassette, CassetteEffect, CassetteValue } from './cassette.js';

export { fakePageFromCassette } from './fake-page.js';
export { recordPage } from './record.js';
export type { RecordOptions, RecordingResult } from './record.js';

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

export {
  checkEnvelope,
  ENVELOPE_HISTORY_RUNS,
  learnEnvelope,
  MIN_ENVELOPE_RUNS,
  shapeOf,
} from './envelope.js';
export type {
  EnvelopeCheck,
  EnvelopeDeviation,
  EnvelopeResult,
  OutputEnvelope,
} from './envelope.js';
