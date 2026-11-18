// Promotion: turn a degraded run into a heal, without a model.
//
// A run that passes on a fallback selector candidate (`ReplayOutcome
// .degraded`) is green, but its primary selector is broken and the next
// change to that element may take the fallback with it. The IR already
// holds the fix: move the candidate that worked to the front. This module
// builds that patch in code, verifies it like any other patch (live runs,
// primary candidate only, held to the known-good outputs), checks it
// against earlier heals, and decides on it.
//
// Nothing here calls a model, so the triage-before-model rule holds
// trivially, the token caps do not apply, and promotions do not count
// against the daily heal cap, which exists to bound model spend. The
// reversion check does apply: a site that flips between two designs would
// otherwise have its candidates swapped back and forth.

import { findStep, hashWorkflow } from '@sfysh/ir';
import type { SelectorCandidate, Step, StepPatch, Workflow } from '@sfysh/ir';
import type { DegradedStep } from '@sfysh/runtime';
import type { PageFactory } from '@sfysh/verifier';
import { decidePatch, verifyPatch } from './accept.js';
import type { AcceptancePolicy, KnownGood, PatchDecision, PatchVerification } from './accept.js';
import { checkPatch } from './check.js';
import type { HealVerifyOptions } from './heal.js';
import type { HealHistory } from './limits.js';
import { findReversions, patchRecord } from './revert.js';
import type { Reversion } from './revert.js';
import type { PatchScore } from './score.js';

/**
 * The score every promotion carries. It is not computed from a snapshot,
 * because a passing run has none; the evidence is that the candidate
 * worked on the live site, and verification then shows it works first.
 * Fixed rather than calibrated, and above `CONFIDENCE_HIGH`, so an `auto`
 * policy treats it as the strong case it is.
 */
export const PROMOTION_SCORE = 0.9;

export type PromotionSkipReason =
  /** The step named in the degraded record is not in the workflow, or has no target. */
  | 'unknown_step'
  /** The candidate at the recorded index is not the one the run used. The workflow changed, or the selector was redacted. */
  | 'candidate_mismatch'
  /** The step degraded onto different candidates in one run (a loop over items). No single order fits. */
  | 'inconsistent'
  /** The built patch broke a rule. Should not happen; reported rather than assumed. */
  | 'rejected';

export interface PromotionSkip {
  stepId: string;
  reason: PromotionSkipReason;
  message: string;
}

export type PromotionPatchResult =
  | {
      status: 'patch';
      patch: StepPatch;
      score: PatchScore;
      /** The degraded record the patch promotes. */
      degraded: DegradedStep;
      /** Steps passed over before this one, and why. */
      skipped: PromotionSkip[];
      /** Degraded steps after this one, for a later promotion once this one is applied. */
      remaining: DegradedStep[];
    }
  | { status: 'none'; skipped: PromotionSkip[] };

/**
 * Build the promotion for the first degraded step that can be promoted.
 * One step per patch, as for every heal: a second promotion is built from
 * the workflow after the first is applied, since the base hash changes.
 */
export function promotionPatch(
  workflow: Workflow,
  degraded: readonly DegradedStep[],
): PromotionPatchResult {
  const skipped: PromotionSkip[] = [];
  const order = [...new Set(degraded.map((d) => d.stepId))];

  for (const [position, stepId] of order.entries()) {
    const entries = degraded.filter((d) => d.stepId === stepId);
    const skip = (reason: PromotionSkipReason, message: string) =>
      skipped.push({ stepId, reason, message });

    if (new Set(entries.map((d) => d.candidateIndex)).size > 1) {
      skip('inconsistent', `Step ${stepId} passed on different candidates within one run.`);
      continue;
    }
    const entry = entries[0]!;
    const step = findStep(workflow, stepId)?.step as unknown as
      (Step & { target?: { candidates: SelectorCandidate[] } }) | undefined;
    const candidates = step?.target?.candidates;
    if (step === undefined || candidates === undefined) {
      skip('unknown_step', `Step ${stepId} is not in the workflow, or has no target.`);
      continue;
    }
    const used = candidates[entry.candidateIndex];
    if (
      entry.candidateIndex < 1 ||
      used === undefined ||
      used.kind !== entry.selector.kind ||
      used.value !== entry.selector.value
    ) {
      skip(
        'candidate_mismatch',
        `Candidate #${entry.candidateIndex + 1} of step ${stepId} is not the one the run used.`,
      );
      continue;
    }

    const reordered = [used, ...candidates.filter((_, i) => i !== entry.candidateIndex)];
    const patch: StepPatch = {
      workflowId: workflow.id,
      baseHash: hashWorkflow(workflow),
      stepId,
      op: 'replace',
      before: step,
      after: { ...step, target: { ...step.target, candidates: reordered } } as unknown as Step,
      rationale: `The primary selector failed and candidate #${entry.candidateIndex + 1} (${used.kind}) worked on the live site, so it is moved to the front. No model wrote this change.`,
      confidence: PROMOTION_SCORE,
    };
    const verdict = checkPatch(patch, workflow, 'promotion');
    if (verdict.status === 'rejected') {
      skip(
        'rejected',
        `The promotion of step ${stepId} broke a rule (${verdict.violations.map((v) => v.code).join(', ')}).`,
      );
      continue;
    }

    const laterSteps = new Set(order.slice(position + 1));
    return {
      status: 'patch',
      patch,
      score: {
        score: PROMOTION_SCORE,
        level: 'high',
        signals: [
          {
            code: 'worked_live',
            effect: PROMOTION_SCORE,
            detail:
              'The candidate worked on the live site in the run that degraded, and no model wrote the patch.',
          },
        ],
      },
      degraded: entry,
      skipped,
      remaining: degraded.filter((d) => laterSteps.has(d.stepId)),
    };
  }

  return { status: 'none', skipped };
}

