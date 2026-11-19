// Oracle heals: a hand-written correct heal for each healable drift case.
//
// An oracle does two jobs. It proves the case is solvable within
// Starfysh's own rules: every oracle patch is built as a real `StepPatch`
// and passed through the healer's `checkPatch` for its class, and the
// patched workflow must then be judged correct on the drifted page. And it
// is the reference answer a model's heal can be compared with.
//
// A case can need several heals in sequence (a banner, then a moved link,
// then a renamed button). The oracle lists them in the order a healer
// would meet them; each is applied to the workflow the previous one
// produced, exactly as successive heals would be.

import { applyPatch, findStep, hashWorkflow } from '@sfysh/ir';
import type { Condition, SelectorCandidate, Step, StepPatch, Workflow } from '@sfysh/ir';
import { checkPatch } from '@sfysh/healer';
import type { PatchClass } from '@sfysh/healer';

export type OraclePatch =
  /** New ranked candidates for a step (a `selector` heal). */
  | { kind: 'reselect'; stepId: string; candidates: SelectorCandidate[] }
  /** Move the candidate at `index` to the front (a `promotion`). */
  | { kind: 'promote'; stepId: string; index: number }
  /** A click inserted before a step (an `insert_step` heal). */
  | { kind: 'insert_click'; beforeStepId: string; target: SelectorCandidate; intent: string }
  /** A wait for a condition inserted before a step (an `insert_step` heal). */
  | { kind: 'insert_wait'; beforeStepId: string; until: Condition; intent: string };

/** The patch class each oracle kind is checked as. */
export function classOf(patch: OraclePatch): PatchClass {
  return patch.kind === 'reselect'
    ? 'selector'
    : patch.kind === 'promote'
      ? 'promotion'
      : 'insert_step';
}

export interface AppliedOracle {
  /** The workflow with every oracle patch applied. */
  workflow: Workflow;
  /** Each patch as built, with its class, in order. */
  patches: { patch: StepPatch; patchClass: PatchClass }[];
}

/**
 * Apply an oracle to a workflow, one heal at a time. Throws if a patch does
 * not apply, or if the healer's own checks would refuse it: an oracle that
 * breaks Starfysh's rules does not prove the case is healable.
 */
export function applyOracle(workflow: Workflow, oracle: readonly OraclePatch[]): AppliedOracle {
  let current = workflow;
  const patches: AppliedOracle['patches'] = [];
  let inserted = 0;

  for (const o of oracle) {
    const patch = buildPatch(current, o, () => `healed_${String(++inserted).padStart(3, '0')}`);
    const patchClass = classOf(o);
    const verdict = checkPatch(patch, current, patchClass);
    if (verdict.status === 'rejected') {
      throw new Error(
        `oracle ${o.kind} for ${'stepId' in o ? o.stepId : o.beforeStepId} breaks the healer's rules: ${verdict.violations.map((v) => v.code).join(', ')}`,
      );
    }
    const applied = applyPatch(current, patch);
    if (!applied.ok) {
      throw new Error(`oracle patch does not apply: ${JSON.stringify(applied.errors[0])}`);
    }
    patches.push({ patch, patchClass });
    current = applied.workflow;
  }
  return { workflow: current, patches };
}

/**
 * Build one oracle patch as a real `StepPatch` against `workflow`. An
 * inserted step takes its id from `nextId`.
 */
export function buildPatch(workflow: Workflow, o: OraclePatch, nextId: () => string): StepPatch {
  const base = { workflowId: workflow.id, baseHash: hashWorkflow(workflow) };
  if (o.kind === 'insert_click' || o.kind === 'insert_wait') {
    const after =
      o.kind === 'insert_click'
        ? { id: nextId(), intent: o.intent, action: 'click', target: { candidates: [o.target] } }
        : { id: nextId(), intent: o.intent, action: 'wait', forCondition: o.until };
    return {
      ...base,
      stepId: o.beforeStepId,
      op: 'insert_before',
      after: after as unknown as Step,
      rationale: 'Oracle heal.',
    };
  }

  const before = findStep(workflow, o.stepId)?.step;
  if (before === undefined) throw new Error(`oracle names a step that is not there: ${o.stepId}`);
  const target = (before as unknown as { target: { candidates: SelectorCandidate[] } }).target;
  const candidates =
    o.kind === 'reselect'
      ? o.candidates
      : [target.candidates[o.index]!, ...target.candidates.filter((_, i) => i !== o.index)];
  return {
    ...base,
    stepId: o.stepId,
    op: 'replace',
    before,
    after: { ...before, target: { ...target, candidates } } as unknown as Step,
    rationale: 'Oracle heal.',
  };
}
