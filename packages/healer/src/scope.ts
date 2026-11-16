// Patch scope: what a heal is allowed to change, enforced in code.
//
// A patch that reaches this file is well formed (`parseHealResponse` saw to
// that). Well formed is not the same as acceptable. A model that read a
// hostile page, or simply got it wrong, can write a valid step that drops
// the check that would have caught it, rewrites the steps nested inside a
// guard, or changes what the workflow outputs.
//
// `checkPatchScope` compares the step before and after and rejects any
// change outside what one heal may touch. It is the general rule for every
// patch; narrower limits for particular kinds of patch sit on top of it.
// Nothing here trusts the model's rationale or confidence, and nothing
// here applies the patch.

import { findStep, hashWorkflow } from '@sfysh/ir';
import type { StepPatch, Workflow } from '@sfysh/ir';
import { canonical, pointer, same } from './equal.js';

export type ScopeViolationCode =
  /** The patch is for a different workflow. */
  | 'wrong_workflow'
  /** The workflow has changed since the patch was written. */
  | 'stale_base'
  /** The step the patch is anchored to is not in the workflow. */
  | 'unknown_step'
  /** `before` is not the step that is in the workflow now. */
  | 'before_mismatch'
  /** A replacement changed the step's action. */
  | 'action_changed'
  /** The new step has a field that no step of its action has. */
  | 'unknown_field'
  /** A replacement changed the steps nested inside a guard or loop. */
  | 'nested_steps_changed'
  /** An inserted step carries nested steps of its own. */
  | 'nested_steps_added'
  /** A `post` condition was removed or altered. */
  | 'post_weakened'
  /** The condition of an `assert` step was altered. */
  | 'assertion_changed'
  /** The patch changes what the workflow outputs. */
  | 'outputs_changed'
  /** The patch changes which workflow parameters the step reads. */
  | 'parameters_changed';

export interface ScopeViolation {
  code: ScopeViolationCode;
  /** JSON Pointer within the patch, for example `/after/post`. */
  path: string;
  /** What is wrong, for logs and for the reviewer. Does not quote patch content. */
  message: string;
}

export type ScopeResult = { ok: true } | { ok: false; violations: ScopeViolation[] };

const COMMON_FIELDS = ['id', 'intent', 'action', 'pre', 'post', 'onFail', 'timeoutMs'];

/**
 * Every field a step of each action may carry. The step schema closes its
 * nested objects but not the step itself, so `validateStep` accepts a
 * field nothing reads. This table is what rejects one. A test compares it
 * with the schema so the two cannot drift apart.
 */
export const STEP_FIELDS: Readonly<Record<string, readonly string[]>> = {
  navigate: [...COMMON_FIELDS, 'url', 'waitUntil'],
  click: [...COMMON_FIELDS, 'target'],
  fill: [...COMMON_FIELDS, 'target', 'value'],
  extract: [...COMMON_FIELDS, 'target', 'schema', 'bind'],
  wait: [...COMMON_FIELDS, 'forCondition', 'millis'],
  assert: [...COMMON_FIELDS, 'condition'],
  guard: [...COMMON_FIELDS, 'if', 'then', 'else'],
  loop: [...COMMON_FIELDS, 'foreach', 'while', 'maxIterations', 'do'],
};

/** Fields that hold nested steps. */
const BODIES = ['then', 'else', 'do'] as const;

type Loose = Record<string, unknown>;

/**
 * Check that a patch stays inside what one heal may change.
 *
 * The patch must be for this workflow as it is now, and `before` must be
 * the step that is actually there; otherwise the comparison below would be
 * against a step that does not exist. Then, for a `replace`:
 *
 * - the action is unchanged;
 * - no field is added that a step of that action does not have;
 * - steps nested inside a guard or loop are untouched, so one heal changes
 *   one step and not a subtree;
 * - every `post` condition is still present, exactly as it was. Conditions
 *   may be added. An altered condition counts as a removed one: there is
 *   no way to tell in code whether the new wording is weaker;
 * - the condition of an `assert` step is unchanged, since for that step
 *   the condition is the check;
 * - an `extract` keeps its `bind` and `schema`, because those decide what
 *   the workflow outputs;
 * - the step reads the same workflow parameters as before.
 *
 * For an insert, the new step must not carry nested steps, must not be an
 * `extract` (it would add an output), must not read a workflow parameter,
 * and must not have a field its action does not have.
 *
 * Every violation is reported, not only the first.
 */
