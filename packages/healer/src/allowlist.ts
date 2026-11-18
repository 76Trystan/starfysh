// Allowlist by patch class: the narrow rule for each kind of heal.
//
// `checkPatchScope` is the general rule for every patch. It still leaves a
// replacement free to reword the intent, add conditions, change a timeout
// or change what happens on failure. A heal that was asked for new
// selectors has no reason to touch any of those, and each one is a way for
// a patch to do more than the reviewer expects.
//
// The class is chosen by the code that asked the model for the patch. It
// is never read from the model's answer.

import { findStep } from '@sfysh/ir';
import type { StepPatch, Workflow } from '@sfysh/ir';
import { canonical, pointer, same } from './equal.js';

/**
 * The kind of heal a patch was requested as.
 *
 * - `selector`: the element moved or was renamed. The patch replaces the
 *   failed step and may change `target.candidates`, nothing else.
 * - `insert_step`: something new stands in the way (a banner, a slow
 *   panel). The patch inserts one `click` or `wait` next to the failed
 *   step.
 * - `promotion`: a step passed on a fallback candidate. The patch moves
 *   that candidate to the front. It reorders `target.candidates` and
 *   changes nothing else, not even which candidates there are. No model
 *   writes it (`promotionPatch`).
 */
export type PatchClass = 'selector' | 'insert_step' | 'promotion';

/** The classes a model is asked for. A promotion is built in code. */
export type ModelPatchClass = Exclude<PatchClass, 'promotion'>;

export type AllowlistViolationCode =
  /** The patch operation does not belong to the class. */
  | 'wrong_op'
  /** The step the patch is anchored to is not in the workflow. */
  | 'unknown_step'
  /** A selector patch for a step that has no target. */
  | 'no_target'
  /** A selector patch changed, added or removed a field other than `target`. */
  | 'field_not_allowed'
  /** A selector patch left the candidates as they were. */
  | 'no_change'
  /** A promotion added, removed or edited a candidate instead of only reordering them. */
  | 'not_a_reorder'
  /** An inserted step has an action the class does not allow. */
  | 'action_not_allowed'
  /** An inserted wait pauses for a fixed time instead of waiting for a condition. */
  | 'fixed_wait'
  /** An inserted step sets a timeout above `INSERTED_STEP_MAX_TIMEOUT_MS`. */
  | 'timeout_too_long';

export interface AllowlistViolation {
  code: AllowlistViolationCode;
  /** JSON Pointer within the patch, for example `/after/intent`. */
  path: string;
  /** What is wrong, for logs and for the reviewer. Does not quote patch content. */
  message: string;
}

export type AllowlistResult = { ok: true } | { ok: false; violations: AllowlistViolation[] };

/** Longest `timeoutMs` an inserted step may set, in milliseconds. */
export const INSERTED_STEP_MAX_TIMEOUT_MS = 60_000;

/** The actions an `insert_step` patch may add. */
export const INSERTABLE_ACTIONS: readonly string[] = ['click', 'wait'];

type Loose = Record<string, unknown>;

/**
 * Check a patch against the allowlist for its class.
 *
 * A `selector` patch must be a `replace` of a step that has a `target`,
 * and the new step must equal the step in the workflow in every field
 * except `target`. The comparison is against the workflow, not against the
 * patch's own `before`, so a patch cannot widen what it may change by
 * misreporting the step it replaces. A patch that leaves the candidates as
 * they were is rejected too: verifying it would spend replays on nothing.
 *
 * An `insert_step` patch must be an `insert_before` or `insert_after`, and
 * the new step must be a `click` or a `wait`. A wait must be for a
 * condition, with no fixed pause, and neither kind may set a timeout above
 * one minute. A `fill` would put a value
 * into a form the workflow's author never saw, and a `navigate` would take
 * the run somewhere else.
 *
 * This check narrows `checkPatchScope`; it does not replace it. Run both.
 * Every violation is reported, not only the first.
 */
export function checkPatchClass(
  patch: StepPatch,
  workflow: Workflow,
  patchClass: PatchClass,
): AllowlistResult {
  const violations: AllowlistViolation[] = [];
  const add = (code: AllowlistViolationCode, path: string, message: string) =>
    violations.push({ code, path, message });
  const after = patch.after as unknown as Loose;

  if (patchClass === 'selector' || patchClass === 'promotion') {
    const kind = patchClass === 'selector' ? 'A selector patch' : 'A promotion';
    if (patch.op !== 'replace') {
      add('wrong_op', '/op', `${kind} must replace the step.`);
      return { ok: false, violations };
    }
    const current = findStep(workflow, patch.stepId)?.step as unknown as Loose | undefined;
    if (current === undefined) {
      add('unknown_step', '/stepId', 'The step the patch is anchored to is not in the workflow.');
      return { ok: false, violations };
    }
    if (current.target === undefined) {
      add('no_target', '/stepId', 'The step has no target, so there is no selector to change.');
      return { ok: false, violations };
    }

    const keys = new Set([...Object.keys(current), ...Object.keys(after)]);
    for (const key of [...keys].sort()) {
      if (key !== 'target' && !same(current[key], after[key])) {
        add(
          'field_not_allowed',
          `/after/${pointer(key)}`,
          `${kind} may change the target candidates and nothing else.`,
        );
      }
    }
    if (same(current.target, after.target)) {
      add('no_change', '/after/target', 'The patch leaves the target candidates as they were.');
    } else if (patchClass === 'promotion') {
      const before = current.target as Loose;
      const next = after.target as Loose | undefined;
      const others = (t: Loose | undefined) => {
        const { candidates: _candidates, ...rest } = t ?? {};
        return rest;
      };
      if (
        next === undefined ||
        !same(others(before), others(next)) ||
        !sameMultiset(before.candidates, next.candidates)
      ) {
        add(
          'not_a_reorder',
          '/after/target',
          'A promotion may only reorder the existing candidates, not add, remove or edit any.',
        );
      }
    }
  } else {
    if (patch.op === 'replace') {
      add('wrong_op', '/op', 'An insert-step patch must insert a step, not replace one.');
      return { ok: false, violations };
    }
    if (typeof after.action !== 'string' || !INSERTABLE_ACTIONS.includes(after.action)) {
      add('action_not_allowed', '/after/action', 'An inserted step must be a click or a wait.');
    }
    if (after.action === 'wait') {
      // A fixed pause is how a heal would paper over a page it does not
      // understand, and it slows every later run by that much.
      if (after.millis !== undefined) {
        add('fixed_wait', '/after/millis', 'An inserted wait must not pause for a fixed time.');
      }
      if (after.forCondition === undefined) {
        add('fixed_wait', '/after/forCondition', 'An inserted wait must wait for a condition.');
      }
    }
    if (typeof after.timeoutMs === 'number' && after.timeoutMs > INSERTED_STEP_MAX_TIMEOUT_MS) {
      add(
        'timeout_too_long',
        '/after/timeoutMs',
        `An inserted step may set a timeout of at most ${INSERTED_STEP_MAX_TIMEOUT_MS} ms.`,
      );
    }
  }

  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

/** Whether two arrays hold the same JSON values the same number of times, in any order. */
function sameMultiset(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const key = (v: unknown) => canonical(v);
  const left = a.map(key).sort();
  const right = b.map(key).sort();
  return left.every((k, i) => k === right[i]);
}
