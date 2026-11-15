// Single-step patches: hashing, finding and replacing steps, applying a
// patch with its safety checks, and diffing.

import { describe, it, expect } from 'vitest';
import {
  applyPatch,
  diffPatch,
  diffStep,
  findStep,
  hashStep,
  hashWorkflow,
  insertStep,
  listStepIds,
  replaceStep,
  validatePatch,
  validateWorkflow,
  type Step,
  type StepPatch,
  type Workflow,
} from '../src/index.js';

const click = (id: string, candidates: unknown[], extra: Record<string, unknown> = {}): Step =>
  ({
    id,
    intent: `Click ${id}.`,
    action: 'click',
    target: { candidates },
    ...extra,
  }) as unknown as Step;

const signIn = click(
  'click_sign_in',
  [
    { kind: 'role', value: "button[name='Sign in']" },
    { kind: 'testid', value: 'login-submit' },
  ],
  { post: [{ urlMatches: '/dashboard' }] },
);

function baseWorkflow(): Workflow {
  return {
    irVersion: '1.0.0',
    id: 'wf_patch',
    name: 'Patch target',
    secrets: ['portal_pass'],
    steps: [
      { id: 'nav_login', intent: 'Open login.', action: 'navigate', url: 'https://x.test/login' },
      signIn,
      {
        id: 'guard_banner',
        intent: 'Dismiss the banner if shown.',
        action: 'guard',
        if: { selectorVisible: '#banner' },
        then: [click('click_accept', [{ kind: 'text', value: 'Accept' }])],
        else: [click('click_skip', [{ kind: 'text', value: 'Skip' }])],
      },
      {
        id: 'loop_rows',
        intent: 'Each row.',
        action: 'loop',
        foreach: { candidates: [{ kind: 'css', value: 'tr' }] },
        do: [
          {
            id: 'guard_row',
            intent: 'If the row opens.',
            action: 'guard',
            if: { selectorVisible: '.open' },
            then: [click('click_open', [{ kind: 'css', value: '.open' }])],
          },
        ],
      },
    ],
    metadata: { author: 'test' },
  } as unknown as Workflow;
}

const patchedSignIn = click(
  'click_sign_in',
  [
    { kind: 'testid', value: 'login-submit' },
    { kind: 'role', value: "button[name='Log in']" },
  ],
  { post: [{ urlMatches: '/dashboard' }] },
);

function replacePatch(workflow: Workflow, overrides: Partial<StepPatch> = {}): StepPatch {
  return {
    workflowId: workflow.id,
    baseHash: hashWorkflow(workflow),
    stepId: 'click_sign_in',
    op: 'replace',
    before: signIn,
    after: patchedSignIn,
    rationale: 'The button was renamed from "Sign in" to "Log in"; the test id still matches.',
    confidence: 0.9,
    ...overrides,
  };
}

