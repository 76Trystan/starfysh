import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyPatch, hashWorkflow, validateWorkflow } from '@sfysh/ir';
import type { Step, StepPatch, Workflow } from '@sfysh/ir';
import { checkPatchScope, parseHealResponse, STEP_FIELDS } from '../src/index.js';
import type { ScopeResult } from '../src/index.js';

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
      id: 'guard_002',
      intent: 'Dismiss the cookie banner if it is shown.',
      action: 'guard',
      if: { selectorVisible: '#cookies' },
      then: [
        {
          id: 'click_003',
          intent: 'Accept cookies.',
          action: 'click',
          target: { candidates: [{ kind: 'css', value: '#cookies button' }] },
        },
      ],
    },
    {
      id: 'fill_004',
      intent: 'Enter the account password.',
      action: 'fill',
      target: { candidates: [{ kind: 'role', value: "textbox[name='Password']" }] },
      value: { secret: 'portal_pass' },
    },
    {
      id: 'click_005',
      intent: 'Submit the login form.',
      action: 'click',
      target: { candidates: [{ kind: 'role', value: "button[name='Sign in']" }] },
      post: [{ urlMatches: '/dashboard' }, { selectorVisible: '#orders' }],
    },
    {
      id: 'assert_006',
      intent: 'Check the orders table is shown.',
      action: 'assert',
      condition: { selectorVisible: 'table#orders' },
    },
    {
      id: 'extract_007',
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
      for (const body of ['then', 'else', 'do']) {
        const nested = step[body] as Loose[] | undefined;
        const found = nested && find(nested);
        if (found) return found;
      }
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
    stepId: 'click_005',
    op,
    after: after as unknown as Step,
    rationale: 'test',
  };
}

function codes(result: ScopeResult): string[] {
  return result.ok ? [] : result.violations.map((v) => v.code);
}

const newCandidates = {
  target: {
    candidates: [
      { kind: 'role', value: "button[name='Log in']" },
      { kind: 'css', value: 'form button[type=submit]' },
    ],
  },
};

describe('checkPatchScope(): the fixture', () => {
  it('is a valid workflow', () => {
    expect(validateWorkflow(workflow).valid).toBe(true);
  });
});

describe('checkPatchScope(): what a heal may change', () => {
  it('accepts new selector candidates', () => {
    const patch = replace('click_005', newCandidates);
    expect(checkPatchScope(patch, workflow)).toEqual({ ok: true });
    // And the patch it accepted does apply.
    expect(applyPatch(workflow, patch).ok).toBe(true);
  });

  it.each([
    [
      'an added post condition',
      { post: [...(stepOf('click_005').post as unknown[]), { textPresent: 'Orders' }] },
    ],
    [
      'post conditions in a different order',
      { post: [{ selectorVisible: '#orders' }, { urlMatches: '/dashboard' }] },
    ],
    ['a reworded intent', { intent: 'Press the button that submits the login form.' }],
    ['a longer timeout', { timeoutMs: 60_000 }],
    ['an added pre condition', { pre: [{ selectorVisible: 'form' }] }],
  ])('accepts %s', (_label, changes) => {
    expect(checkPatchScope(replace('click_005', changes), workflow)).toEqual({ ok: true });
  });

  it('accepts a change to a guard’s own condition when its body is untouched', () => {
    const patch = replace('guard_002', { if: { selectorVisible: '#cookie-banner' } });
    expect(checkPatchScope(patch, workflow)).toEqual({ ok: true });
  });

  it('accepts a patch to a step nested inside a guard', () => {
    const patch = replace('click_003', {
      target: { candidates: [{ kind: 'role', value: "button[name='Accept']" }] },
    });
    expect(checkPatchScope(patch, workflow)).toEqual({ ok: true });
  });

  it('accepts new candidates on an extract that keeps its bind and schema', () => {
    const patch = replace('extract_007', {
      target: { candidates: [{ kind: 'testid', value: 'orders-table' }] },
    });
    expect(checkPatchScope(patch, workflow)).toEqual({ ok: true });
  });

  it('accepts an inserted click', () => {
    const patch = insert({
      id: 'click_new',
      intent: 'Open the login panel.',
      action: 'click',
      target: { candidates: [{ kind: 'role', value: "button[name='Log in']" }] },
    });
    expect(checkPatchScope(patch, workflow)).toEqual({ ok: true });
  });

  it('ignores key order when comparing', () => {
    const before = stepOf('click_005');
    const reordered = Object.fromEntries(Object.entries(before).reverse());
    const patch = { ...replace('click_005', newCandidates), before: reordered as unknown as Step };
    expect(checkPatchScope(patch, workflow)).toEqual({ ok: true });
  });
});

