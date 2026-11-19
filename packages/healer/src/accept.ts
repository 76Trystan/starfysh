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
//    One exception: a site change that broke several steps. A correct
//    patch for the first can never pass, because the next broken step
//    still fails. Such a patch `progressed` when every run passes the
//    patched step and then fails at the same later step, with the outputs
//    so far matching the start of the known-good ones. A progressed patch
//    is always held for a person (`partial_heal`), and the next heal
//    picks up from the patched workflow.
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
import {
  checkEnvelope,
  compareOutputs,
  createInterpreter,
  ENVELOPE_HISTORY_RUNS,
  replay,
} from '@sfysh/verifier';
import type {
  DriftField,
  EnvelopeDeviation,
  EnvelopeResult,
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
  /**
   * Outputs of the last passing runs, oldest first, the latest usually
   * equal to `outputs` (at most `ENVELOPE_HISTORY_RUNS` are used). Every
   * verification run is checked against what they had in common
   * (`checkEnvelope`); a patch whose runs fall outside it is held for a
   * person as a possible false heal. Exact match against `outputs` stays
   * the acceptance rule. Absent: the envelope check is skipped.
   */
  history?: unknown[][];
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
   * Runs the workflow. Default: the IR interpreter, with the patched (or
   * inserted) step on its first candidate only and every other step
   * falling through its candidates as in production. It also confirms the
   * patched step ran (see `stepRan`). A custom runner skips that
   * confirmation, and a patch verified with one never `progressed`.
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
      /**
       * Every run passed the patched step, then failed at the same later
       * step (`failedStepId`), with the outputs emitted so far matching
       * the start of the known-good outputs. The patch moved the workflow
       * on but cannot show it reaches the end: another step is broken too.
       * `decidePatch` always holds it for a person.
       */
      status: 'progressed';
      patch: StepPatch;
      workflow: Workflow;
      hash: string;
      report: VerifyReport;
      stepRan: 'confirmed';
      /** The step every run failed at, after the patched one. */
      failedStepId: string;
      /** How many known-good outputs the runs reproduced before failing. */
      outputsMatched: number;
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
      /**
       * How the runs' outputs compare with the known-good history
       * (ADR 0004). `outside` holds the patch for a person as a possible
       * false heal. Absent when no history was given.
       */
      envelope?: EnvelopeResult;
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
  // Every step that passed, per run, for telling progress from no change.
  const passedPerRun: Set<string>[] = [];
  let calls = 0;
  const runner: RunnerFn =
    input.runner ??
    (async (ctx, workflow) => {
      const index = calls++;
      let ran = false;
      const passed = new Set<string>();
      passedPerRun[index] = passed;
      const interpreter = createInterpreter({
        candidates: 'fallthrough',
        ...(watchedId !== undefined ? { primaryOnly: [watchedId] } : {}),
        ...(input.params !== undefined ? { params: input.params } : {}),
        onStep: (trace) => {
          if (trace.status === 'ok') passed.add(trace.stepId);
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

  if (failures.length > 0) {
    const progress =
      input.runner === undefined && watchedId !== undefined
        ? progressOf(
            report,
            passedPerRun,
            [watchedId, input.patch.stepId],
            input.knownGood,
            input.tolerance,
          )
        : undefined;
    if (progress !== undefined) {
      return {
        status: 'progressed',
        patch: input.patch,
        workflow: patched,
        hash: applied.hash,
        report,
        stepRan: 'confirmed',
        ...progress,
      };
    }
    return { status: 'failed', patch: input.patch, failures, report };
  }
  const envelope =
    input.knownGood.history !== undefined
      ? envelopeOf(input.knownGood.history, report, input.tolerance)
      : undefined;
  return {
    status: 'verified',
    patch: input.patch,
    workflow: patched,
    hash: applied.hash,
    report,
    stepRan: input.runner === undefined ? 'confirmed' : 'unchecked',
    ...(envelope !== undefined ? { envelope } : {}),
  };
}

/**
 * Whether failed runs still show the patch worked: in every run the
 * patched step passed (and, for an inserted step, the step it was inserted
 * before), then the run failed at one and the same other step;
 * the runs' outputs agree with each other; and they match the start of
 * the known-good outputs. Undefined when any of that does not hold.
 */
function progressOf(
  report: VerifyReport,
  passedPerRun: readonly Set<string>[],
  mustPass: readonly string[],
  knownGood: KnownGood,
  tolerance: ToleranceMap | undefined,
): { failedStepId: string; outputsMatched: number } | undefined {
  const failedAt = new Set<string>();
  for (const [index, outcome] of report.replays.entries()) {
    const stepId = outcome.error?.stepId;
    if (outcome.status === 'ok' || stepId === undefined || mustPass.includes(stepId)) {
      return undefined;
    }
    // The patched step passed before the run failed, so the failure is
    // further on. An inserted step that passed while the step it was meant
    // to clear still fails is no progress at all.
    const passed = passedPerRun[index];
    if (passed === undefined || !mustPass.every((id) => passed.has(id))) return undefined;
    failedAt.add(stepId);
  }
  const [failedStepId] = failedAt;
  if (failedAt.size !== 1 || failedStepId === undefined) return undefined;

  const outputs = report.replays.map((r) => r.outputs);
  if (!compareOutputs(outputs, tolerance).stable) return undefined;
  const emitted = outputs[0]!.length;
  if (emitted > knownGood.outputs.length) return undefined;
  const expected = knownGood.outputs.slice(0, emitted);
  if (!compareOutputs([expected, outputs[0]!], tolerance).stable) return undefined;
  return { failedStepId, outputsMatched: emitted };
}

/**
 * Check every run's outputs against the known-good history and merge the
 * results: one deviation per field and check, whichever run showed it.
 */
function envelopeOf(
  history: unknown[][],
  report: VerifyReport,
  tolerance: ToleranceMap | undefined,
): EnvelopeResult {
  const recent = history.slice(-ENVELOPE_HISTORY_RUNS);
  const results = report.replays.map((r) => checkEnvelope(recent, r.outputs, tolerance));
  const first = results[0];
  if (first === undefined || first.status === 'insufficient_history') {
    return { status: 'insufficient_history', runs: recent.length };
  }
  const deviations = new Map<string, EnvelopeDeviation>();
  for (const result of results) {
    if (result.status !== 'outside') continue;
    for (const d of result.deviations) deviations.set(`${d.path}\u0000${d.check}`, d);
  }
  return deviations.size === 0
    ? { status: 'within', runs: recent.length }
    : { status: 'outside', runs: recent.length, deviations: [...deviations.values()] };
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
 *
 * `auto_promotion` accepts a verified `promotion` patch (a fallback
 * candidate moved to the front, built in code, see `promotionPatch`)
 * without a person, and treats every other class as `human` does. A
 * promotion only reorders candidates a person wrote, one of which has
 * just worked on the live site, so it is the lowest-risk change the
 * healer makes. Every other hold still applies: reversions, approvals the
 * checks asked for, and an unconfirmed step run.
 */
export type AcceptancePolicy =
  { mode: 'human' } | { mode: 'auto'; minScore: number } | { mode: 'auto_promotion' };

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
  /**
   * The patch moved the workflow past the broken step, but another step
   * further on is broken too (`progressed`), so no run reached the end.
   * Always reviewed: the evidence is the start of the run, not all of it.
   */
  | 'partial_heal'
  /** Verification used a custom runner, so it did not confirm the patched step ran. */
  | 'step_not_confirmed'
  /**
   * The patched runs matched the known-good outputs, but fall outside what
   * the last passing runs had in common (ADR 0004): it may be reading the
   * wrong element.
   */
  | 'possibly_false_heal';

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
  if (verification.status !== 'verified' && verification.status !== 'progressed') {
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
  } else if (policy.mode === 'auto_promotion') {
    if (input.patchClass !== 'promotion') {
      reasons.push({
        code: 'policy_requires_review',
        message:
          'Only promotions of a working fallback selector are accepted without review under the current policy.',
      });
    }
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
  if (verification.status === 'progressed') {
    reasons.push({
      code: 'partial_heal',
      message: `Partial heal: the patched step now works, but every verification run then failed at step ${verification.failedStepId}, so another step is broken too. The outputs matched the first ${verification.outputsMatched} known-good output(s). Approve it and heal again to continue.`,
    });
  }
  if (verification.status === 'verified' && verification.envelope?.status === 'outside') {
    const fields = [...new Set(verification.envelope.deviations.map((d) => d.path))];
    reasons.push({
      code: 'possibly_false_heal',
      message: `Possible false heal: the patched workflow's outputs differ in kind from the last ${verification.envelope.runs} passing runs (${fields.join(', ')}). It may be reading the wrong element.`,
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
