// Single-step patches: the unit of change a healer proposes and a person
// reviews.
//
// Everything here is pure. Workflows are never mutated; functions that
// change one return a new object. Steps are addressed by id through nested
// `guard` and `loop` bodies, which is why ids must be unique (validate.ts
// enforces that).

import { createHash } from 'node:crypto';
import type { Step, Workflow } from './types.js';
import {
  validatePatchShape,
  validateWorkflow,
  type ValidationError,
  type ValidationResult,
} from './validate.js';

/**
 * A proposed change to exactly one step. The shape is defined by
 * `schema/patch.schema.json`; this interface mirrors it by hand.
 */
export interface StepPatch {
  /** Id of the workflow this patch applies to. */
  workflowId: string;
  /** `hashWorkflow` of the workflow the patch was written against. */
  baseHash: string;
  /** The step the patch is anchored to. */
  stepId: string;
  /**
   * `replace` swaps the anchored step for `after`, keeping its id.
   * `insert_before` and `insert_after` add `after` next to the anchored step.
   */
  op: 'replace' | 'insert_before' | 'insert_after';
  /** The anchored step as it was. Required for `replace`. */
  before?: Step;
  /** The new step. */
  after: Step;
  /** Why the change is proposed, for the person reviewing it. */
  rationale: string;
  /** Author's confidence that the patch is correct, 0 to 1. */
  confidence?: number;
}

/** Where a step sits in a workflow. */
export interface StepLocation {
  step: Step;
  /** JSON Pointer to the step, for example `/steps/2/then/0`. */
  path: string;
  /** Ids of the steps that contain this one, outermost first. Empty at top level. */
  parents: string[];
}

type Nested = { id?: string; then?: Step[]; else?: Step[]; do?: Step[] };
const BODIES = ['then', 'else', 'do'] as const;

// ---------------------------------------------------------------------------
// Hashing

/**
 * A stable hash of what a workflow does. Two workflows with the same hash
 * behave the same; a change to any step, secret, parameter or output
 * changes it.
 *
 * `metadata` and `$schema` are left out, because neither affects
 * behaviour: re-tagging a workflow or pointing an editor at a different
 * schema URL should not invalidate a cassette or a pending patch. Object
 * keys are sorted before hashing, so key order does not matter either.
 *
 * Returned as `sha256:<64 hex characters>`.
 */
export function hashWorkflow(workflow: Workflow): string {
  const {
    metadata: _metadata,
    $schema: _schema,
    ...behaviour
  } = workflow as Workflow & {
    $schema?: string;
  };
  return digest(behaviour);
}

/** A stable hash of one step, including anything nested inside it. */
export function hashStep(step: Step): string {
  return digest(step);
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

/** JSON with object keys sorted at every level, so equal values give equal text. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

// ---------------------------------------------------------------------------
// Finding and replacing steps

/** Find a step by id anywhere in the workflow, including nested bodies. */
export function findStep(workflow: Workflow, stepId: string): StepLocation | undefined {
  return search(workflow.steps, stepId, '/steps', []);
}

function search(
  steps: readonly Step[],
  stepId: string,
  basePath: string,
  parents: string[],
): StepLocation | undefined {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const view = step as Nested;
    const path = `${basePath}/${i}`;
    if (view.id === stepId) return { step, path, parents };
    for (const body of BODIES) {
      const nested = view[body];
      if (!Array.isArray(nested)) continue;
      const found = search(nested, stepId, `${path}/${body}`, [...parents, view.id ?? '']);
      if (found) return found;
    }
  }
  return undefined;
}

/** Every step id in the workflow, in document order, nested bodies included. */
export function listStepIds(workflow: Workflow): string[] {
  const ids: string[] = [];
  const walk = (steps: readonly Step[]): void => {
    for (const step of steps) {
      const view = step as Nested;
      if (typeof view.id === 'string') ids.push(view.id);
      for (const body of BODIES) {
        const nested = view[body];
        if (Array.isArray(nested)) walk(nested);
      }
    }
  };
  walk(workflow.steps);
  return ids;
}

/**
 * Return a copy of the workflow with the step `stepId` replaced by
 * `replacement`. Returns `undefined` if no step has that id. The result is
 * not validated; use `applyPatch` for a checked change.
 */