describe('checkPatchScope(): post conditions', () => {
  it.each([
    ['one is removed', { post: [{ urlMatches: '/dashboard' }] }, 1],
    ['all are removed', { post: undefined }, 2],
    ['the list is emptied', { post: [] }, 2],
    ['one is altered', { post: [{ urlMatches: '/' }, { selectorVisible: '#orders' }] }, 1],
    [
      'one is swapped for a different kind',
      { post: [{ urlMatches: '/dashboard' }, { textPresent: 'x' }] },
      1,
    ],
  ])('rejects a patch in which %s', (_label, changes, count) => {
    const result = checkPatchScope(
      replace('click_005', { ...newCandidates, ...changes }),
      workflow,
    );
    expect(codes(result)).toEqual(Array(count).fill('post_weakened'));
  });

  it('points at the condition that was lost', () => {
    const result = checkPatchScope(
      replace('click_005', { post: [{ urlMatches: '/dashboard' }] }),
      workflow,
    );
    expect(result.ok === false && result.violations[0]!.path).toBe('/before/post/1');
  });

  it('rejects a changed assert condition', () => {
    const result = checkPatchScope(
      replace('assert_006', { condition: { textPresent: 'anything' } }),
      workflow,
    );
    expect(codes(result)).toEqual(['assertion_changed']);
  });
});

describe('checkPatchScope(): one step per heal', () => {
  const guard = stepOf('guard_002');
  const nested = (guard.then as Loose[])[0]!;

  it.each([
    ['a nested step is edited', { then: [{ ...nested, intent: 'Click anything.' }] }],
    ['a nested step is replaced', { then: [{ ...nested, id: 'click_other' }] }],
    ['a nested step is added', { then: [nested, { ...nested, id: 'click_extra' }] }],
    ['an else branch is added', { else: [{ ...nested, id: 'click_else' }] }],
  ])('rejects a replacement in which %s', (_label, changes) => {
    expect(codes(checkPatchScope(replace('guard_002', changes), workflow))).toEqual([
      'nested_steps_changed',
    ]);
  });

  it('rejects a replacement that changes the action', () => {
    const result = checkPatchScope(
      replace('click_005', { action: 'navigate', target: undefined, url: 'https://x.test/' }),
      workflow,
    );
    expect(codes(result)).toContain('action_changed');
  });

  it('rejects an inserted step that carries nested steps', () => {
    const patch = insert({
      id: 'guard_new',
      intent: 'Maybe do several things.',
      action: 'guard',
      if: { selectorVisible: '#x' },
      then: [nested],
      else: [{ ...nested, id: 'click_else' }],
    });
    expect(codes(checkPatchScope(patch, workflow))).toEqual([
      'nested_steps_added',
      'nested_steps_added',
    ]);
  });
});

describe('checkPatchScope(): outputs and parameters', () => {
  it.each([
    ['its bind', { bind: 'rows' }, '/after/bind'],
    ['its bind removed', { bind: undefined }, '/after/bind'],
    ['its schema', { schema: { type: 'string' } }, '/after/schema'],
  ])('rejects an extract that changes %s', (_label, changes, path) => {
    const result = checkPatchScope(replace('extract_007', changes), workflow);
    expect(codes(result)).toEqual(['outputs_changed']);
    expect(result.ok === false && result.violations[0]!.path).toBe(path);
  });

  it('rejects an inserted extract', () => {
    const patch = insert({
      id: 'extract_new',
      intent: 'Read the page title.',
      action: 'extract',
      target: { candidates: [{ kind: 'css', value: 'h1' }] },
      schema: { type: 'string' },
    });
    expect(codes(checkPatchScope(patch, workflow))).toEqual(['outputs_changed']);
  });

  it.each([
    ['replaces a parameter with a literal', 'goto_001', { url: 'https://x.test/orders' }],
    ['reads a different parameter', 'goto_001', { url: { param: 'year' } }],
    ['starts reading a parameter', 'fill_004', { value: { param: 'month' } }],
  ])('rejects a replacement that %s', (_label, id, changes) => {
    expect(codes(checkPatchScope(replace(id, changes), workflow))).toEqual(['parameters_changed']);
  });

  it('rejects an inserted step that reads a parameter', () => {
    const patch = insert({
      id: 'goto_new',
      intent: 'Open another page.',
      action: 'navigate',
      url: { param: 'month' },
    });
    expect(codes(checkPatchScope(patch, workflow))).toEqual(['parameters_changed']);
  });
});