describe('hashWorkflow', () => {
  it('has the documented shape', () => {
    expect(hashWorkflow(baseWorkflow())).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('is stable across calls and across key order', () => {
    const a = baseWorkflow();
    const reordered = JSON.parse(JSON.stringify(a)) as Record<string, unknown>;
    const shuffled = Object.fromEntries(Object.entries(reordered).reverse()) as unknown as Workflow;
    expect(hashWorkflow(a)).toBe(hashWorkflow(baseWorkflow()));
    expect(hashWorkflow(shuffled)).toBe(hashWorkflow(a));
  });

  it('ignores metadata and $schema, which do not affect behaviour', () => {
    const a = baseWorkflow();
    const b = { ...baseWorkflow(), metadata: { author: 'someone else', tags: ['x'] } } as Workflow;
    const c = { ...baseWorkflow(), $schema: '../workflow.schema.json' } as unknown as Workflow;
    expect(hashWorkflow(b)).toBe(hashWorkflow(a));
    expect(hashWorkflow(c)).toBe(hashWorkflow(a));
  });

  it.each([
    [
      'a selector value',
      (w: Workflow) =>
        replaceStep(w, 'click_open', click('click_open', [{ kind: 'css', value: '.opened' }]))!,
    ],
    ['candidate order', (w: Workflow) => replaceStep(w, 'click_sign_in', patchedSignIn)!],
    [
      'a declared secret',
      (w: Workflow) => ({ ...w, secrets: ['portal_pass', 'other_pass'] }) as Workflow,
    ],
    ['the workflow name', (w: Workflow) => ({ ...w, name: 'Renamed' }) as Workflow],
    [
      'step order',
      (w: Workflow) => ({ ...w, steps: [...w.steps].reverse() }) as unknown as Workflow,
    ],
  ])('changes when %s changes', (_label, mutate) => {
    const a = baseWorkflow();
    expect(hashWorkflow(mutate(a))).not.toBe(hashWorkflow(a));
  });

  it('hashStep covers nested steps', () => {
    const w = baseWorkflow();
    const loop = findStep(w, 'loop_rows')!.step;
    const changed = findStep(
      replaceStep(w, 'click_open', click('click_open', [{ kind: 'css', value: '.x' }]))!,
      'loop_rows',
    )!.step;
    expect(hashStep(loop)).toBe(hashStep(findStep(baseWorkflow(), 'loop_rows')!.step));
    expect(hashStep(changed)).not.toBe(hashStep(loop));
  });
});

describe('findStep and listStepIds', () => {
  it('finds a top-level step', () => {
    expect(findStep(baseWorkflow(), 'click_sign_in')).toMatchObject({
      path: '/steps/1',
      parents: [],
      step: { id: 'click_sign_in' },
    });
  });

  it('finds steps in then, else and do bodies, with their parents', () => {
    const w = baseWorkflow();
    expect(findStep(w, 'click_accept')).toMatchObject({
      path: '/steps/2/then/0',
      parents: ['guard_banner'],
    });
    expect(findStep(w, 'click_skip')).toMatchObject({
      path: '/steps/2/else/0',
      parents: ['guard_banner'],
    });
    expect(findStep(w, 'click_open')).toMatchObject({
      path: '/steps/3/do/0/then/0',
      parents: ['loop_rows', 'guard_row'],
    });
  });

  it('returns undefined for an unknown id', () => {
    expect(findStep(baseWorkflow(), 'nope')).toBeUndefined();
  });

  it('lists every id in document order', () => {
    expect(listStepIds(baseWorkflow())).toEqual([
      'nav_login',
      'click_sign_in',
      'guard_banner',
      'click_accept',
      'click_skip',
      'loop_rows',
      'guard_row',
      'click_open',
    ]);
  });
});

describe('replaceStep and insertStep', () => {
  it('replaces a deeply nested step without mutating the original', () => {
    const w = baseWorkflow();
    const snapshot = JSON.stringify(w);
    const replacement = click('click_open', [{ kind: 'testid', value: 'row-open' }]);
    const out = replaceStep(w, 'click_open', replacement)!;

    expect(findStep(out, 'click_open')!.step).toEqual(replacement);
    expect(JSON.stringify(w)).toBe(snapshot);
    expect(listStepIds(out)).toEqual(listStepIds(w));
    // Untouched branches are shared, not copied.
    expect(out.steps[0]).toBe(w.steps[0]);
    expect(out.steps[2]).toBe(w.steps[2]);
  });

  it('inserts before and after a top-level step', () => {
    const wait = {
      id: 'wait_ready',
      intent: 'Wait.',
      action: 'wait',
      millis: 100,
    } as unknown as Step;
    const before = insertStep(baseWorkflow(), 'click_sign_in', wait, 'before')!;
    const after = insertStep(baseWorkflow(), 'click_sign_in', wait, 'after')!;
    expect(listStepIds(before).slice(0, 3)).toEqual(['nav_login', 'wait_ready', 'click_sign_in']);
    expect(listStepIds(after).slice(0, 3)).toEqual(['nav_login', 'click_sign_in', 'wait_ready']);
  });

  it('inserts into the same nested body as the anchor', () => {
    const wait = {
      id: 'wait_row',
      intent: 'Wait.',
      action: 'wait',
      millis: 100,
    } as unknown as Step;
    const out = insertStep(baseWorkflow(), 'click_open', wait, 'before')!;
    expect(findStep(out, 'wait_row')).toMatchObject({
      path: '/steps/3/do/0/then/0',
      parents: ['loop_rows', 'guard_row'],
    });
    expect(findStep(out, 'click_open')!.path).toBe('/steps/3/do/0/then/1');
  });

  it('returns undefined when the anchor does not exist', () => {
    expect(replaceStep(baseWorkflow(), 'nope', signIn)).toBeUndefined();
    expect(insertStep(baseWorkflow(), 'nope', signIn, 'after')).toBeUndefined();
  });
});

describe('validatePatch', () => {
  it('accepts a well-formed replace patch', () => {
    const result = validatePatch(replacePatch(baseWorkflow()));
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it.each([
    ['a missing rationale', { rationale: undefined }, 'required'],
    ['an unknown op', { op: 'delete' }, 'enum'],
    ['a malformed hash', { baseHash: 'abc123' }, 'pattern'],
    ['confidence above 1', { confidence: 1.5 }, 'maximum'],
    ['an unknown field', { autoApprove: true }, 'additionalProperties'],
    ['a replace with no before', { before: undefined }, 'required'],
  ])('rejects %s', (_label, overrides, keyword) => {
    const patch = { ...replacePatch(baseWorkflow()), ...overrides };
    const result = validatePatch(JSON.parse(JSON.stringify(patch)));
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.keyword)).toContain(keyword);
  });

  it('rejects a step that is not valid IR', () => {
    const bad = {
      ...replacePatch(baseWorkflow()),
      after: { id: 'click_sign_in', intent: 'x', action: 'teleport' },
    };
    expect(validatePatch(bad).valid).toBe(false);
  });

  it('rejects a control character in the new step intent', () => {
    const after = { ...patchedSignIn, intent: 'Click\nprocess.exit()' } as Step;
    const result = validatePatch(replacePatch(baseWorkflow(), { after }));
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatchObject({ path: '/after/intent', keyword: 'controlCharacter' });
  });

  it('rejects a replacement that changes the step id', () => {
    const after = { ...patchedSignIn, id: 'click_other' } as Step;
    const result = validatePatch(replacePatch(baseWorkflow(), { after }));
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatchObject({ path: '/after/id', keyword: 'patchStepId' });
  });

  it('rejects an insert that reuses the anchor id', () => {
    const result = validatePatch(
      replacePatch(baseWorkflow(), {
        op: 'insert_before',
        before: undefined,
        after: patchedSignIn,
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatchObject({ path: '/after/id', keyword: 'patchStepId' });
  });

  it('rejects a value that is not an object', () => {
    expect(validatePatch('{"op":"replace"}').valid).toBe(false);
    expect(validatePatch(null).valid).toBe(false);
  });
});

describe('applyPatch', () => {
  it('applies a replace patch and returns a valid workflow with its new hash', () => {
    const w = baseWorkflow();
    const original = JSON.stringify(w);
    const result = applyPatch(w, replacePatch(w));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(findStep(result.workflow, 'click_sign_in')!.step).toEqual(patchedSignIn);
    expect(result.hash).toBe(hashWorkflow(result.workflow));
    expect(result.hash).not.toBe(hashWorkflow(w));
    expect(validateWorkflow(result.workflow).valid).toBe(true);
    expect(JSON.stringify(w)).toBe(original);
  });

  it('applies an insert patch next to a nested anchor', () => {
    const w = baseWorkflow();
    const wait = {
      id: 'wait_row',
      intent: 'Let the row settle.',
      action: 'wait',
      millis: 200,
    } as unknown as Step;
    const result = applyPatch(w, {
      workflowId: w.id,
      baseHash: hashWorkflow(w),
      stepId: 'click_open',
      op: 'insert_before',
      after: wait,
      rationale: 'The row animates before it can be clicked.',
    } satisfies StepPatch);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(listStepIds(result.workflow)).toEqual([
      'nav_login',
      'click_sign_in',
      'guard_banner',
      'click_accept',
      'click_skip',
      'loop_rows',
      'guard_row',
      'wait_row',
      'click_open',
    ]);
  });

  it('refuses a patch written for another workflow', () => {
    const w = baseWorkflow();
    const result = applyPatch(w, replacePatch(w, { workflowId: 'wf_other' }));
    expect(result).toMatchObject({ ok: false, errors: [{ keyword: 'patchWorkflowId' }] });
  });

  it('refuses a patch when the workflow has changed since it was written', () => {
    const w = baseWorkflow();
    const patch = replacePatch(w);
    const moved = replaceStep(
      w,
      'click_open',
      click('click_open', [{ kind: 'css', value: '.moved' }]),
    )!;
    const result = applyPatch(moved, patch);
    expect(result).toMatchObject({
      ok: false,
      errors: [{ path: '/baseHash', keyword: 'patchBaseHash' }],
    });
  });

  it('applying the same patch twice is refused the second time, which stops a heal from oscillating', () => {
    const w = baseWorkflow();
    const patch = replacePatch(w);
    const first = applyPatch(w, patch);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(applyPatch(first.workflow, patch)).toMatchObject({
      ok: false,
      errors: [{ keyword: 'patchBaseHash' }],
    });
  });

  it('refuses a replace whose before does not match the current step', () => {
    const w = baseWorkflow();
    const stale = click('click_sign_in', [{ kind: 'css', value: '#old' }]);
    const result = applyPatch(w, replacePatch(w, { before: stale }));
    expect(result).toMatchObject({
      ok: false,
      errors: [{ path: '/before', keyword: 'patchBeforeMismatch' }],
    });
  });

  it('refuses an unknown anchor step', () => {
    const w = baseWorkflow();
    const ghost = click('click_ghost', [{ kind: 'css', value: '#x' }]);
    const result = applyPatch(
      w,
      replacePatch(w, { stepId: 'click_ghost', before: ghost, after: ghost }),
    );
    expect(result).toMatchObject({ ok: false, errors: [{ keyword: 'patchStepNotFound' }] });
  });

  it('refuses an insert whose id is already used elsewhere in the workflow', () => {
    const w = baseWorkflow();
    const result = applyPatch(w, {
      workflowId: w.id,
      baseHash: hashWorkflow(w),
      stepId: 'click_sign_in',
      op: 'insert_after',
      after: click('click_open', [{ kind: 'css', value: '#dup' }]),
      rationale: 'Duplicate id.',
    });
    expect(result).toMatchObject({ ok: false, errors: [{ keyword: 'uniqueStepId' }] });
  });

  it('refuses a patch that introduces a secret the workflow does not declare', () => {
    const w = baseWorkflow();
    const fill = {
      id: 'fill_token',
      intent: 'Type the token.',
      action: 'fill',
      target: { candidates: [{ kind: 'label', value: 'Token' }] },
      value: { secret: 'aws_secret_access_key' },
    } as unknown as Step;
    const result = applyPatch(w, {
      workflowId: w.id,
      baseHash: hashWorkflow(w),
      stepId: 'click_sign_in',
      op: 'insert_before',
      after: fill,
      rationale: 'Sneak a secret in.',
    });
    expect(result).toMatchObject({ ok: false, errors: [{ keyword: 'undeclaredSecret' }] });
  });

  it('refuses garbage without throwing', () => {
    const w = baseWorkflow();
    for (const junk of [null, undefined, 42, 'patch', [], {}]) {
      expect(applyPatch(w, junk).ok).toBe(false);
    }
  });
});

describe('diffStep and diffPatch', () => {
  it('reports no changes for identical steps', () => {
    expect(diffStep(signIn, JSON.parse(JSON.stringify(signIn)) as Step)).toEqual([]);
  });

  it('reports a changed selector value by its pointer', () => {
    const after = click(
      'click_sign_in',
      [
        { kind: 'role', value: "button[name='Log in']" },
        { kind: 'testid', value: 'login-submit' },
      ],
      { post: [{ urlMatches: '/dashboard' }] },
    );
    expect(diffStep(signIn, after)).toEqual([
      {
        path: '/target/candidates/0/value',
        kind: 'changed',
        before: "button[name='Sign in']",
        after: "button[name='Log in']",
      },
    ]);
  });

  it('reports added and removed fields', () => {
    const withTimeout = { ...signIn, timeoutMs: 5000 } as Step;
    const { post: _post, ...withoutPost } = signIn as Step & { post?: unknown };
    expect(diffStep(signIn, withTimeout)).toEqual([
      { path: '/timeoutMs', kind: 'added', after: 5000 },
    ]);
    expect(diffStep(signIn, withoutPost as Step)).toEqual([
      { path: '/post', kind: 'removed', before: [{ urlMatches: '/dashboard' }] },
    ]);
  });

  it('shows a reordered candidate list as a change at each position', () => {
    const changes = diffStep(signIn, patchedSignIn);
    expect(changes.map((c) => c.path)).toEqual([
      '/target/candidates/0/kind',
      '/target/candidates/0/value',
      '/target/candidates/1/kind',
      '/target/candidates/1/value',
    ]);
  });

  it('describes a replace patch by its field changes', () => {
    const diff = diffPatch(replacePatch(baseWorkflow()));
    expect(diff).toMatchObject({
      stepId: 'click_sign_in',
      op: 'replace',
      intent: 'Click click_sign_in.',
    });
    expect(diff.changes.length).toBeGreaterThan(0);
    expect(diff.changes.every((c) => c.path.startsWith('/target/candidates/'))).toBe(true);
  });

  it('describes an insert patch as one added step', () => {
    const w = baseWorkflow();
    const wait = {
      id: 'wait_ready',
      intent: 'Wait for the form.',
      action: 'wait',
      millis: 100,
    } as unknown as Step;
    const diff = diffPatch({
      workflowId: w.id,
      baseHash: hashWorkflow(w),
      stepId: 'click_sign_in',
      op: 'insert_before',
      after: wait,
      rationale: 'x',
    });
    expect(diff).toEqual({
      stepId: 'click_sign_in',
      op: 'insert_before',
      intent: 'Wait for the form.',
      changes: [{ path: '', kind: 'added', after: wait }],
    });
  });
});