export function checkPatchScope(patch: StepPatch, workflow: Workflow): ScopeResult {
  const violations: ScopeViolation[] = [];
  const add = (code: ScopeViolationCode, path: string, message: string) =>
    violations.push({ code, path, message });

  if (patch.workflowId !== workflow.id) {
    add('wrong_workflow', '/workflowId', 'The patch is for a different workflow.');
    return { ok: false, violations };
  }
  if (patch.baseHash !== hashWorkflow(workflow)) {
    add('stale_base', '/baseHash', 'The workflow has changed since the patch was written.');
    return { ok: false, violations };
  }
  const current = findStep(workflow, patch.stepId)?.step;
  if (current === undefined) {
    add('unknown_step', '/stepId', 'The step the patch is anchored to is not in the workflow.');
    return { ok: false, violations };
  }

  const after = patch.after as unknown as Loose;

  if (patch.op === 'replace') {
    if (patch.before === undefined || !same(patch.before, current)) {
      add('before_mismatch', '/before', '"before" is not the step currently in the workflow.');
      return { ok: false, violations };
    }
    const before = current as unknown as Loose;

    if (after.action !== before.action) {
      add('action_changed', '/after/action', 'A replacement must keep the action of the step.');
    }

    for (const key of unknownFields(after)) {
      // A stray field that was already on the step is not this patch's doing.
      if (!(key in before)) {
        add(
          'unknown_field',
          `/after/${pointer(key)}`,
          'The step has a field its action does not have.',
        );
      }
    }

    for (const body of BODIES) {
      if (!same(before[body], after[body])) {
        add(
          'nested_steps_changed',
          `/after/${body}`,
          'A heal changes one step. The steps nested inside it must stay as they are.',
        );
      }
    }

    const kept = new Set(conditions(after.post).map(canonical));
    conditions(before.post).forEach((condition, index) => {
      if (!kept.has(canonical(condition))) {
        add(
          'post_weakened',
          `/before/post/${index}`,
          'A post condition was removed or altered. Conditions may be added, never dropped.',
        );
      }
    });

    if (before.action === 'assert' && !same(before.condition, after.condition)) {
      add(
        'assertion_changed',
        '/after/condition',
        'The condition of an assert step must not change.',
      );
    }

    if (before.action === 'extract') {
      if (!same(before.bind, after.bind)) {
        add(
          'outputs_changed',
          '/after/bind',
          'The name an extract binds its output to must not change.',
        );
      }
      if (!same(before.schema, after.schema)) {
        add('outputs_changed', '/after/schema', 'The schema of an extract must not change.');
      }
    }

    if (!same(parameterRefs(before), parameterRefs(after))) {
      add(
        'parameters_changed',
        '/after',
        'The step must read the same workflow parameters as before.',
      );
    }
  } else {
    for (const key of unknownFields(after)) {
      add(
        'unknown_field',
        `/after/${pointer(key)}`,
        'The step has a field its action does not have.',
      );
    }
    for (const body of BODIES) {
      if (after[body] !== undefined) {
        add(
          'nested_steps_added',
          `/after/${body}`,
          'An inserted step must be a single step, with no steps nested inside it.',
        );
      }
    }
    if (after.action === 'extract') {
      add('outputs_changed', '/after', 'An inserted extract would add an output to the workflow.');
    }
    if (parameterRefs(after).length > 0) {
      add('parameters_changed', '/after', 'An inserted step must not read a workflow parameter.');
    }
  }

  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

function unknownFields(step: Loose): string[] {
  const known = typeof step.action === 'string' ? STEP_FIELDS[step.action] : undefined;
  if (known === undefined) return [];
  return Object.keys(step).filter((key) => !known.includes(key));
}

function conditions(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Names of the workflow parameters a step reads, sorted. Nested steps are not included. */
function parameterRefs(step: Loose): string[] {
  const names: string[] = [];
  for (const field of ['url', 'value']) {
    const source = step[field];
    if (typeof source === 'object' && source !== null && 'param' in source) {
      names.push(`${field}:${String((source as { param: unknown }).param)}`);
    }
  }
  return names.sort();
}