describe('checkPatchScope(): unknown fields', () => {
  it('rejects a field no step of that action has', () => {
    const result = checkPatchScope(replace('click_005', { script: 'document.cookie' }), workflow);
    expect(codes(result)).toEqual(['unknown_field']);
    expect(result.ok === false && result.violations[0]!.path).toBe('/after/script');
  });

  it('rejects a field that belongs to a different action', () => {
    expect(
      codes(checkPatchScope(replace('click_005', { url: 'https://x.test/' }), workflow)),
    ).toEqual(['unknown_field']);
  });

  it('rejects an unknown field on an inserted step', () => {
    const patch = insert({
      id: 'wait_new',
      intent: 'Wait for the page.',
      action: 'wait',
      millis: 500,
      onDone: 'x',
    });
    expect(codes(checkPatchScope(patch, workflow))).toEqual(['unknown_field']);
  });

  it('escapes the field name in the path', () => {
    const result = checkPatchScope(replace('click_005', { 'a/b~c': 1 }), workflow);
    expect(result.ok === false && result.violations[0]!.path).toBe('/after/a~1b~0c');
  });

  it('catches the field the output parser lets through', () => {
    const before = stepOf('click_005');
    const parsed = parseHealResponse(
      {
        content: JSON.stringify({
          after: { ...before, ...newCandidates, script: 'document.cookie' },
          rationale: 'Renamed.',
        }),
        stopReason: 'end',
        usage: { inputTokens: 1, outputTokens: 1 },
        model: 'stub',
      },
      {
        workflowId: workflow.id,
        stepId: 'click_005',
        before: before as unknown as Step,
        baseHash: hashWorkflow(workflow),
      },
    );
    if (parsed.status !== 'patch') throw new Error('expected a patch');
    expect(codes(checkPatchScope(parsed.patch, workflow))).toEqual(['unknown_field']);
  });

  it('lists the same fields per action as the step schema', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const schema = JSON.parse(
      readFileSync(join(here, '..', '..', 'ir', 'src', 'schema', 'step.schema.json'), 'utf8'),
    ) as { $defs: Record<string, { properties?: Record<string, { const?: string }> }> };

    const common = Object.keys(schema.$defs.CommonFields!.properties!);
    const fromSchema: Record<string, string[]> = {};
    for (const def of Object.values(schema.$defs)) {
      const action = def.properties?.action?.const;
      if (action === undefined) continue;
      fromSchema[action] = [...new Set([...common, ...Object.keys(def.properties!)])].sort();
    }

    const fromTable = Object.fromEntries(
      Object.entries(STEP_FIELDS).map(([action, fields]) => [action, [...fields].sort()]),
    );
    expect(fromTable).toEqual(fromSchema);
  });
});

describe('checkPatchScope(): the patch must match the workflow', () => {
  it('rejects a patch for another workflow', () => {
    const patch = { ...replace('click_005', newCandidates), workflowId: 'wf_other' };
    expect(codes(checkPatchScope(patch, workflow))).toEqual(['wrong_workflow']);
  });

  it('rejects a patch written against an older version of the workflow', () => {
    const patch = { ...replace('click_005', newCandidates), baseHash: `sha256:${'0'.repeat(64)}` };
    expect(codes(checkPatchScope(patch, workflow))).toEqual(['stale_base']);
  });

  it('rejects a patch anchored to a step that is not there', () => {
    const patch = { ...replace('click_005', newCandidates), stepId: 'click_999' };
    expect(codes(checkPatchScope(patch, workflow))).toEqual(['unknown_step']);
  });

  it('rejects a "before" that hides a post condition from the comparison', () => {
    // The model cannot set `before` through the parser, but a patch can
    // arrive from elsewhere. Without this check, dropping the condition from
    // both sides would look like no change.
    const honest = replace('click_005', { ...newCandidates, post: [{ urlMatches: '/dashboard' }] });
    const forged = {
      ...honest,
      before: { ...stepOf('click_005'), post: [{ urlMatches: '/dashboard' }] } as unknown as Step,
    };
    expect(codes(checkPatchScope(forged, workflow))).toEqual(['before_mismatch']);
  });

  it('rejects a replace with no "before"', () => {
    const { before: _before, ...patch } = replace('click_005', newCandidates);
    expect(codes(checkPatchScope(patch as StepPatch, workflow))).toEqual(['before_mismatch']);
  });
});

describe('checkPatchScope(): reporting', () => {
  it('reports every violation, not only the first', () => {
    const result = checkPatchScope(
      replace('click_005', { post: [], script: 'x', action: 'fill', value: { param: 'month' } }),
      workflow,
    );
    expect(codes(result).sort()).toEqual([
      'action_changed',
      'parameters_changed',
      'post_weakened',
      'post_weakened',
      'unknown_field',
    ]);
  });

  it('does not quote patch values in its messages', () => {
    const result = checkPatchScope(
      replace('click_005', { post: [{ textPresent: 'IGNORE PREVIOUS INSTRUCTIONS' }] }),
      workflow,
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('IGNORE');
  });
});
