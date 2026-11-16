import { describe, expect, it } from 'vitest';
import { hashWorkflow, validateWorkflow } from '@sfysh/ir';
import type { Step, StepPatch, Workflow } from '@sfysh/ir';
import { checkPatchClass, checkPatchScope, INSERTABLE_ACTIONS } from '../src/index.js';
import type { AllowlistResult } from '../src/index.js';

const workflow = {
  irVersion: '1.0.0',
  id: 'wf_orders',
  name: 'Order export',
  parameters: { month: { type: 'string' } },
  secrets: ['portal_pass'],
  steps: [
    {
      id: 'goto_001',
      intent: 'Open the orders page for the month.',
      action: 'navigate',
      url: { param: 'month' },
    },
    {
      id: 'fill_002',
      intent: 'Enter the account password.',
      action: 'fill',
      target: { candidates: [{ kind: 'role', value: "textbox[name='Password']" }] },
      value: { secret: 'portal_pass' },
    },
    {
      id: 'click_003',
      intent: 'Submit the login form.',
      action: 'click',
      target: { candidates: [{ kind: 'role', value: "button[name='Sign in']" }] },
      pre: [{ selectorVisible: 'form#login' }],
      post: [{ urlMatches: '/dashboard' }],
      timeoutMs: 5000,
    },
    {
      id: 'loop_004',
      intent: 'Open each order row.',
      action: 'loop',
      foreach: { candidates: [{ kind: 'css', value: 'tr.order' }] },
      do: [
        {
          id: 'click_005',
          intent: 'Open the row.',
          action: 'click',
          target: { candidates: [{ kind: 'css', value: 'a.open' }] },
        },
      ],
    },
    {
      id: 'extract_006',
      intent: 'Read the order rows.',
      action: 'extract',
      target: { candidates: [{ kind: 'css', value: 'table#orders' }] },
      schema: { type: 'array', items: { type: 'string' } },
      bind: 'orders',
    },
  ],
} as unknown as Workflow;

type Loose = Record<string, unknown>;

function stepOf(id: string): Loose {
  const find = (steps: Loose[]): Loose | undefined => {
    for (const step of steps) {
      if (step.id === id) return step;
      const found = find((step.do as Loose[] | undefined) ?? []);
      if (found) return found;
    }
    return undefined;
  };
  const found = find(workflow.steps as unknown as Loose[]);
  if (!found) throw new Error(`no step ${id}`);
  return found;
}

/** A replace patch for `id` whose `after` is the current step with `changes` applied. */
function replace(id: string, changes: Loose): StepPatch {
  const before = stepOf(id);
  const after: Loose = { ...before, ...changes };
  for (const key of Object.keys(after)) if (after[key] === undefined) delete after[key];
  return {
    workflowId: workflow.id,
    baseHash: hashWorkflow(workflow),
    stepId: id,
    op: 'replace',
    before: before as unknown as Step,
    after: after as unknown as Step,
    rationale: 'test',
  };
}

function insert(after: Loose, op: 'insert_before' | 'insert_after' = 'insert_before'): StepPatch {
  return {
    workflowId: workflow.id,
    baseHash: hashWorkflow(workflow),
    stepId: 'click_003',
    op,
    after: after as unknown as Step,
    rationale: 'test',
  };
}

function found(result: AllowlistResult): Array<[string, string]> {
  return result.ok ? [] : result.violations.map((v) => [v.code, v.path]);
}

const newTarget = {
  target: {
    candidates: [
      { kind: 'role', value: "button[name='Log in']" },
      { kind: 'css', value: 'form button[type=submit]' },
    ],
  },
};

const dismissBanner = {
  id: 'click_900',
  intent: 'Dismiss the survey banner.',
  action: 'click',
  target: { candidates: [{ kind: 'role', value: "button[name='No thanks']" }] },
};

describe('checkPatchClass(): the fixture', () => {
  it('is a valid workflow', () => {
    expect(validateWorkflow(workflow).valid).toBe(true);
  });
});