export function replaceStep(
  workflow: Workflow,
  stepId: string,
  replacement: Step,
): Workflow | undefined {
  return rewrite(workflow, stepId, () => [replacement]);
}

/**
 * Return a copy of the workflow with `inserted` placed directly before or
 * after the step `anchorId`, in the same body. Returns `undefined` if no
 * step has that id. The result is not validated.
 */
export function insertStep(
  workflow: Workflow,
  anchorId: string,
  inserted: Step,
  position: 'before' | 'after',
): Workflow | undefined {
  return rewrite(workflow, anchorId, (anchor) =>
    position === 'before' ? [inserted, anchor] : [anchor, inserted],
  );
}

function rewrite(
  workflow: Workflow,
  stepId: string,
  replaceWith: (found: Step) => Step[],
): Workflow | undefined {
  let done = false;
  const walk = (steps: readonly Step[]): Step[] => {
    const out: Step[] = [];
    for (const step of steps) {
      const view = step as Nested;
      if (!done && view.id === stepId) {
        done = true;
        out.push(...replaceWith(step));
        continue;
      }
      let copy: Step = step;
      for (const body of BODIES) {
        const nested = view[body];
        if (done || !Array.isArray(nested)) continue;
        const rewritten = walk(nested);
        if (done) copy = { ...copy, [body]: rewritten } as Step;
      }
      out.push(copy);
    }
    return out;
  };
  const steps = walk(workflow.steps);
  return done ? ({ ...workflow, steps } as Workflow) : undefined;
}

// ---------------------------------------------------------------------------
// Validating and applying a patch

/**
 * Validate an unknown value as a `StepPatch`. Checks the shape against the
 * patch schema and applies the step rules (no control characters in
 * `intent`, unique ids) to `before` and `after`. It does not look at any
 * workflow; `applyPatch` does that.
 */
export function validatePatch(data: unknown): ValidationResult<StepPatch> {
  const errors = validatePatchShape(data);
  if (errors.length > 0) return { valid: false, value: undefined, errors };

  const patch = data as StepPatch;
  const afterId = (patch.after as Nested).id;
  if (patch.op === 'replace') {
    const beforeId = (patch.before as Nested | undefined)?.id;
    if (beforeId !== patch.stepId) {
      errors.push(
        issue('/before/id', `must be '${patch.stepId}', the step being replaced`, 'patchStepId'),
      );
    }
    if (afterId !== patch.stepId) {
      errors.push(
        issue(
          '/after/id',
          `a replacement keeps the id of the step it replaces ('${patch.stepId}')`,
          'patchStepId',
        ),
      );
    }
  } else if (afterId === patch.stepId) {
    errors.push(
      issue(
        '/after/id',
        'an inserted step needs its own id, not the id of its anchor',
        'patchStepId',
      ),
    );
  }

  if (errors.length > 0) return { valid: false, value: undefined, errors };
  return { valid: true, value: patch, errors: [] };
}

export type ApplyPatchResult =
  | {
      ok: true;
      /** The patched workflow. A new object; the input is untouched. */
      workflow: Workflow;
      /** `hashWorkflow` of the patched workflow. */
      hash: string;
    }
  | { ok: false; errors: ValidationError[] };

/**
 * Apply a patch to a workflow and return the result, or the reasons it
 * cannot be applied. Never throws and never mutates its inputs.
 *
 * The patch is refused when:
 * - it is not a valid `StepPatch`;
 * - it names a different workflow, or `baseHash` does not match the
 *   workflow it is being applied to (the workflow changed since the patch
 *   was written);
 * - the anchored step does not exist;
 * - for `replace`, `before` is not equal to the step currently there;
 * - the patched workflow fails validation (a duplicate id, an undeclared
 *   secret, and so on).
 *
 * This function checks that a patch is well formed and applies cleanly. It
 * does not judge whether the change is acceptable. Limits on what a healer
 * may change (no new origins, no touching secrets, no weakening `post`)
 * are the healer's to enforce.
 */
