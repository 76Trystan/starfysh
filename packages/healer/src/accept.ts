// Acceptance: the last gate between a checked patch and a changed workflow.
//
// A patch from a generator has broken no rule and points at something in
// the snapshot. That is not enough to change a workflow. Two more things
// have to be true, in this order:
//
// 1. Verification (`verifyPatch`). The patched workflow is replayed live
//    at least `MIN_ACCEPT_RUNS` times. Every run must pass, and every
//    run's outputs must match the outputs of the last known-good run of
//    the workflow before it broke. Runs that agree with each other are not
//    enough: a patch that reads the wrong column reads it the same way
//    every time.
// 2. A decision (`decidePatch`). Human approval is the default. A verified
//    patch waits for a person (`approvePatch`) unless the caller opted in
//    to automatic acceptance, and even then some patches always wait.
//
// Nothing here calls a model. Nothing here writes the workflow anywhere:
// an accepted decision carries the patched workflow, and storing it is the
// caller's job.

import { applyPatch, hashWorkflow } from '@sfysh/ir';
import type { StepPatch, ValidationError, Workflow } from '@sfysh/ir';
import { DEFAULT_SECRET_ENV_PREFIX, EnvVaultResolver } from '@sfysh/runtime';
import type { SnapshotOptions, VaultResolver } from '@sfysh/runtime';
import { compareOutputs, createInterpreter, replay } from '@sfysh/verifier';
import type {
  DriftField,
  PageDisposer,
  PageFactory,
  RunnerFn,
  ToleranceMap,
  VerifyReport,
} from '@sfysh/verifier';
import type { PatchClass } from './allowlist.js';
import { checkPatch } from './check.js';
import type { PatchViolation } from './check.js';
import { same } from './equal.js';
import type { ReachApproval } from './reach.js';
import type { Reversion } from './revert.js';
import { CONFIDENCE_HIGH } from './score.js';
import type { PatchScore } from './score.js';

/** Fewest live runs a patch is verified with. The design doc's N. */
export const MIN_ACCEPT_RUNS = 3;

/**
 * Outputs of the last run of the workflow that passed before it broke.
 * This is what a healed workflow must still produce.
 */
export interface KnownGood {
  /** The run's outputs, as `ReplayOutcome.outputs` or `ctx.drainOutputs()` gave them. */
  outputs: unknown[];
}

export interface VerifyPatchInput {
  /** The workflow the patch was written against. */
  workflow: Workflow;
  /** A patch from a generator. It is applied here; the caller does not apply it first. */
  patch: StepPatch;
  /** What the workflow produced the last time it worked. Required: without it there is nothing to compare against. */
  knownGood: KnownGood;
  /**
   * A fresh live page per run. Must drive the real site: a cassette is
   * never evidence for accepting a patch, because it can only replay
   * what the old workflow did.
   */
  pageFactory: PageFactory;
  dispose?: PageDisposer;
  /** Number of runs. Default and minimum `MIN_ACCEPT_RUNS`. */
  runs?: number;
  /**
   * Fields allowed to differ, both between runs and from the known-good
   * outputs. Use the workflow's own tolerance map; widening it to get a
   * patch through defeats the check.
   */
  tolerance?: ToleranceMap;
  /**
   * Values for `{ param }` references, passed to the interpreter. Ignored
   * when `runner` is given.
   */
  params?: Record<string, string>;
  /**
   * Runs the workflow. Default: the IR interpreter, first candidate only,
   * which also confirms the patched step ran (see `stepRan`). A custom
   * runner skips that confirmation.
   */
  runner?: RunnerFn;
  /**
   * Secret source. Default: environment variables with the
   * `SFYSH_SECRET_` prefix, limited to the patched workflow's declared
   * secrets, with no fallback to unprefixed names.
   */
  vaultResolver?: VaultResolver;
  /** Longest one run may take, in milliseconds. */
  runTimeoutMs?: number;
  /** Page snapshot on a failed run. See `VerifyOptions.snapshot`. */
  snapshot?: boolean | SnapshotOptions;
}

export type VerificationFailureCode =
  /** A run failed: an error, or a violated postcondition. */
  | 'run_failed'
  /** The runs passed but their outputs differ from one another. */
  | 'unstable'
  /** A run's outputs differ from the known-good outputs. */
  | 'output_mismatch'
  /** The step the patch changed or added did not run, or did not pass, in a run. */
  | 'patched_step_not_run';

export interface VerificationFailure {
  code: VerificationFailureCode;
  /** Zero-based run index, when the failure belongs to one run. */
  run?: number;
  /** Fields that differ, for `unstable` and `output_mismatch`. */
  drift?: DriftField[];
  message: string;
}