export interface PromoteInput {
  /** The workflow whose run degraded. */
  workflow: Workflow;
  /** `ReplayOutcome.degraded` from that run. */
  degraded: readonly DegradedStep[];
  /** Outputs every verification run must reproduce. Usually the degraded run's own outputs. */
  knownGood: KnownGood;
  /** A fresh live page per verification run. */
  pageFactory: PageFactory;
  /** Patch records, for the reversion check. The daily cap is not consulted. */
  history: HealHistory;
  verify?: HealVerifyOptions;
  /** Default `{ mode: 'human' }`. `{ mode: 'auto_promotion' }` accepts a verified promotion without a person. */
  policy?: AcceptancePolicy;
  now?: () => Date;
}

/** One promotion and what became of it. */
export interface PromotionAttempt {
  degraded: DegradedStep;
  patch: StepPatch;
  score: PatchScore;
  verification: PatchVerification;
  decision?: PatchDecision;
  reversions?: Reversion[];
}

export type PromoteResult =
  | {
      /** Nothing could be promoted. Every degraded step is in `skipped`. */
      status: 'none';
      skipped: PromotionSkip[];
    }
  | {
      /** The promotion did not verify, or the checks refused it. The workflow keeps running on its fallback. */
      status: 'not_promoted';
      attempt: PromotionAttempt;
      skipped: PromotionSkip[];
    }
  | {
      /** The promotion verified. It is accepted, or waiting for a person. */
      status: 'decided';
      decision: Extract<PatchDecision, { status: 'accepted' | 'awaiting_approval' }>;
      attempt: PromotionAttempt;
      skipped: PromotionSkip[];
      /** Degraded steps not handled by this promotion. Run again after applying it. */
      remaining: DegradedStep[];
    };

/**
 * Promote the first promotable degraded step: build the patch, verify it
 * live with the primary candidate only, check it against earlier heals,
 * and decide. Never calls a model.
 */
export async function promote(input: PromoteInput): Promise<PromoteResult> {
  const now = input.now ?? (() => new Date());
  const built = promotionPatch(input.workflow, input.degraded);
  if (built.status === 'none') return { status: 'none', skipped: built.skipped };

  const verification = await verifyPatch({
    ...input.verify,
    workflow: input.workflow,
    patch: built.patch,
    knownGood: input.knownGood,
    pageFactory: input.pageFactory,
  });
  const attempt: PromotionAttempt = {
    degraded: built.degraded,
    patch: built.patch,
    score: built.score,
    verification,
  };
  if (verification.status !== 'verified') {
    return { status: 'not_promoted', attempt, skipped: built.skipped };
  }

  const reversions = findReversions(
    built.patch,
    input.workflow,
    await input.history.patches(input.workflow.id),
  );
  if (reversions.length > 0) attempt.reversions = reversions;
  const decision = decidePatch({
    workflow: input.workflow,
    patchClass: 'promotion',
    score: built.score,
    verification,
    reversions,
    ...(input.policy !== undefined ? { policy: input.policy } : {}),
  });
  attempt.decision = decision;
  if (decision.status === 'rejected') {
    return { status: 'not_promoted', attempt, skipped: built.skipped };
  }

  const record = patchRecord(input.workflow, built.patch, decision.status, now());
  if (record !== undefined) await input.history.recordPatch(record);
  return {
    status: 'decided',
    decision,
    attempt,
    skipped: built.skipped,
    remaining: built.remaining,
  };
}