export function applyPatch(workflow: Workflow, data: unknown): ApplyPatchResult {
  const checked = validatePatch(data);
  if (!checked.valid || !checked.value) return { ok: false, errors: checked.errors };
  const patch = checked.value;

  if (patch.workflowId !== workflow.id) {
    return fail(
      '/workflowId',
      `patch is for workflow '${patch.workflowId}', not '${workflow.id}'`,
      'patchWorkflowId',
    );
  }
  const currentHash = hashWorkflow(workflow);
  if (patch.baseHash !== currentHash) {
    return fail(
      '/baseHash',
      'the workflow has changed since this patch was written (hash does not match)',
      'patchBaseHash',
      { expected: patch.baseHash, actual: currentHash },
    );
  }
  const anchor = findStep(workflow, patch.stepId);
  if (!anchor) {
    return fail('/stepId', `workflow has no step with id '${patch.stepId}'`, 'patchStepNotFound');
  }

  let patched: Workflow | undefined;
  if (patch.op === 'replace') {
    if (hashStep(patch.before!) !== hashStep(anchor.step)) {
      return fail(
        '/before',
        `does not match step '${patch.stepId}' as it currently stands in the workflow`,
        'patchBeforeMismatch',
      );
    }
    patched = replaceStep(workflow, patch.stepId, patch.after);
  } else {
    patched = insertStep(
      workflow,
      patch.stepId,
      patch.after,
      patch.op === 'insert_before' ? 'before' : 'after',
    );
  }
  if (!patched) {
    return fail('/stepId', `workflow has no step with id '${patch.stepId}'`, 'patchStepNotFound');
  }

  const result = validateWorkflow(patched);
  if (!result.valid || !result.value) return { ok: false, errors: result.errors };
  return { ok: true, workflow: result.value, hash: hashWorkflow(result.value) };
}

function issue(
  path: string,
  message: string,
  keyword: string,
  params: Record<string, unknown> = {},
): ValidationError {
  return { path, message, keyword, params };
}

function fail(
  path: string,
  message: string,
  keyword: string,
  params: Record<string, unknown> = {},
): ApplyPatchResult {
  return { ok: false, errors: [issue(path, message, keyword, params)] };
}

// ---------------------------------------------------------------------------
// Diffing

/** One field-level difference between two versions of a step. */
export interface StepChange {
  /** JSON Pointer within the step, for example `/target/candidates/0/value`. */
  path: string;
  kind: 'added' | 'removed' | 'changed';
  /** Value before. Absent for `added`. */
  before?: unknown;
  /** Value after. Absent for `removed`. */
  after?: unknown;
}

/** What a patch changes, in a form a renderer can turn into a readable diff. */
export interface StepDiff {
  stepId: string;
  op: StepPatch['op'];
  /** `intent` of the affected step, so the diff can say what the step is for. */
  intent: string;
  /**
   * Field-level changes. For `replace`, the differences between `before`
   * and `after`. For an insert, one `added` change at the root carrying the
   * whole new step.
   */
  changes: StepChange[];
}

/**
 * Field-level differences between two versions of a step. Objects are
 * compared key by key. Arrays are compared position by position, so
 * inserting an entry at the front of a list shows as a change at every
 * index after it; for ranked selector candidates that is the honest
 * reading, because the rank of every one of them did change.
 */
export function diffStep(before: Step, after: Step): StepChange[] {
  const changes: StepChange[] = [];
  compare(before, after, '', changes);
  return changes;
}

/** Describe what a patch changes. */
export function diffPatch(patch: StepPatch): StepDiff {
  const intent = (patch.after as { intent?: string }).intent ?? '';
  if (patch.op === 'replace' && patch.before) {
    return {
      stepId: patch.stepId,
      op: patch.op,
      intent,
      changes: diffStep(patch.before, patch.after),
    };
  }
  return {
    stepId: patch.stepId,
    op: patch.op,
    intent,
    changes: [{ path: '', kind: 'added', after: patch.after }],
  };
}

function compare(a: unknown, b: unknown, path: string, out: StepChange[]): void {
  if (a === undefined && b === undefined) return;
  if (a === undefined) {
    out.push({ path, kind: 'added', after: b });
    return;
  }
  if (b === undefined) {
    out.push({ path, kind: 'removed', before: a });
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const length = Math.max(a.length, b.length);
    for (let i = 0; i < length; i++) compare(a[i], b[i], `${path}/${i}`, out);
    return;
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const key of keys) compare(a[key], b[key], `${path}/${escapePointer(key)}`, out);
    return;
  }
  if (canonicalJson(a) !== canonicalJson(b)) {
    out.push({ path, kind: 'changed', before: a, after: b });
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function escapePointer(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}