export type PatchVerification =
  | {
      /** The patch does not apply to the workflow. Nothing was run. */
      status: 'not_applied';
      patch: StepPatch;
      errors: ValidationError[];
    }
  | {
      status: 'failed';
      patch: StepPatch;
      failures: VerificationFailure[];
      report: VerifyReport;
    }
  | {
      status: 'verified';
      patch: StepPatch;
      /** The workflow with the patch applied. */
      workflow: Workflow;
      /** `hashWorkflow` of `workflow`. */
      hash: string;
      report: VerifyReport;
      /**
       * Whether every run confirmed the patched step ran and passed.
       * `unchecked` when a custom runner was used.
       */
      stepRan: 'confirmed' | 'unchecked';
    };

/**
 * Apply a patch and replay the patched workflow live, then hold the
 * results to the known-good outputs.
 *
 * All the evidence is collected before judging, so a failed verification
 * lists every reason, not only the first. Throws only for a mistake in the
 * arguments (fewer than `MIN_ACCEPT_RUNS` runs).
 */
export async function verifyPatch(input: VerifyPatchInput): Promise<PatchVerification> {
  const runs = input.runs ?? MIN_ACCEPT_RUNS;
  if (!Number.isInteger(runs) || runs < MIN_ACCEPT_RUNS) {
    throw new RangeError(`A patch is verified with at least ${MIN_ACCEPT_RUNS} runs, not ${runs}.`);
  }

  const applied = applyPatch(input.workflow, input.patch);
  if (!applied.ok) return { status: 'not_applied', patch: input.patch, errors: applied.errors };
  const patched = applied.workflow;

  // The step whose run proves the patch was exercised: the replaced step
  // keeps its id, and an inserted step brings its own.
  const watchedId = input.patch.op === 'replace' ? input.patch.stepId : input.patch.after.id;
  // Runs are sequential, so the order of calls is the run index.
  const ranPerRun: boolean[] = [];
  let calls = 0;
  const runner: RunnerFn =
    input.runner ??
    (async (ctx, workflow) => {
      const index = calls++;
      let ran = false;
      const interpreter = createInterpreter({
        candidates: 'first',
        ...(input.params !== undefined ? { params: input.params } : {}),
        onStep: (trace) => {
          if (trace.stepId === watchedId && trace.status === 'ok') ran = true;
        },
      });
      try {
        await interpreter(ctx, workflow);
      } finally {
        ranPerRun[index] = ran;
      }
    });

  const report = await replay(patched, {
    pageFactory: input.pageFactory,
    runner,
    runs,
    vaultResolver:
      input.vaultResolver ??
      new EnvVaultResolver({ prefix: DEFAULT_SECRET_ENV_PREFIX, allow: patched.secrets ?? [] }),
    ...(input.dispose !== undefined ? { dispose: input.dispose } : {}),
    ...(input.tolerance !== undefined ? { tolerance: input.tolerance } : {}),
    ...(input.runTimeoutMs !== undefined ? { runTimeoutMs: input.runTimeoutMs } : {}),
    ...(input.snapshot !== undefined ? { snapshot: input.snapshot } : {}),
  });

  const failures: VerificationFailure[] = [];
  for (const outcome of report.replays) {
    if (outcome.status !== 'ok') {
      failures.push({
        code: 'run_failed',
        run: outcome.index,
        message: outcome.error
          ? `Run ${outcome.index + 1} failed: ${outcome.error.message}`
          : `Run ${outcome.index + 1} failed a terminal postcondition.`,
      });
    }
  }
  if (!report.stability.stable) {
    failures.push({
      code: 'unstable',
      drift: report.stability.drift,
      message: `The runs produced different outputs (${fieldList(report.stability.drift)}).`,
    });
  }
  for (const outcome of report.replays) {
    if (outcome.status !== 'ok') continue;
    const against = compareOutputs([input.knownGood.outputs, outcome.outputs], input.tolerance);
    if (!against.stable) {
      failures.push({
        code: 'output_mismatch',
        run: outcome.index,
        drift: against.drift,
        message: `Run ${outcome.index + 1} does not match the known-good outputs (${fieldList(against.drift)}).`,
      });
    }
  }
  if (input.runner === undefined) {
    report.replays.forEach((outcome, index) => {
      // A failed run is already reported; whether it reached the step adds nothing.
      if (outcome.status === 'ok' && ranPerRun[index] !== true) {
        failures.push({
          code: 'patched_step_not_run',
          run: index,
          message: `Run ${index + 1} passed without the patched step running, so it says nothing about the patch.`,
        });
      }
    });
  }

  if (failures.length > 0) return { status: 'failed', patch: input.patch, failures, report };
  return {
    status: 'verified',
    patch: input.patch,
    workflow: patched,
    hash: applied.hash,
    report,
    stepRan: input.runner === undefined ? 'confirmed' : 'unchecked',
  };
}