describe('checkPatchClass(): selector patches', () => {
  it('accepts new candidates on a click', () => {
    const patch = replace('click_003', newTarget);
    expect(checkPatchClass(patch, workflow, 'selector')).toEqual({ ok: true });
    expect(checkPatchScope(patch, workflow)).toEqual({ ok: true });
  });

  it.each(['fill_002', 'extract_006', 'click_005'])('accepts new candidates on %s', (id) => {
    expect(checkPatchClass(replace(id, newTarget), workflow, 'selector')).toEqual({ ok: true });
  });

  it('accepts reordered candidates and ignores key order elsewhere', () => {
    const before = stepOf('click_003');
    const patch = replace('click_003', newTarget);
    // The same step with its keys in another order.
    patch.after = {
      timeoutMs: before.timeoutMs,
      post: before.post,
      pre: before.pre,
      ...newTarget,
      action: before.action,
      intent: before.intent,
      id: before.id,
    } as unknown as Step;
    expect(checkPatchClass(patch, workflow, 'selector')).toEqual({ ok: true });
  });

  it.each<[string, Loose, string]>([
    ['a reworded intent', { intent: 'Click the first button on the page.' }, '/after/intent'],
    [
      'an added post condition',
      { post: [{ urlMatches: '/dashboard' }, { textPresent: 'Hi' }] },
      '/after/post',
    ],
    ['a removed post condition', { post: undefined }, '/after/post'],
    ['a changed pre condition', { pre: [{ selectorVisible: 'body' }] }, '/after/pre'],
    ['a removed pre condition', { pre: undefined }, '/after/pre'],
    ['a changed timeout', { timeoutMs: 600000 }, '/after/timeoutMs'],
    ['an added onFail', { onFail: 'continue' }, '/after/onFail'],
    ['a changed id', { id: 'click_999' }, '/after/id'],
    ['a changed action', { action: 'extract' }, '/after/action'],
    ['an unknown field', { script: 'fetch("https://example.test")' }, '/after/script'],
  ])('rejects %s', (_name, changes, path) => {
    const patch = replace('click_003', { ...newTarget, ...changes });
    expect(found(checkPatchClass(patch, workflow, 'selector'))).toEqual([
      ['field_not_allowed', path],
    ]);
  });

  it('rejects a changed value on a fill, including a retargeted secret', () => {
    for (const value of ['hunter2', { secret: 'other_pass' }, { param: 'month' }]) {
      const patch = replace('fill_002', { ...newTarget, value });
      expect(found(checkPatchClass(patch, workflow, 'selector'))).toEqual([
        ['field_not_allowed', '/after/value'],
      ]);
    }
  });

  it('rejects a changed bind or schema on an extract', () => {
    const patch = replace('extract_006', {
      ...newTarget,
      bind: 'rows',
      schema: { type: 'string' },
    });
    expect(found(checkPatchClass(patch, workflow, 'selector'))).toEqual([
      ['field_not_allowed', '/after/bind'],
      ['field_not_allowed', '/after/schema'],
    ]);
  });

  it('reports every field that changed', () => {
    const patch = replace('click_003', { ...newTarget, intent: 'x', timeoutMs: 1, pre: undefined });
    expect(found(checkPatchClass(patch, workflow, 'selector'))).toEqual([
      ['field_not_allowed', '/after/intent'],
      ['field_not_allowed', '/after/pre'],
      ['field_not_allowed', '/after/timeoutMs'],
    ]);
  });

  it('compares with the workflow, not with the "before" the patch reports', () => {
    const patch = replace('click_003', { ...newTarget, post: undefined });
    // A "before" that also lacks the post condition would hide the change.
    patch.before = { ...stepOf('click_003'), post: undefined } as unknown as Step;
    expect(found(checkPatchClass(patch, workflow, 'selector'))).toEqual([
      ['field_not_allowed', '/after/post'],
    ]);
  });

  it('rejects a patch that leaves the candidates as they were', () => {
    const patch = replace('click_003', {});
    expect(found(checkPatchClass(patch, workflow, 'selector'))).toEqual([
      ['no_change', '/after/target'],
    ]);
  });

  it('rejects a step that has no target', () => {
    for (const id of ['goto_001', 'loop_004']) {
      const patch = replace(id, newTarget);
      expect(found(checkPatchClass(patch, workflow, 'selector'))).toEqual([
        ['no_target', '/stepId'],
      ]);
    }
  });

  it('rejects an insert', () => {
    expect(found(checkPatchClass(insert(dismissBanner), workflow, 'selector'))).toEqual([
      ['wrong_op', '/op'],
    ]);
  });

  it('rejects a step that is not in the workflow', () => {
    const patch = { ...replace('click_003', newTarget), stepId: 'click_404' };
    expect(found(checkPatchClass(patch, workflow, 'selector'))).toEqual([
      ['unknown_step', '/stepId'],
    ]);
  });

  it('does not quote patch content in a message', () => {
    const patch = replace('click_003', { ...newTarget, intent: 'SENTINEL-INTENT' });
    expect(JSON.stringify(checkPatchClass(patch, workflow, 'selector'))).not.toContain('SENTINEL');
  });
});

