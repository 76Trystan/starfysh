// Oscillation: a heal that undoes an earlier heal.
//
// `applyPatch` already refuses a patch whose base hash is not the
// workflow's, so the same patch cannot be applied twice. What it cannot
// see is a new patch that takes the workflow back to where an earlier heal
// moved it from. On a site that flips between two designs (an A/B test, a
// staged rollout, a rollback) the healer would otherwise switch the
// workflow back and forth for ever, each heal verifying, each one costing
// a model call and a review.
//
// Every heal that reaches a decision is recorded with the state it started
// from. A new patch is checked against those records. The states a heal
// started from are states the workflow really was in, so returning to one
// is a reversion whether or not the earlier patch was ever accepted.
//
// A reversion is not a rejection. The site may really have gone back, and
// the patch may be right. It is a reason a person must look, which
// `decidePatch` enforces whatever the acceptance policy says.

import { applyPatch, findStep, hashStep } from '@sfysh/ir';
import type { SelectorCandidate, StepPatch, Workflow } from '@sfysh/ir';
import { same } from './equal.js';

/** One heal that reached a decision. Written by `heal()`, read back for later heals of the same workflow. */
export interface PatchRecord {
  workflowId: string;
  /** When the decision was made. */
  at: Date;
  /** The step the patch was anchored to. */
  stepId: string;
  op: StepPatch['op'];
  /** `hashWorkflow` of the workflow the heal started from. */
  fromHash: string;
  /** `hashWorkflow` of the patched workflow. */
  toHash: string;
  /** For a `replace`: `hashStep` of the step before the patch. */
  stepBefore?: string;
  /** For a `replace` of a step with a target: its first candidate before the patch. */
  firstCandidateBefore?: SelectorCandidate;
  /** What the heal decided. */
  decision: 'accepted' | 'awaiting_approval';
}

export type ReversionCode =
  /** The patched workflow is identical to one an earlier heal started from. */
  | 'workflow_revisited'
  /** The patched step is identical to the version an earlier heal replaced. */
  | 'step_reverted'
  /** The step's first selector goes back to one an earlier heal moved it away from. */
  | 'selector_reverted';

export interface Reversion {
  code: ReversionCode;
  /** When the heal being undone happened. */
  at: Date;
  message: string;
}

/** Build the record for a heal of `workflow` that decided on `patch`. Returns undefined if the patch does not apply. */
export function patchRecord(
  workflow: Workflow,
  patch: StepPatch,
  decision: PatchRecord['decision'],
  at: Date,
): PatchRecord | undefined {
  const applied = applyPatch(workflow, patch);
  if (!applied.ok) return undefined;
  const record: PatchRecord = {
    workflowId: workflow.id,
    at,
    stepId: patch.stepId,
    op: patch.op,
    fromHash: patch.baseHash,
    toHash: applied.hash,
    decision,
  };
  if (patch.op === 'replace') {
    const current = findStep(workflow, patch.stepId)?.step;
    if (current !== undefined) {
      record.stepBefore = hashStep(current);
      const first = firstCandidate(current);
      if (first !== undefined) record.firstCandidateBefore = first;
    }
  }
  return record;
}

/**
 * Every way `patch` undoes an earlier heal recorded in `history`. Empty
 * when it undoes nothing, or does not apply. Records for other workflows
 * are ignored.
 */
export function findReversions(
  patch: StepPatch,
  workflow: Workflow,
  history: readonly PatchRecord[],
): Reversion[] {
  const applied = applyPatch(workflow, patch);
  if (!applied.ok) return [];
  const records = history.filter((r) => r.workflowId === workflow.id);
  const found: Reversion[] = [];

  for (const r of records) {
    if (r.fromHash === applied.hash && r.fromHash !== patch.baseHash) {
      found.push({
        code: 'workflow_revisited',
        at: r.at,
        message: `The patched workflow is identical to the one a heal on ${r.at.toISOString()} started from.`,
      });
    }
  }

  if (patch.op === 'replace') {
    const afterHash = hashStep(patch.after);
    const current = findStep(workflow, patch.stepId)?.step;
    const currentFirst = current !== undefined ? firstCandidate(current) : undefined;
    const newFirst = firstCandidate(patch.after);
    for (const r of records) {
      if (r.stepId !== patch.stepId || r.op !== 'replace') continue;
      if (r.stepBefore !== undefined && r.stepBefore === afterHash) {
        found.push({
          code: 'step_reverted',
          at: r.at,
          message: `Step ${patch.stepId} goes back to the version a heal on ${r.at.toISOString()} replaced.`,
        });
      } else if (
        newFirst !== undefined &&
        r.firstCandidateBefore !== undefined &&
        same(newFirst, r.firstCandidateBefore) &&
        !same(newFirst, currentFirst)
      ) {
        // Reported only when the whole step is not already a revert, so
        // one undo is not listed twice.
        found.push({
          code: 'selector_reverted',
          at: r.at,
          message: `Step ${patch.stepId} goes back to the first selector a heal on ${r.at.toISOString()} moved it away from.`,
        });
      }
    }
  }

  return found;
}

function firstCandidate(step: unknown): SelectorCandidate | undefined {
  const target = (step as { target?: { candidates?: SelectorCandidate[] } }).target;
  return target?.candidates?.[0];
}