function fieldList(drift: DriftField[]): string {
  const paths = drift.map((d) => (d.path === '' ? '(whole output)' : d.path));
  const shown = paths.slice(0, 5).join(', ');
  return paths.length > 5 ? `${shown} and ${paths.length - 5} more` : shown;
}

/**
 * How a verified patch is accepted. The default is `{ mode: 'human' }`:
 * every patch waits for a person.
 *
 * `auto` accepts a verified patch without a person only when all of these
 * hold: it is a `selector` patch, the checks asked for no approval, and
 * its score is at least `minScore`. `minScore` may not be below
 * `CONFIDENCE_HIGH`. The score weights are not yet calibrated against
 * real heals, so `auto` should stay off until the benchmark shows false
 * heals cluster below the threshold.
 */
export type AcceptancePolicy = { mode: 'human' } | { mode: 'auto'; minScore: number };

export const DEFAULT_ACCEPTANCE_POLICY: AcceptancePolicy = { mode: 'human' };

export type ApprovalReasonCode =
  /** The policy is human approval. */
  | 'policy_requires_review'
  /** The patch checks listed points a person must confirm (a retargeted secret). */
  | 'checks_require_review'
  /** Insert-step patches always go to a person: nothing in code limits what an inserted click may press. */
  | 'insert_step'
  /** The score is below the policy's `minScore`. */
  | 'score_below_threshold'
  /** The patch undoes an earlier heal: the site may be switching between versions. */
  | 'reverts_earlier_heal'
  /** Verification used a custom runner, so it did not confirm the patched step ran. */
  | 'step_not_confirmed';

export interface ApprovalReason {
  code: ApprovalReasonCode;
  message: string;
}

export interface DecidePatchInput {
  /** The workflow the patch was written against. */
  workflow: Workflow;
  patchClass: PatchClass;
  /** The score the generator gave the patch. */
  score: PatchScore;
  verification: PatchVerification;
  /** Default `{ mode: 'human' }`. */
  policy?: AcceptancePolicy;
  /** Earlier heals this patch undoes, from `findReversions`. Any entry holds the patch for a person. */
  reversions?: readonly Reversion[];
}

export type PatchDecision =
  | {
      status: 'rejected';
      patch: StepPatch;
      /** Why: failed checks, or failed verification. */
      violations?: PatchViolation[];
      verification?: PatchVerification;
      message: string;
    }
  | {
      status: 'awaiting_approval';
      patch: StepPatch;
      score: PatchScore;
      /** Every reason a person is needed. Never empty. */
      reasons: ApprovalReason[];
      /** Points the patch checks asked a person to confirm, if any. */
      approvals: ReachApproval[];
      /** The patched workflow and its hash, ready for `approvePatch`. */
      workflow: Workflow;
      hash: string;
      report: VerifyReport;
    }
  | {
      status: 'accepted';
      patch: StepPatch;
      score: PatchScore;
      workflow: Workflow;
      hash: string;
      report: VerifyReport;
      acceptedBy: { kind: 'policy' } | { kind: 'reviewer'; reviewer: string; at: string };
    };

/**
 * Decide what happens to a patch after verification.
 *
 * The patch checks are run again here, against the workflow, rather than
 * trusted from the generator's result. A decision is therefore never
 * better than what the code can see for itself, whatever the caller
 * passed in.
 */