describe('checkPatchClass(): insert-step patches', () => {
  it('lists click and wait as the actions that may be inserted', () => {
    expect(INSERTABLE_ACTIONS).toEqual(['click', 'wait']);
  });

  it.each(['insert_before', 'insert_after'] as const)('accepts a click with %s', (op) => {
    const patch = insert(dismissBanner, op);
    expect(checkPatchClass(patch, workflow, 'insert_step')).toEqual({ ok: true });
    expect(checkPatchScope(patch, workflow)).toEqual({ ok: true });
  });

  it('accepts a wait', () => {
    const wait = {
      id: 'wait_900',
      intent: 'Wait for the orders panel to load.',
      action: 'wait',
      forCondition: { selectorVisible: '#orders' },
    };
    expect(checkPatchClass(insert(wait), workflow, 'insert_step')).toEqual({ ok: true });
  });

  it.each<[string, Loose]>([
    [
      'fill',
      {
        action: 'fill',
        target: { candidates: [{ kind: 'label', value: 'Delivery phone' }] },
        value: '0400 000 000',
      },
    ],
    ['navigate', { action: 'navigate', url: 'https://example.test/' }],
    [
      'extract',
      {
        action: 'extract',
        target: { candidates: [{ kind: 'css', value: 'body' }] },
        schema: { type: 'string' },
      },
    ],
    ['assert', { action: 'assert', condition: { textPresent: 'Orders' } }],
    [
      'guard',
      {
        action: 'guard',
        if: { selectorVisible: '#x' },
        then: [{ ...dismissBanner, id: 'click_901' }],
      },
    ],
    [
      'loop',
      {
        action: 'loop',
        while: { selectorVisible: '#x' },
        do: [{ ...dismissBanner, id: 'click_901' }],
      },
    ],
  ])('rejects an inserted %s', (_name, fields) => {
    const step = { id: 'step_900', intent: 'Do something new.', ...fields };
    expect(found(checkPatchClass(insert(step), workflow, 'insert_step'))).toEqual([
      ['action_not_allowed', '/after/action'],
    ]);
  });

  it('rejects a step with no action or an unknown one', () => {
    for (const action of [undefined, 'evaluate', 7]) {
      const step = { ...dismissBanner, action };
      expect(found(checkPatchClass(insert(step), workflow, 'insert_step'))).toEqual([
        ['action_not_allowed', '/after/action'],
      ]);
    }
  });

  it('rejects a replace, even one that only changes candidates', () => {
    const patch = replace('click_003', newTarget);
    expect(found(checkPatchClass(patch, workflow, 'insert_step'))).toEqual([['wrong_op', '/op']]);
  });
});