export function decidePatch(input: DecidePatchInput): PatchDecision {
  const policy = input.policy ?? DEFAULT_ACCEPTANCE_POLICY;
  if (policy.mode === 'auto') {
    if (!(policy.minScore >= CONFIDENCE_HIGH && policy.minScore <= 1)) {
      throw new RangeError(
        `Automatic acceptance needs a minScore from ${CONFIDENCE_HIGH} to 1, not ${policy.minScore}.`,
      );
    }
  }

  const { verification } = input;
  const patch = verification.patch;

  const verdict = checkPatch(patch, input.workflow, input.patchClass);
  if (verdict.status === 'rejected') {
    return {
      status: 'rejected',
      patch,
      violations: verdict.violations,
      message: 'The patch breaks a rule, so it cannot be accepted whatever verification showed.',
    };
  }
  if (verification.status !== 'verified') {
    return {
      status: 'rejected',
      patch,
      verification,
      message:
        verification.status === 'not_applied'
          ? 'The patch does not apply to the workflow.'
          : `The patch did not verify: ${verification.failures.map((f) => f.code).join(', ')}.`,
    };
  }

  const approvals = verdict.status === 'needs_approval' ? verdict.approvals : [];
  const reasons: ApprovalReason[] = [];
  if (policy.mode === 'human') {
    reasons.push({
      code: 'policy_requires_review',
      message: 'Every patch is reviewed by a person under the current policy.',
    });
  } else if (input.score.score < policy.minScore) {
    reasons.push({
      code: 'score_below_threshold',
      message: `The patch scored ${input.score.score}, below the ${policy.minScore} needed to accept it without review.`,
    });
  }
  if (approvals.length > 0) {
    reasons.push({
      code: 'checks_require_review',
      message: `The patch checks listed ${approvals.length} point(s) a person must confirm.`,
    });
  }
  if (input.reversions !== undefined && input.reversions.length > 0) {
    reasons.push({
      code: 'reverts_earlier_heal',
      message: `The patch undoes ${input.reversions.length === 1 ? 'an earlier heal' : `${input.reversions.length} earlier heals`}: ${input.reversions.map((r) => r.message).join(' ')} The site may be switching between versions.`,
    });
  }
  if (input.patchClass === 'insert_step') {
    reasons.push({
      code: 'insert_step',
      message:
        'A patch that adds a step is always reviewed: nothing limits what an inserted click may press.',
    });
  }
  if (verification.stepRan !== 'confirmed') {
    reasons.push({
      code: 'step_not_confirmed',
      message: 'Verification did not confirm that the patched step ran.',
    });
  }

  const common = {
    patch,
    score: input.score,
    workflow: verification.workflow,
    hash: verification.hash,
    report: verification.report,
  };
  if (reasons.length > 0) return { status: 'awaiting_approval', ...common, reasons, approvals };
  return { status: 'accepted', ...common, acceptedBy: { kind: 'policy' } };
}

export interface ApprovePatchInput {
  /** A decision with status `awaiting_approval`. */
  decision: PatchDecision;
  /**
   * The workflow as it is now, where the patch would be stored. Approval
   * may come long after verification; if the workflow has changed since,
   * the patch is stale and is not accepted.
   */
  current: Workflow;
  /** Who approved it. Recorded on the accepted decision. */
  reviewer: string;
  /** When. Default now. */
  at?: Date;
}

export type ApprovePatchResult =
  | { status: 'accepted'; decision: Extract<PatchDecision, { status: 'accepted' }> }
  | {
      status: 'refused';
      code: 'not_awaiting_approval' | 'stale' | 'no_reviewer';
      message: string;
    };

/**
 * Record a person's approval of a verified patch.
 *
 * This is the only way a patch that needed review becomes accepted. It
 * does not re-run verification, so approve soon after the decision; the
 * staleness check catches a workflow that changed in the meantime, not a
 * site that did.
 */
export function approvePatch(input: ApprovePatchInput): ApprovePatchResult {
  const { decision } = input;
  if (decision.status !== 'awaiting_approval') {
    return {
      status: 'refused',
      code: 'not_awaiting_approval',
      message: `Only a patch awaiting approval can be approved; this one is ${decision.status}.`,
    };
  }
  const reviewer = input.reviewer.trim();
  if (reviewer === '') {
    return {
      status: 'refused',
      code: 'no_reviewer',
      message: 'An approval must name the reviewer.',
    };
  }
  if (hashWorkflow(input.current) !== decision.patch.baseHash) {
    return {
      status: 'refused',
      code: 'stale',
      message: 'The workflow has changed since this patch was verified. Heal it again.',
    };
  }
  // The decision is a plain object the caller held while waiting; make
  // sure the workflow on it is still the patch applied to `current`.
  const reapplied = applyPatch(input.current, decision.patch);
  if (
    !reapplied.ok ||
    reapplied.hash !== decision.hash ||
    !same(reapplied.workflow, decision.workflow)
  ) {
    return {
      status: 'refused',
      code: 'stale',
      message:
        'The patched workflow on this decision does not match the patch applied to the current workflow.',
    };
  }

  return {
    status: 'accepted',
    decision: {
      status: 'accepted',
      patch: decision.patch,
      score: decision.score,
      workflow: reapplied.workflow,
      hash: reapplied.hash,
      report: decision.report,
      acceptedBy: {
        kind: 'reviewer',
        reviewer,
        at: (input.at ?? new Date()).toISOString(),
      },
    },
  };
}
